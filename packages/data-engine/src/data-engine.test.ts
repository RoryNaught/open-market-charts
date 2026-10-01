import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bar, SessionInterval, Trade } from '@omc/provider-sdk';
import {
  aggregateBars,
  aggregateSessionBars,
  AlpacaProvider,
  ALPACA_INSTRUMENTS,
  BarStore,
  CoinbaseProvider,
  COINBASE_INSTRUMENTS,
  createBarBatcher,
  generateBars,
  isInSession,
  newYorkTimestamp,
  sessionBucket,
  sessionBucketEnd,
  TradeBarAggregator,
  utcBucket,
} from './index';
import { fetchJson } from './transport';

const bar = (time: number, close = 10, revision = 1): Bar => ({
  time,
  open: 10,
  high: Math.max(12, close),
  low: Math.min(8, close),
  close,
  volume: 4,
  revision,
});
afterEach(() => vi.useRealTimers());

describe('BarStore', () => {
  it('sorts and deduplicates history and rejects stale candle revisions', () => {
    const store = new BarStore();
    store.reset([bar(2), bar(1), bar(2, 15, 4), bar(2, 11, 2)]);
    expect(store.bars.map((b) => b.time)).toEqual([1, 2]);
    expect(store.last?.close).toBe(15);
    expect(store.update(bar(2, 8, 3))).toBe(false);
    expect(store.merge([bar(0), bar(1, 9, 2), bar(3)])).toEqual({ added: 2, updated: 1 });
    expect(store.bars.map((b) => b.time)).toEqual([0, 1, 2, 3]);
    expect(store.bars[1].close).toBe(9);
  });
  it('rejects invalid OHLCV and never mutates caller data', () => {
    const store = new BarStore(),
      input = bar(1);
    store.reset([input, { ...bar(2), volume: -1 }, { ...bar(3), high: 1 }]);
    input.close = 99;
    expect(store.length).toBe(1);
    expect(store.first?.close).toBe(10);
  });
  it('preserves the history array during live tail updates', () => {
    const store = new BarStore();
    store.reset(generateBars(100_000));
    const reference = store.bars;
    const last = store.last!;
    store.merge([{ ...last, close: last.open, revision: 2 }]);
    expect(store.bars).toBe(reference);
    expect(store.length).toBe(100_000);
  });
});

describe('trade aggregation', () => {
  const trade = (id: string, time: number, price: number, size = 1): Trade => ({
    id,
    symbol: 'BTC-USD',
    time,
    price,
    size,
  });
  it('deduplicates replay and uses event order for OHLC, including out-of-order trades', () => {
    const aggregate = new TradeBarAggregator((t) => Math.floor(t / 60_000) * 60_000);
    aggregate.add(trade('3', 20_000, 12, 2));
    aggregate.add(trade('1', 1000, 10, 1));
    aggregate.add(trade('2', 10_000, 8, 3));
    expect(aggregate.add(trade('2', 10_000, 8, 3))).toBeUndefined();
    expect(aggregate.get(0)).toMatchObject({ open: 10, high: 12, low: 8, close: 12, volume: 6 });
    expect(aggregate.add(trade('4', 60_000, 13))).toMatchObject({
      time: 60_000,
      open: 13,
      volume: 1,
    });
  });
  it('adds a disjoint historical prefix exactly once', () => {
    const aggregate = new TradeBarAggregator(() => 0);
    aggregate.seed([{ ...bar(0), volume: 100 }]);
    aggregate.add(trade('1', 60_000, 15, 2));
    aggregate.add(trade('1', 60_000, 15, 2));
    expect(aggregate.get(0)).toMatchObject({ open: 10, close: 15, high: 15, low: 8, volume: 102 });
  });
  it('coalesces bars after ingestion while retaining separate candle boundaries', () => {
    const frames: (() => void)[] = [],
      received: Bar[][] = [];
    const batcher = createBarBatcher(
      (bars) => received.push(bars),
      (fn) => frames.push(fn),
    );
    batcher.push(bar(0));
    batcher.push(bar(0, 11));
    batcher.push(bar(60_000));
    expect(frames).toHaveLength(1);
    frames[0]();
    expect(received[0].map((b) => b.close)).toEqual([11, 10]);
    batcher.push(bar(120_000));
    batcher.dispose();
    frames[1]();
    expect(received).toHaveLength(1);
  });
});

