import { type Bar, type Trade } from '@omc/provider-sdk';

interface TradeBucket {
  bar: Bar;
  first: Trade;
  last: Trade;
}
function order(a: Trade, b: Trade): number {
  return (
    a.time - b.time ||
    (a.sequence ?? Number(a.id)) - (b.sequence ?? Number(b.id)) ||
    a.id.localeCompare(b.id)
  );
}

/** Accumulate every unique trade before emitting coalescible bar replacements. */
export class TradeBarAggregator {
  private buckets = new Map<number, TradeBucket>();
  private seen = new Map<string, true>();
  private bases = new Map<number, Bar>();
  constructor(
    private bucket: (time: number) => number | undefined,
    private maxIds = 100_000,
  ) {}
  seed(bars: readonly Bar[]): void {
    for (const bar of bars) this.bases.set(bar.time, { ...bar });
  }
  clear(): void {
    this.buckets.clear();
    this.seen.clear();
    this.bases.clear();
  }
  add(trade: Trade): Bar | undefined {
    if (
      !Number.isFinite(trade.time) ||
      !Number.isFinite(trade.price) ||
      !Number.isFinite(trade.size) ||
      trade.size < 0
    )
      return;
    const key = `${trade.symbol}:${trade.id}`;
    if (this.seen.has(key)) return;
    const time = this.bucket(trade.time);
    if (time === undefined) return;
    this.seen.set(key, true);
    if (this.seen.size > this.maxIds) this.seen.delete(this.seen.keys().next().value!);
    const found = this.buckets.get(time);
    if (!found)
      this.buckets.set(time, {
        bar: {
          time,
          open: trade.price,
          high: trade.price,
          low: trade.price,
          close: trade.price,
          volume: trade.size,
          closed: false,
        },
        first: trade,
        last: trade,
      });
    else {
      found.bar.high = Math.max(found.bar.high, trade.price);
      found.bar.low = Math.min(found.bar.low, trade.price);
      found.bar.volume += trade.size;
      if (order(trade, found.first) < 0) {
        found.first = trade;
        found.bar.open = trade.price;
      }
      if (order(trade, found.last) > 0) {
        found.last = trade;
        found.bar.close = trade.price;
      }
    }
    // Bound long-running sessions; the data store, rather than this accumulator, owns history.
    if (this.buckets.size > 512) {
      const oldest = Math.min(...this.buckets.keys());
      this.buckets.delete(oldest);
      this.bases.delete(oldest);
    }
    return this.get(time);
  }
  get(time: number): Bar | undefined {
    const live = this.buckets.get(time)?.bar,
      base = this.bases.get(time);
    if (!live) return base && { ...base };
    if (!base) return { ...live };
    return {
      time,
      open: base.open,
      high: Math.max(base.high, live.high),
      low: Math.min(base.low, live.low),
      close: live.close,
      volume: base.volume + live.volume,
      closed: false,
    };
  }
}
