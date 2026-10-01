import {
  timeframeMs,
  type Bar,
  type HistoryPage,
  type Instrument,
  type SessionInterval,
  type SessionMode,
  type Timeframe,
} from '@omc/provider-sdk';
import {
  aggregateSessionBars,
  newYorkDate,
  newYorkTimestamp,
  sessionBucket,
  utcBucket,
} from '@omc/data-engine';
import type { GatewayConfig } from './config';

interface RawBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function normalizeBar(raw: RawBar, revision = Date.now()): Bar {
  return {
    time: Date.parse(raw.t),
    open: raw.o,
    high: raw.h,
    low: raw.l,
    close: raw.c,
    volume: raw.v,
    revision,
    closed: Date.parse(raw.t) + 60_000 <= Date.now(),
  };
}
export class AlpacaClient {
  private cache = new Map<string, { expires: number; data: unknown }>();
  private pending = new Map<string, Promise<unknown>>();
  private nextRequestAt = 0;
  constructor(
    private config: GatewayConfig,
    private fetcher: typeof fetch = fetch,
  ) {}
  get configured(): boolean {
    return !!this.config.key && !!this.config.secret;
  }
  private async request<T>(origin: 'trading' | 'data', path: string, ttl = 5000): Promise<T> {
    if (!this.configured)
      throw new UpstreamError(
        503,
        'Alpaca is not configured. Set server-side ALPACA_API_KEY and ALPACA_API_SECRET.',
      );
    const key = `${origin}${path}`,
      cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.data as T;
    if (this.pending.has(key)) return this.pending.get(key) as Promise<T>;
    const task = (async () => {
      const delay = Math.max(0, this.nextRequestAt - Date.now());
      this.nextRequestAt = Date.now() + delay + 350;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const response = await this.fetcher(
        `${origin === 'trading' ? this.config.tradingUrl : this.config.dataUrl}${path}`,
        {
          headers: {
            'APCA-API-KEY-ID': this.config.key!,
            'APCA-API-SECRET-KEY': this.config.secret!,
          },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok)
        throw new UpstreamError(
          response.status,
          response.status === 401 || response.status === 403
            ? 'Alpaca rejected the credentials or market-data entitlement. The gateway uses the IEX feed.'
            : `Alpaca request failed (${response.status}).`,
        );
      const data = await response.json();
      this.cache.set(key, { expires: Date.now() + ttl, data });
      if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
      return data as T;
    })();
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
  async symbols(query: string): Promise<Instrument[]> {
    const assets = await this.request<
      { symbol: string; name: string; exchange: string; status: string }[]
    >('trading', '/v2/assets?status=active&asset_class=us_equity', 3_600_000);
    const q = query.toUpperCase();
    return assets
      .filter((a) => a.status === 'active' && `${a.symbol} ${a.name}`.toUpperCase().includes(q))
      .sort(
        (a, b) =>
          Number(b.symbol === q) - Number(a.symbol === q) || a.symbol.localeCompare(b.symbol),
      )
      .slice(0, 60)
      .map((a) => ({
        id: `alpaca:${a.symbol}`,
        symbol: a.symbol,
        name: a.name,
        provider: 'alpaca',
        assetClass: /\bETF\b|Trust/i.test(a.name) ? 'etf' : 'stock',
        currency: 'USD',
        timezone: 'America/New_York',
        pricePrecision: 2,
        volumeUnit: 'shares',
        session: 'us-equities',
      }));
  }
  async calendar(from: number, to: number): Promise<SessionInterval[]> {
    const params = new URLSearchParams({ start: newYorkDate(from), end: newYorkDate(to) });
    const rows = await this.request<{ date: string; open: string; close: string }[]>(
      'trading',
      `/v2/calendar?${params}`,
      3_600_000,
    );
    return rows.map((row) => ({
      date: row.date,
      open: newYorkTimestamp(row.date, row.open),
      close: newYorkTimestamp(row.date, row.close),
      extendedOpen: newYorkTimestamp(row.date, '04:00'),
      extendedClose: newYorkTimestamp(row.date, '20:00'),
    }));
  }
  async minutes(symbol: string, from: number, to: number, session: SessionMode): Promise<Bar[]> {
    if (from >= to) return [];
    const revision = Date.now(),
      calendar = await this.calendar(from - 7 * 86_400_000, to);
    const params = new URLSearchParams({
      timeframe: '1Min',
      start: new Date(from).toISOString(),
      end: new Date(to - 1).toISOString(),
      feed: 'iex',
      adjustment: 'raw',
      limit: '10000',
      sort: 'asc',
    });
    const all: Bar[] = [];
    for (let page = 0; page < 30; page++) {
      const result = await this.request<{ bars: RawBar[] | null; next_page_token?: string | null }>(
        'data',
        `/v2/stocks/${encodeURIComponent(symbol)}/bars?${params}`,
      );
      for (const row of result.bars ?? []) {
        const bar = normalizeBar(row, revision);
        if (
          bar.time >= from &&
          bar.time < to &&
          sessionBucket(bar.time, '1m', calendar, session) !== undefined
        )
          all.push(bar);
      }
      if (!result.next_page_token) return all;
      params.set('page_token', result.next_page_token);
    }
    throw new UpstreamError(
      422,
      'History range exceeds the bounded page limit. Request a shorter interval.',
    );
  }
  async history(
    symbol: string,
    timeframe: Timeframe,
    session: SessionMode,
    before: number | undefined,
    requestedLimit: number,
  ): Promise<HistoryPage> {
    const end = Math.min(before ?? Date.now() + 1, Date.now() + 1);
    const days = ({ '1m': 7, '5m': 14, '15m': 30, '1h': 45, '1D': 45, '1W': 90 } as const)[
      timeframe
    ];
    let start = newYorkTimestamp(newYorkDate(end - days * 86_400_000), '00:00');
    if (timeframe === '1W')
      start = newYorkTimestamp(
        new Date(utcBucket(Date.parse(`${newYorkDate(start)}T12:00:00Z`), '1W'))
          .toISOString()
          .slice(0, 10),
        '00:00',
      );
    const calendarThrough = end + 7 * 86_400_000;
    const calendar = await this.calendar(start - 7 * 86_400_000, calendarThrough);
    const minutes = await this.minutes(symbol, start, end, session);
    const bars = aggregateSessionBars(
      minutes,
      timeframe,
      calendar,
      session,
      Math.min(end, Date.now()),
      calendarThrough,
    )
      .filter((b) => b.time < end)
      .slice(-Math.max(1, Math.min(requestedLimit, 2000)));
    const boundary = bars[0]?.time ?? start;
    return { bars, nextBefore: boundary, hasMore: boundary > Date.UTC(2016, 0, 1) };
  }
}
