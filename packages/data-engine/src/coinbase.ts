import {
  TIMEFRAMES,
  timeframeMs,
  type Bar,
  type HistoryPage,
  type HistoryRequest,
  type Instrument,
  type MarketDataProvider,
  type StreamCallbacks,
  type SubscriptionRequest,
  type Trade,
} from '@omc/provider-sdk';
import { TradeBarAggregator } from './aggregation';
import { aggregateBars, utcBucket } from './sessions';
import { errorMessage, fetchJson, wait, type FetchLike, type WebSocketFactory } from './transport';

export const COINBASE_INSTRUMENTS: Instrument[] = [
  {
    id: 'coinbase:BTC-USD',
    symbol: 'BTC-USD',
    name: 'Bitcoin / US Dollar',
    provider: 'coinbase',
    assetClass: 'crypto',
    currency: 'USD',
    timezone: 'UTC',
    pricePrecision: 2,
    volumeUnit: 'BTC',
    session: '24x7',
  },
  {
    id: 'coinbase:ETH-USD',
    symbol: 'ETH-USD',
    name: 'Ethereum / US Dollar',
    provider: 'coinbase',
    assetClass: 'crypto',
    currency: 'USD',
    timezone: 'UTC',
    pricePrecision: 2,
    volumeUnit: 'ETH',
    session: '24x7',
  },
  {
    id: 'coinbase:SOL-USD',
    symbol: 'SOL-USD',
    name: 'Solana / US Dollar',
    provider: 'coinbase',
    assetClass: 'crypto',
    currency: 'USD',
    timezone: 'UTC',
    pricePrecision: 2,
    volumeUnit: 'SOL',
    session: '24x7',
  },
];
interface Product {
  id: string;
  base_currency: string;
  quote_currency: string;
  quote_increment: string;
  status: string;
  display_name: string;
}
interface RawTrade {
  trade_id: number;
  time: string;
  price: string;
  size: string;
}
interface CoinbaseOptions {
  fetch?: FetchLike;
  websocketFactory?: WebSocketFactory;
  restUrl?: string;
  websocketUrl?: string;
}