describe('market calendar', () => {
  const session = (date: string, close = '16:00'): SessionInterval => ({
    date,
    open: newYorkTimestamp(date, '09:30'),
    close: newYorkTimestamp(date, close),
    extendedOpen: newYorkTimestamp(date, '04:00'),
    extendedClose: newYorkTimestamp(date, '20:00'),
  });
  it('resolves New York DST without hard-coded offsets', () => {
    expect(newYorkTimestamp('2024-03-08', '09:30')).toBe(Date.parse('2024-03-08T14:30:00Z'));
    expect(newYorkTimestamp('2024-03-11', '09:30')).toBe(Date.parse('2024-03-11T13:30:00Z'));
    expect(newYorkTimestamp('2024-03-10', '04:00')).toBe(Date.parse('2024-03-10T08:00:00Z'));
  });
  it('obeys holiday absence, early closes, and regular versus extended sessions', () => {
    const calendar = [session('2024-11-27'), session('2024-11-29', '13:00')];
    expect(isInSession(newYorkTimestamp('2024-11-28', '10:00'), calendar, 'regular')).toBe(false);
    const afterClose = newYorkTimestamp('2024-11-29', '14:00');
    expect(isInSession(afterClose, calendar, 'regular')).toBe(false);
    expect(isInSession(afterClose, calendar, 'extended')).toBe(true);
    expect(sessionBucket(newYorkTimestamp('2024-11-29', '10:15'), '1h', calendar, 'regular')).toBe(
      calendar[1].open,
    );
  });
  it('uses Monday UTC for crypto weeks and the first available session for stock weeks', () => {
    expect(utcBucket(Date.parse('2024-01-07T20:00:00Z'), '1W')).toBe(
      Date.parse('2024-01-01T00:00:00Z'),
    );
    const calendar = [session('2024-01-02'), session('2024-01-03')];
    expect(sessionBucket(newYorkTimestamp('2024-01-03', '12:00'), '1W', calendar, 'regular')).toBe(
      calendar[0].open,
    );
    expect(aggregateBars([bar(1000), bar(3000, 20)], () => 0)[0]).toMatchObject({
      open: 10,
      close: 20,
      volume: 8,
      high: 20,
    });
  });
  it('closes 1m, 5m and shortened final hourly buckets only at their actual end', () => {
    const calendar = [session('2024-11-29', '13:00')];
    const minute = (clock: string) => ({
      ...bar(newYorkTimestamp('2024-11-29', clock)),
      closed: true,
    });
    const at = (clock: string) => newYorkTimestamp('2024-11-29', clock);
    expect(
      aggregateSessionBars([minute('09:30')], '1m', calendar, 'regular', at('09:31'))[0].closed,
    ).toBe(true);
    expect(
      aggregateSessionBars(
        [{ ...minute('09:30'), closed: false }],
        '1m',
        calendar,
        'regular',
        at('09:31'),
      )[0].closed,
    ).toBe(false);
    expect(
      aggregateSessionBars(
        [minute('09:30'), minute('09:31')],
        '5m',
        calendar,
        'regular',
        at('09:32'),
      )[0].closed,
    ).toBe(false);
    expect(
      aggregateSessionBars(
        [minute('09:30'), minute('09:34')],
        '5m',
        calendar,
        'regular',
        at('09:35'),
      )[0].closed,
    ).toBe(true);
    expect(sessionBucketEnd(at('12:30'), '1h', calendar, 'regular')).toBe(at('13:00'));
    expect(
      aggregateSessionBars(
        [minute('12:30'), minute('12:58')],
        '1h',
        calendar,
        'regular',
        at('12:59'),
      )[0].closed,
    ).toBe(false);
    expect(
      aggregateSessionBars(
        [minute('12:30'), minute('12:59')],
        '1h',
        calendar,
        'regular',
        at('13:00'),
      )[0].closed,
    ).toBe(true);
  });
  it('closes daily and weekly candles against full holiday/half-day calendars, including extended hours', () => {
    const calendar = [session('2024-11-27'), session('2024-11-29', '13:00')];
    const minute = (date: string, clock: string) => ({
      ...bar(newYorkTimestamp(date, clock)),
      closed: true,
    });
    const through = Date.parse('2024-12-02T12:00:00Z');
    const wednesday = minute('2024-11-27', '15:59');
    const friday = minute('2024-11-29', '12:59');
    expect(
      aggregateSessionBars(
        [minute('2024-11-29', '10:00')],
        '1D',
        calendar,
        'regular',
        newYorkTimestamp('2024-11-29', '10:01'),
      )[0].closed,
    ).toBe(false);
    expect(
      aggregateSessionBars([friday], '1D', calendar, 'regular', friday.time + 60_000)[0].closed,
    ).toBe(true);
    expect(
      aggregateSessionBars([friday], '1D', calendar, 'extended', friday.time + 60_000)[0].closed,
    ).toBe(false);
    expect(
      aggregateSessionBars(
        [wednesday],
        '1W',
        calendar,
        'regular',
        wednesday.time + 60_000,
        through,
      )[0].closed,
    ).toBe(false);
    expect(
      aggregateSessionBars(
        [wednesday, friday],
        '1W',
        calendar,
        'regular',
        friday.time + 60_000,
        through,
      )[0].closed,
    ).toBe(true);
    expect(
      aggregateSessionBars(
        [wednesday, friday],
        '1W',
        calendar,
        'regular',
        friday.time + 60_000,
        friday.time,
      )[0].closed,
    ).toBe(false);
    expect(sessionBucketEnd(friday.time, '1W', calendar, 'regular')).toBeUndefined();
    expect(sessionBucketEnd(friday.time, '1W', calendar, 'extended', through)).toBe(
      calendar[1].extendedClose,
    );
  });
});

