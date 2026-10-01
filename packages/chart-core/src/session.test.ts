import { describe, it, expect, vi, afterEach } from 'vitest';
import { MarketSession } from './session';
import type {
  Bar,
  MarketDataProvider,
  StreamCallbacks,
  HistoryPage,
  Instrument,
} from '@omc/provider-sdk';
const instrument: Instrument = {
  id: 'test:A',
  symbol: 'A',
  name: 'A',
  provider: 'test',
  assetClass: 'crypto',
  currency: 'USD',
  timezone: 'UTC',
  pricePrecision: 2,
  volumeUnit: 'A',
  session: '24x7',
};
const bar = (time: number, close = 10, revision = 0): Bar => ({
  time,
  open: 10,
  high: 20,
  low: 1,
  close,
  volume: 2,
  revision,
});
const selection = { instrument, timeframe: '1m' as const, session: 'regular' as const };
function harness() {
  const requests: { resolve: (page: HistoryPage) => void }[] = [];
  const streams: StreamCallbacks[] = [];
  const frames: (() => void)[] = [];
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const provider = {
    id: 'test',
    capabilities: {},
    getHistory: vi.fn(() => new Promise<HistoryPage>((resolve) => requests.push({ resolve }))),
    subscribe: vi.fn((_req, cb: StreamCallbacks) => {
      streams.push(cb);
      return vi.fn();
    }),
    dispose: vi.fn(),
    searchSymbols: vi.fn(),
  } as unknown as MarketDataProvider;
  const onData = vi.fn(),
    onState = vi.fn();
  const session = new MarketSession({ onData, onState });
  return { session, provider, requests, streams, frames, onData };
}
afterEach(() => vi.unstubAllGlobals());
describe('market request and stream lifetimes', () => {
  it('backfills more than one page until the prior live candle overlaps', async () => {
    const h = harness();
    const open = h.session.open(h.provider, selection);
    h.requests[0].resolve({ bars: [bar(0)], hasMore: true, nextBefore: 0 });
    await open;
    h.streams[0].onGap?.();
    expect(h.requests).toHaveLength(2);
    h.requests[1].resolve({ bars: [bar(180000), bar(240000)], hasMore: true, nextBefore: 180000 });
    await Promise.resolve();
    expect(h.requests).toHaveLength(3);
    h.streams[0].onBar(bar(240000, 18, Date.now() + 1000));
    h.requests[2].resolve({
      bars: [bar(0), bar(60000), bar(120000)],
      hasMore: true,
      nextBefore: 0,
    });
    await Promise.resolve();
    expect(h.session.store.bars.map((b) => b.time)).toEqual([0, 60000, 120000, 180000, 240000]);
    expect(h.session.store.last?.close).toBe(18);
    expect(h.onData.mock.calls.at(-1)?.[1]).toBe('reset');
    h.session.dispose();
  });
  it('never publishes rejected stale or invalid bars to the renderer', async () => {
    const h = harness();
    const task = h.session.open(h.provider, selection);
    h.requests[0].resolve({ bars: [bar(0, 10, 10)], hasMore: false });
    await task;
    const before = h.onData.mock.calls.length;
    h.streams[0].onBar(bar(0, 12, 5));
    h.frames.shift()!();
    expect(h.onData).toHaveBeenCalledTimes(before);
    h.streams[0].onBar({ ...bar(0), volume: -1 });
    expect(h.frames).toHaveLength(0);
    h.streams[0].onBar(bar(0, 17, 20));
    h.streams[0].onBar(bar(0, 11, 19));
    h.frames.shift()!();
    expect(h.session.store.last?.close).toBe(17);
    expect(h.onData.mock.calls.at(-1)?.[2][0].close).toBe(17);
    h.session.dispose();
  });
  it('buffers a live replacement while history is in flight', async () => {
    const h = harness();
    const task = h.session.open(h.provider, selection);
    h.streams[0].onBar(bar(60_000, 15, 10));
    h.requests[0].resolve({ bars: [bar(0), bar(60_000)], hasMore: true, nextBefore: 0 });
    await task;
    expect(h.session.store.last?.close).toBe(15);
    expect(h.session.state.count).toBe(2);
    h.session.dispose();
  });
  it('ignores history and stream callbacks belonging to an obsolete selection', async () => {
    const h = harness();
    const old = h.session.open(h.provider, selection);
    const current = h.session.open(h.provider, { ...selection, timeframe: '5m' });
    h.requests[1].resolve({ bars: [bar(300_000)], hasMore: false });
    await current;
    h.requests[0].resolve({ bars: [bar(0)], hasMore: true });
    await old;
    h.streams[0].onBar(bar(600_000));
    expect(h.session.store.bars.map((b) => b.time)).toEqual([300_000]);
    h.session.dispose();
  });
  it('batches complete bar replacements in one frame and reports corrections as reset', async () => {
    const h = harness();
    const task = h.session.open(h.provider, selection);
    h.requests[0].resolve({ bars: [bar(0), bar(60_000)], hasMore: false });
    await task;
    h.streams[0].onBar(bar(60_000, 12, 1));
    h.streams[0].onBar(bar(60_000, 14, 2));
    expect(h.frames).toHaveLength(1);
    h.frames.shift()!();
    expect(h.session.store.last?.close).toBe(14);
    expect(h.onData.mock.calls.at(-1)?.[1]).toBe('update');
    h.streams[0].onBar(bar(0, 11, 3));
    h.frames.shift()!();
    expect(h.onData.mock.calls.at(-1)?.[1]).toBe('reset');
    h.session.dispose();
  });
  it('serializes pagination and respects exhausted history', async () => {
    const h = harness();
    const first = h.session.open(h.provider, selection);
    h.requests[0].resolve({ bars: [bar(60_000)], nextBefore: 60_000, hasMore: true });
    await first;
    const page = h.session.loadOlder();
    void h.session.loadOlder();
    expect(h.requests).toHaveLength(2);
    h.requests[1].resolve({ bars: [bar(0)], hasMore: false });
    await page;
    expect(h.session.store.length).toBe(2);
    await h.session.loadOlder();
    expect(h.requests).toHaveLength(2);
    h.session.dispose();
  });
});