export class CoinbaseProvider implements MarketDataProvider {
  readonly id = 'coinbase';
  readonly capabilities = {
    timeframes: TIMEFRAMES,
    realtime: true,
    trades: true,
    quotes: true,
    extendedHours: false,
    label: 'Coinbase · live exchange data',
    delayMinutes: 0,
  };
  private fetcher: FetchLike;
  private sockets: WebSocketFactory;
  private rest: string;
  private ws: string;
  private subscriptions = new Set<() => void>();
  private products?: Product[];
  private nextRequestAt = 0;
  constructor(options: CoinbaseOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.sockets = options.websocketFactory ?? ((url) => new WebSocket(url));
    this.rest = options.restUrl ?? 'https://api.exchange.coinbase.com';
    this.ws = options.websocketUrl ?? 'wss://ws-feed.exchange.coinbase.com';
  }
  private async json<T>(path: string, signal?: AbortSignal): Promise<T> {
    const delay = Math.max(0, this.nextRequestAt - Date.now());
    this.nextRequestAt = Date.now() + delay + 150;
    if (delay) await wait(delay, signal);
    return fetchJson<T>(`${this.rest}${path}`, { signal }, this.fetcher);
  }
  async searchSymbols(query: string, signal?: AbortSignal): Promise<Instrument[]> {
    if (!this.products) this.products = await this.json<Product[]>('/products', signal);
    const search = query.trim().toUpperCase();
    return this.products
      .filter(
        (p) => p.status === 'online' && `${p.id} ${p.display_name}`.toUpperCase().includes(search),
      )
      .sort(
        (a, b) =>
          Number(b.quote_currency === 'USD') - Number(a.quote_currency === 'USD') ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 60)
      .map((p) => ({
        id: `coinbase:${p.id}`,
        symbol: p.id,
        name: p.display_name,
        provider: this.id,
        assetClass: 'crypto',
        currency: p.quote_currency,
        timezone: 'UTC',
        pricePrecision: Math.max(0, Math.ceil(-Math.log10(Number(p.quote_increment)))),
        volumeUnit: p.base_currency,
        session: '24x7',
      }));
  }
  private async candles(
    symbol: string,
    seconds: number,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Bar[]> {
    if (end <= start) return [];
    const revision = Date.now();
    const params = new URLSearchParams({
      granularity: String(seconds),
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    });
    const rows = await this.json<number[][]>(
      `/products/${encodeURIComponent(symbol)}/candles?${params}`,
      signal,
    );
    return rows
      .map(([time, low, high, open, close, volume]) => ({
        time: time * 1000,
        low,
        high,
        open,
        close,
        volume,
        revision,
        closed: time * 1000 + seconds * 1000 <= Date.now(),
      }))
      .filter((b) => b.time >= start && b.time < end)
      .sort((a, b) => a.time - b.time);
  }
  async getHistory(request: HistoryRequest): Promise<HistoryPage> {
    const width = timeframeMs[request.timeframe];
    const seconds = request.timeframe === '1W' ? 86400 : width / 1000;
    const nativeWidth = seconds * 1000;
    const limit = Math.max(
      1,
      Math.min(Math.floor(request.limit), request.timeframe === '1W' ? 40 : 2000),
    );
    const end = request.before ?? utcBucket(Date.now(), request.timeframe) + width;
    const start =
      request.timeframe === '1W' ? utcBucket(end - limit * width, '1W') : end - limit * nativeWidth;
    const all: Bar[] = [];
    for (let cursor = start; cursor < end; cursor += 299 * nativeWidth)
      all.push(
        ...(await this.candles(
          request.instrument.symbol,
          seconds,
          cursor,
          Math.min(end, cursor + 299 * nativeWidth),
          request.signal,
        )),
      );
    const unique = [...new Map(all.map((b) => [b.time, b])).values()];
    const bars = (
      request.timeframe === '1W' ? aggregateBars(unique, (time) => utcBucket(time, '1W')) : unique
    )
      .filter((b) => b.time < end)
      .slice(-limit);
    // Empty intervals can mean no trades, not the beginning of exchange history. Keep the time cursor moving.
    const lowerBound = Date.UTC(2015, 0, 1);
    return { bars, nextBefore: Math.max(start, lowerBound), hasMore: start > lowerBound };
  }
  /** Fetch disjoint completed intervals; live trades only begin after their exact boundary. */
  private async prefix(
    symbol: string,
    from: number,
    to: number,
    signal: AbortSignal,
  ): Promise<Bar[]> {
    const bars: Bar[] = [];
    let cursor = from;
    for (const seconds of [86400, 3600, 900, 300, 60]) {
      const width = seconds * 1000;
      const end = Math.floor(to / width) * width;
      if (cursor < end && cursor % width === 0) {
        bars.push(...(await this.candles(symbol, seconds, cursor, end, signal)));
        cursor = end;
      }
    }
    return bars;
  }
  private async recentTrades(symbol: string, since: number, signal: AbortSignal): Promise<Trade[]> {
    const result: Trade[] = [];
    let after: number | undefined;
    for (let page = 0; page < 50; page++) {
      const params = new URLSearchParams({ limit: '1000' });
      if (after !== undefined) params.set('after', String(after));
      const rows = await this.json<RawTrade[]>(
        `/products/${encodeURIComponent(symbol)}/trades?${params}`,
        signal,
      );
      if (!rows.length) return result;
      for (const row of rows) {
        const time = Date.parse(row.time);
        if (time >= since)
          result.push({
            id: String(row.trade_id),
            symbol,
            time,
            price: Number(row.price),
            size: Number(row.size),
            sequence: row.trade_id,
          });
      }
      if (Date.parse(rows.at(-1)!.time) < since || rows.length < 1000) return result;
      const next = rows.at(-1)!.trade_id;
      if (next === after) break;
      after = next;
    }
    throw new Error(
      'Trade recovery exceeded its bounded history window. Reconnect to retry; candles remain visible.',
    );
  }
  subscribe(request: SubscriptionRequest, callbacks: StreamCallbacks): () => void {
    let socket: WebSocket | undefined,
      disposed = false,
      attempts = 0,
      connected = false,
      recovering = false,
      gapScheduled = false;
    let retry: ReturnType<typeof setTimeout> | undefined,
      heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let lastMessage = Date.now(),
      lastTradeId = 0,
      cutoff = 0,
      generation = 0;
    let buffered: Trade[] = [];
    let controller = new AbortController();
    const aggregator = new TradeBarAggregator((time) => utcBucket(time, request.timeframe));
    const emit = (bar: Bar | undefined) => {
      if (bar && !disposed)
        callbacks.onBar({
          ...bar,
          revision: Date.now(),
          closed: bar.time + timeframeMs[request.timeframe] <= Date.now(),
        });
    };
    const recover = async () => {
      if (disposed || recovering) return;
      recovering = true;
      const run = ++generation;
      buffered = [];
      const minute = Math.floor(Date.now() / 60_000) * 60_000;
      try {
        const start = utcBucket(minute, request.timeframe);
        const prefix = await this.prefix(
          request.instrument.symbol,
          start,
          minute,
          controller.signal,
        );
        const trades = await this.recentTrades(
          request.instrument.symbol,
          minute,
          controller.signal,
        );
        if (disposed || run !== generation) return;
        aggregator.clear();
        aggregator.seed(aggregateBars(prefix, (time) => utcBucket(time, request.timeframe)));
        cutoff = minute;
        lastTradeId = 0;
        for (const trade of [...trades, ...buffered].sort(
          (a, b) => a.time - b.time || Number(a.id) - Number(b.id),
        )) {
          if (trade.time >= cutoff) aggregator.add(trade);
          lastTradeId = Math.max(lastTradeId, Number(trade.id));
        }
        buffered = [];
        recovering = false;
        attempts = 0;
        emit(aggregator.get(utcBucket(Date.now(), request.timeframe)));
        callbacks.onStatus('live');
      } catch (error) {
        if (disposed || controller.signal.aborted || run !== generation) return;
        recovering = false;
        callbacks.onStatus('error', errorMessage(error));
        callbacks.onGap?.();
        socket?.close();
      }
    };
    const gap = () => {
      if (disposed || recovering || gapScheduled) return;
      gapScheduled = true;
      callbacks.onStatus('reconnecting', 'Recovering missing trades');
      callbacks.onGap?.();
      setTimeout(() => {
        gapScheduled = false;
        if (!disposed && connected) void recover();
      }, 250);
    };
    const open = () => {
      if (disposed) return;
      callbacks.onStatus(attempts ? 'reconnecting' : 'connecting');
      try {
        socket = this.sockets(this.ws);
      } catch (error) {
        callbacks.onStatus('error', errorMessage(error));
        reconnect();
        return;
      }
      socket.onopen = () => {
        connected = true;
        lastMessage = Date.now();
        socket?.send(
          JSON.stringify({
            type: 'subscribe',
            product_ids: [request.instrument.symbol],
            channels: ['matches', 'heartbeat', 'ticker'],
          }),
        );
        void recover();
      };
      socket.onmessage = (event) => {
        lastMessage = Date.now();
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.type === 'error') {
          callbacks.onStatus('error', String(message.message ?? 'Exchange stream error'));
          return;
        }
        if (message.type === 'heartbeat') {
          if (!recovering && lastTradeId && Number(message.last_trade_id) > lastTradeId) gap();
          return;
        }
        if (message.type === 'ticker') {
          const bid = Number(message.best_bid),
            ask = Number(message.best_ask);
          if (Number.isFinite(bid) && Number.isFinite(ask))
            callbacks.onQuote?.({
              symbol: request.instrument.symbol,
              time: Date.parse(String(message.time)) || Date.now(),
              bid,
              ask,
              bidSize: Number(message.best_bid_size),
              askSize: Number(message.best_ask_size),
            });
          return;
        }
        if (message.type !== 'match') return;
        const trade: Trade = {
          id: String(message.trade_id),
          symbol: request.instrument.symbol,
          time: Date.parse(String(message.time)),
          price: Number(message.price),
          size: Number(message.size),
          sequence: Number(message.trade_id),
        };
        callbacks.onTrade?.(trade);
        if (recovering) {
          buffered.push(trade);
          if (buffered.length > 100_000) {
            callbacks.onStatus('error', 'Trade recovery queue overflow');
            socket?.close();
          }
          return;
        }
        const id = Number(trade.id);
        if (lastTradeId && id > lastTradeId + 1) gap();
        lastTradeId = Math.max(lastTradeId, id);
        if (trade.time < cutoff) {
          gap();
          return;
        }
        emit(aggregator.add(trade));
      };
      socket.onerror = () => callbacks.onStatus('reconnecting', 'Exchange connection interrupted');
      socket.onclose = () => {
        connected = false;
        generation++;
        controller.abort();
        controller = new AbortController();
        recovering = false;
        if (!disposed) {
          callbacks.onGap?.();
          reconnect();
        }
      };
    };
    const reconnect = () => {
      if (disposed) return;
      attempts++;
      callbacks.onStatus('reconnecting', 'Waiting to reconnect to Coinbase');
      if (retry) clearTimeout(retry);
      retry = setTimeout(
        open,
        Math.min(30_000, 500 * 2 ** Math.min(attempts, 6)) + Math.random() * 250,
      );
    };
    heartbeatTimer = setInterval(() => {
      if (connected && Date.now() - lastMessage > 15_000) socket?.close();
    }, 5_000);
    const stop = () => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      if (retry) clearTimeout(retry);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      socket?.close();
      this.subscriptions.delete(stop);
    };
    this.subscriptions.add(stop);
    open();
    return stop;
  }
  dispose(): void {
    for (const stop of [...this.subscriptions]) stop();
  }
}