describe('deterministic fixtures', () => {
  it('generates identical candles regardless of how history is paginated', () => {
    const start = Date.UTC(2024, 0, 1),
      whole = generateBars(100, { start, seed: 23 });
    const chunk = generateBars(25, { start: start + 50 * 60_000, seed: 23 });
    expect(chunk).toEqual(whole.slice(50, 75));
  });
});

class MockSocket {
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (e: { data: string }) => void;
  readyState = 1;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
describe('Coinbase adapter', () => {
  it('normalizes, sorts, and excludes the right boundary of historical pages', async () => {
    const start = Date.UTC(2024, 0, 1);
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            [start / 1000 + 120, 8, 12, 10, 11, 3],
            [start / 1000 + 60, 8, 12, 10, 11, 2],
            [start / 1000, 8, 12, 10, 11, 1],
          ]),
        ),
    );
    const provider = new CoinbaseProvider({ fetch: fetcher });
    const result = await provider.getHistory({
      instrument: COINBASE_INSTRUMENTS[0],
      timeframe: '1m',
      session: 'regular',
      before: start + 120_000,
      limit: 2,
    });
    expect(result.bars.map((b) => b.time)).toEqual([start, start + 60_000]);
    expect(result.bars.map((b) => b.volume)).toEqual([1, 2]);
    expect(result.nextBefore).toBe(start);
    expect(String(fetcher.mock.calls[0])).not.toContain('Authorization');
  });
  it('merges snapshot trades with buffered live trades exactly once and detects gaps', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2024-01-03T12:00:30Z');
    vi.setSystemTime(now);
    const socket = new MockSocket(),
      bars: Bar[] = [],
      gaps = vi.fn(),
      statuses: string[] = [];
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { trade_id: 10, time: new Date(now - 1000).toISOString(), price: '100', size: '2' },
          ]),
        ),
    );
    const provider = new CoinbaseProvider({
      fetch: fetcher,
      websocketFactory: () => socket as unknown as WebSocket,
    });
    const stop = provider.subscribe(
      { instrument: COINBASE_INSTRUMENTS[0], timeframe: '1m', session: 'regular' },
      { onBar: (b) => bars.push(b), onStatus: (s) => statuses.push(s), onGap: gaps },
    );
    socket.onopen?.();
    socket.message({
      type: 'match',
      trade_id: 10,
      time: new Date(now - 1000).toISOString(),
      price: '100',
      size: '2',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toContain('live');
    expect(bars.at(-1)?.volume).toBe(2);
    socket.message({
      type: 'match',
      trade_id: 11,
      time: new Date(now).toISOString(),
      price: '105',
      size: '3',
    });
    expect(bars.at(-1)).toMatchObject({ open: 100, close: 105, volume: 5 });
    socket.message({ type: 'heartbeat', last_trade_id: 13 });
    expect(gaps).toHaveBeenCalledOnce();
    stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.readyState).toBe(3);
  });
  it('surfaces HTTP entitlement failures rather than supplying synthetic candles', async () => {
    const provider = new CoinbaseProvider({
      fetch: async () => new Response('{}', { status: 403 }),
    });
    await expect(
      provider.getHistory({
        instrument: COINBASE_INSTRUMENTS[0],
        timeframe: '1m',
        session: 'regular',
        limit: 10,
      }),
    ).rejects.toThrow('authorization');
  });
  it('aborts paginated history and propagates the caller signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new CoinbaseProvider({
      fetch: async (_url, options) => {
        options?.signal?.throwIfAborted();
        return new Response('[]');
      },
    });
    await expect(
      provider.getHistory({
        instrument: COINBASE_INSTRUMENTS[0],
        timeframe: '1m',
        session: 'regular',
        limit: 600,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
  it('reconnects a closed stream, rebuilds candles, and cancels future retries on teardown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2024-01-03T12:00:30Z'));
    const sockets: MockSocket[] = [];
    const statuses: string[] = [];
    const provider = new CoinbaseProvider({
      fetch: async () => new Response('[]'),
      websocketFactory: () => {
        const socket = new MockSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const stop = provider.subscribe(
      { instrument: COINBASE_INSTRUMENTS[0], timeframe: '1m', session: 'regular' },
      { onBar() {}, onStatus: (status) => statuses.push(status) },
    );
    sockets[0].onopen?.();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(1500);
    expect(sockets).toHaveLength(2);
    sockets[1].onopen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe('live');
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
  });
});

describe('HTTP transport retry policy', () => {
  it('honors Retry-After and retries a rate-limited request', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(new Response('{"ok":true}'));
    const result = fetchJson<{ ok: boolean }>('https://data.example', {}, fetcher);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('cancels a pending retry when the selection is aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn(async () => new Response('{}', { status: 429 }));
    const result = fetchJson('https://data.example', { signal: controller.signal }, fetcher);
    const rejected = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('Alpaca adapter', () => {
  it.each(['1m', '5m'] as const)(
    'preserves completed minute metadata without prematurely closing %s aggregates',
    async (timeframe) => {
      vi.useFakeTimers();
      const opening = Date.parse('2024-11-29T14:30:00Z');
      vi.setSystemTime(opening + 60_000);
      const calendar: SessionInterval = {
        date: '2024-11-29',
        open: opening,
        close: Date.parse('2024-11-29T18:00:00Z'),
        extendedOpen: Date.parse('2024-11-29T09:00:00Z'),
        extendedClose: Date.parse('2024-11-30T01:00:00Z'),
      };
      const socket = new MockSocket(),
        received: Bar[] = [];
      const provider = new AlpacaProvider({
        baseUrl: 'http://gateway.local',
        fetch: async (url) =>
          new Response(JSON.stringify(String(url).includes('/api/calendar') ? [calendar] : [])),
        websocketFactory: () => socket as unknown as WebSocket,
      });
      const stop = provider.subscribe(
        { instrument: ALPACA_INSTRUMENTS[0], timeframe, session: 'regular' },
        { onBar: (value) => received.push(value), onStatus() {} },
      );
      socket.onopen?.();
      socket.message({ type: 'ready' });
      await vi.advanceTimersByTimeAsync(0);
      socket.message({ type: 'bar', data: { ...bar(opening), closed: true } });
      expect(received.at(-1)?.closed).toBe(timeframe === '1m');
      if (timeframe === '5m') {
        vi.setSystemTime(opening + 300_000);
        socket.message({ type: 'bar', data: { ...bar(opening + 240_000), closed: true } });
        expect(received.at(-1)).toMatchObject({ time: opening, closed: true });
      }
      stop();
    },
  );
  it('applies authoritative late corrections to the entire session candle after market close', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2024-11-29T18:00:15Z'));
    const opening = Date.parse('2024-11-29T14:30:00Z'),
      lastMinute = Date.parse('2024-11-29T17:59:00Z');
    const session: SessionInterval = {
      date: '2024-11-29',
      open: opening,
      close: Date.parse('2024-11-29T18:00:00Z'),
      extendedOpen: Date.parse('2024-11-29T09:00:00Z'),
      extendedClose: Date.parse('2024-11-30T01:00:00Z'),
    };
    const prefix = [
      { ...bar(opening), volume: 10 },
      { time: lastMinute, open: 20, high: 22, low: 18, close: 21, volume: 20, revision: 1 },
    ];
    const socket = new MockSocket(),
      received: Bar[] = [],
      gaps = vi.fn();
    const provider = new AlpacaProvider({
      baseUrl: 'http://gateway.local',
      token: 'test-token',
      fetch: async (url) =>
        new Response(JSON.stringify(String(url).includes('/api/calendar') ? [session] : prefix)),
      websocketFactory: () => socket as unknown as WebSocket,
    });
    const stop = provider.subscribe(
      { instrument: ALPACA_INSTRUMENTS[0], timeframe: '1D', session: 'regular' },
      { onBar: (b) => received.push(b), onStatus() {}, onGap: gaps },
    );
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0]).symbol).toBe('SPY');
    socket.message({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(0);
    socket.message({
      type: 'bar',
      data: { ...prefix[1], close: 24, high: 25, volume: 25, revision: 2 },
    });
    expect(received.at(-1)).toMatchObject({
      time: opening,
      open: 10,
      high: 25,
      low: 8,
      close: 24,
      volume: 35,
    });
    expect(provider.getCachedSessions()).toEqual([session]);
    stop();
  });
  it('does not build stock OHLCV from unfiltered executions', async () => {
    const socket = new MockSocket(),
      bars = vi.fn(),
      trades = vi.fn();
    const provider = new AlpacaProvider({
      baseUrl: 'http://gateway.local',
      websocketFactory: () => socket as unknown as WebSocket,
    });
    const stop = provider.subscribe(
      { instrument: ALPACA_INSTRUMENTS[0], timeframe: '1m', session: 'regular' },
      { onBar: bars, onTrade: trades, onStatus() {} },
    );
    socket.message({
      type: 'trade',
      data: { id: 'V:1', symbol: 'SPY', time: Date.now(), price: 100, size: 1 },
    });
    expect(trades).toHaveBeenCalledOnce();
    expect(bars).not.toHaveBeenCalled();
    stop();
  });
});
