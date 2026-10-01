import {
  TIMEFRAMES,
  timeframeMs,
  type Bar,
  type HistoryPage,
  type HistoryRequest,
  type Instrument,
  type MarketDataProvider,
  type SessionInterval,
  type StreamCallbacks,
  type SubscriptionRequest,
  type Trade,
} from '@omc/provider-sdk';
import { BarStore } from './store';
import { aggregateSessionBars, sessionBucket } from './sessions';
import { errorMessage, fetchJson, type FetchLike, type WebSocketFactory } from './transport';

export const ALPACA_INSTRUMENTS: Instrument[] = [
  ['SPY', 'SPDR S&P 500 ETF', 'etf'],
  ['AAPL', 'Apple', 'stock'],
  ['MSFT', 'Microsoft', 'stock'],
  ['NVDA', 'NVIDIA', 'stock'],
  ['QQQ', 'Invesco QQQ Trust', 'etf'],
].map(([symbol, name, assetClass]) => ({
  id: `alpaca:${symbol}`,
  symbol,
  name,
  provider: 'alpaca',
  assetClass: assetClass as 'stock' | 'etf',
  currency: 'USD',
  timezone: 'America/New_York',
  pricePrecision: 2,
  volumeUnit: 'shares',
  session: 'us-equities',
}));
export interface AlpacaOptions {
  baseUrl: string;
  token?: string;
  fetch?: FetchLike;
  websocketFactory?: WebSocketFactory;
}
export class AlpacaProvider implements MarketDataProvider {
  readonly id = 'alpaca';
  readonly capabilities = {
    timeframes: TIMEFRAMES,
    realtime: true,
    trades: true,
    quotes: true,
    extendedHours: true,
    label: 'Alpaca · IEX exchange data',
    delayMinutes: 0,
  };
  private fetcher: FetchLike;
  private sockets: WebSocketFactory;
  private stops = new Set<() => void>();
  private base: string;
  private calendar = new Map<string, SessionInterval>();
  constructor(private options: AlpacaOptions) {
    this.base = options.baseUrl.replace(/\/$/, '');
    this.fetcher = options.fetch ?? fetch;
    this.sockets = options.websocketFactory ?? ((url) => new WebSocket(url));
  }
  private json<T>(path: string, signal?: AbortSignal): Promise<T> {
    return fetchJson<T>(
      `${this.base}${path}`,
      {
        signal,
        headers: this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {},
      },
      this.fetcher,
    );
  }
  async searchSymbols(query: string, signal?: AbortSignal): Promise<Instrument[]> {
    return this.json(`/api/symbols?q=${encodeURIComponent(query)}`, signal);
  }
  getCachedSessions(): SessionInterval[] {
    return [...this.calendar.values()].sort((a, b) => a.open - b.open);
  }
  async getSessions(from: number, to: number, signal?: AbortSignal): Promise<SessionInterval[]> {
    const result = new Map<string, SessionInterval>();
    for (let start = from; start <= to; start += 365 * 86_400_000) {
      const rows = await this.json<SessionInterval[]>(
        `/api/calendar?from=${start}&to=${Math.min(to, start + 365 * 86_400_000)}`,
        signal,
      );
      for (const row of rows) {
        this.calendar.set(row.date, row);
        result.set(row.date, row);
      }
    }
    return [...result.values()].sort((a, b) => a.open - b.open);
  }
  async getHistory(request: HistoryRequest): Promise<HistoryPage> {
    const params = new URLSearchParams({
      symbol: request.instrument.symbol,
      timeframe: request.timeframe,
      session: request.session,
      limit: String(request.limit),
    });
    if (request.before !== undefined) params.set('before', String(request.before));
    const page = await this.json<HistoryPage>(`/api/bars?${params}`, request.signal);
    if (page.bars.length)
      await this.getSessions(
        page.bars[0].time - 7 * 86_400_000,
        page.bars.at(-1)!.time + 86_400_000,
        request.signal,
      );
    return page;
  }
  subscribe(request: SubscriptionRequest, callbacks: StreamCallbacks): () => void {
    let disposed = false,
      socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      attempts = 0,
      ready = false,
      run = 0;
    let buffer: Bar[] = [],
      sessions: SessionInterval[] = [],
      lastMessage = Date.now(),
      initializedFrom = Infinity,
      calendarThrough = -Infinity;
    let controller = new AbortController();
    const minutes = new BarStore();
    const emit = (bar: Bar) => {
      minutes.update(bar);
      const bucket = sessionBucket(bar.time, request.timeframe, sessions, request.session);
      if (bucket === undefined) return;
      // Native minute bars are complete replacements; older aggregate corrections need a full prefix.
      if (bucket < initializedFrom && request.timeframe !== '1m') {
        callbacks.onGap?.();
        return;
      }
      const aggregate = aggregateSessionBars(
        minutes.bars.filter(
          (b) => sessionBucket(b.time, request.timeframe, sessions, request.session) === bucket,
        ),
        request.timeframe,
        sessions,
        request.session,
        Math.max(Date.now(), bar.closed === true ? bar.time + timeframeMs['1m'] : -Infinity),
        calendarThrough,
      )[0];
      if (aggregate && !disposed) callbacks.onBar({ ...aggregate, revision: Date.now() });
    };
    const bootstrap = async () => {
      const generation = ++run;
      ready = false;
      buffer = [];
      try {
        const now = Date.now();
        const calendar = await this.getSessions(
          now - 10 * 86400_000,
          now + 7 * 86400_000,
          controller.signal,
        );
        if (disposed || generation !== run) return;
        sessions = calendar;
        calendarThrough = now + 7 * 86400_000;
        const lastSession = sessions
          .filter((s) => (request.session === 'regular' ? s.open : s.extendedOpen) <= now)
          .at(-1);
        const lastSessionEnd =
          lastSession &&
          (request.session === 'regular' ? lastSession.close : lastSession.extendedClose);
        const anchor = lastSessionEnd === undefined ? now : Math.min(now, lastSessionEnd - 1);
        const bucket = sessionBucket(anchor, request.timeframe, sessions, request.session);
        initializedFrom = bucket ?? Infinity;
        if (bucket !== undefined) {
          const params = new URLSearchParams({
            symbol: request.instrument.symbol,
            from: String(bucket),
            to: String(now),
            session: request.session,
          });
          const prefix = await this.json<Bar[]>(`/api/minutes?${params}`, controller.signal);
          if (disposed || generation !== run) return;
          minutes.reset(prefix);
        } else minutes.reset([]);
        for (const bar of buffer) emit(bar);
        buffer = [];
        ready = true;
        attempts = 0;
        callbacks.onStatus('live', 'IEX candles update each minute; quotes stream live');
      } catch (error) {
        if (!disposed && !controller.signal.aborted && generation === run) {
          callbacks.onStatus('error', errorMessage(error));
          socket?.close();
        }
      }
    };
    const open = () => {
      if (disposed) return;
      callbacks.onStatus(attempts ? 'reconnecting' : 'connecting');
      try {
        socket = this.sockets(`${this.base.replace(/^http/, 'ws')}/stream`);
      } catch (error) {
        callbacks.onStatus('error', errorMessage(error));
        reconnect();
        return;
      }
      socket.onopen = () => {
        lastMessage = Date.now();
        socket?.send(
          JSON.stringify({
            type: 'subscribe',
            token: this.options.token,
            symbol: request.instrument.symbol,
          }),
        );
      };
      socket.onmessage = (event) => {
        lastMessage = Date.now();
        let message: { type: string; data?: unknown; message?: string };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.type === 'ready') {
          void bootstrap();
          return;
        }
        if (message.type === 'offline') {
          ready = false;
          run++;
          callbacks.onStatus('reconnecting', message.message);
          callbacks.onGap?.();
          return;
        }
        if (message.type === 'error') {
          callbacks.onStatus('error', message.message ?? 'Stock data connection failed');
          return;
        }
        if (message.type === 'gap') {
          callbacks.onGap?.();
          callbacks.onStatus('reconnecting');
          void bootstrap();
          return;
        }
        if (message.type === 'trade') callbacks.onTrade?.(message.data as Trade);
        else if (message.type === 'quote')
          callbacks.onQuote?.(
            message.data as Parameters<NonNullable<StreamCallbacks['onQuote']>>[0],
          );
        else if (message.type === 'bar') {
          const bar = message.data as Bar;
          if (!ready) {
            buffer.push(bar);
            return;
          }
          emit(bar);
        }
      };
      socket.onerror = () =>
        callbacks.onStatus('reconnecting', 'Stock data connection interrupted');
      socket.onclose = () => {
        ready = false;
        run++;
        controller.abort();
        controller = new AbortController();
        if (!disposed) {
          callbacks.onGap?.();
          reconnect();
        }
      };
    };
    const reconnect = () => {
      if (disposed) return;
      attempts++;
      callbacks.onStatus('reconnecting');
      if (timer) clearTimeout(timer);
      timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5)));
    };
    const heartbeat = setInterval(() => {
      if (socket?.readyState === 1 && Date.now() - lastMessage > 40_000) socket.close();
    }, 10_000);
    // Refresh calendars across holidays and DST in long-running browser sessions.
    const refresh = setInterval(() => {
      if (ready) void bootstrap();
    }, 6 * 3_600_000);
    const stop = () => {
      disposed = true;
      controller.abort();
      clearInterval(heartbeat);
      clearInterval(refresh);
      if (timer) clearTimeout(timer);
      socket?.close();
      this.stops.delete(stop);
    };
    this.stops.add(stop);
    open();
    return stop;
  }
  dispose(): void {
    for (const stop of [...this.stops]) stop();
  }
}
