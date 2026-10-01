import {
  TIMEFRAMES,
  timeframeMs,
  type Bar,
  type HistoryRequest,
  type Instrument,
  type MarketDataProvider,
  type StreamCallbacks,
  type SubscriptionRequest,
  type Timeframe,
} from '@omc/provider-sdk';
import { utcBucket } from './sessions';

export const SIMULATED_INSTRUMENTS: Instrument[] = [
  {
    id: 'simulated:BTC-USD',
    symbol: 'BTC-USD',
    name: 'Synthetic benchmark instrument',
    provider: 'simulated',
    assetClass: 'crypto',
    currency: 'USD',
    timezone: 'UTC',
    pricePrecision: 2,
    volumeUnit: 'units',
    session: '24x7',
  },
];
export interface GeneratorOptions {
  seed?: number;
  start?: number;
  timeframe?: Timeframe;
  basePrice?: number;
}
function random(value: number, seed: number): number {
  let n = Math.imul(value ^ seed, 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function price(index: number, seed: number, base: number): number {
  return (
    base *
    (1 +
      0.06 * Math.sin(index / 140) +
      0.025 * Math.sin(index / 19) +
      (random(index, seed) - 0.5) * 0.009)
  );
}
export function generatedBar(
  time: number,
  timeframe: Timeframe = '1m',
  seed = 42,
  base = 60_000,
  fraction = 1,
): Bar {
  const index = Math.floor(time / timeframeMs[timeframe]);
  const open = price(index - 1, seed, base),
    final = price(index, seed, base);
  const path = [
    open,
    open + (random(index * 3, seed) - 0.5) * base * 0.006,
    final + (random(index * 3 + 1, seed) - 0.5) * base * 0.006,
    final,
  ];
  const progress = Math.min(1, Math.max(0, fraction)) * 3,
    completed = Math.floor(progress);
  const points = path.slice(0, completed + 1);
  if (completed < 3)
    points.push(path[completed] + (path[completed + 1] - path[completed]) * (progress - completed));
  return {
    time,
    open,
    high: Math.max(...points),
    low: Math.min(...points),
    close: points.at(-1)!,
    volume: (20 + random(index, seed + 1) * 300) * fraction,
    closed: fraction >= 1,
  };
}
export function generateBars(count: number, options: GeneratorOptions = {}): Bar[] {
  const timeframe = options.timeframe ?? '1m',
    start = options.start ?? Date.UTC(2024, 0, 1);
  return Array.from({ length: count }, (_, i) =>
    generatedBar(
      start + i * timeframeMs[timeframe],
      timeframe,
      options.seed ?? 42,
      options.basePrice ?? 60_000,
    ),
  );
}
export class SimulatedProvider implements MarketDataProvider {
  readonly id = 'simulated';
  readonly capabilities = {
    timeframes: TIMEFRAMES,
    realtime: true,
    trades: false,
    quotes: false,
    extendedHours: false,
    label: 'SIMULATED · developer fixture',
    delayMinutes: 0,
  };
  private stops = new Set<() => void>();
  constructor(private options: { seed?: number; updateMs?: number } = {}) {}
  async searchSymbols(query: string): Promise<Instrument[]> {
    return SIMULATED_INSTRUMENTS.filter((i) =>
      `${i.symbol} ${i.name}`.toLowerCase().includes(query.toLowerCase()),
    );
  }
  async getHistory(request: HistoryRequest) {
    request.signal?.throwIfAborted();
    const width = timeframeMs[request.timeframe],
      end = request.before ?? utcBucket(Date.now(), request.timeframe) + width;
    const start = end - Math.min(request.limit, 10_000) * width;
    const bars = generateBars(Math.min(request.limit, 10_000), {
      start,
      timeframe: request.timeframe,
      seed: this.options.seed,
    });
    const last = bars.at(-1);
    if (last && last.time <= Date.now() && last.time + width > Date.now())
      bars[bars.length - 1] = generatedBar(
        last.time,
        request.timeframe,
        this.options.seed,
        undefined,
        (Date.now() - last.time) / width,
      );
    return { bars, nextBefore: start, hasMore: true };
  }
  subscribe(request: SubscriptionRequest, callbacks: StreamCallbacks): () => void {
    callbacks.onStatus('live', 'Synthetic data explicitly selected');
    let previous = utcBucket(Date.now(), request.timeframe);
    const tick = () => {
      const time = utcBucket(Date.now(), request.timeframe),
        width = timeframeMs[request.timeframe];
      if (time !== previous)
        callbacks.onBar({
          ...generatedBar(previous, request.timeframe, this.options.seed),
          revision: Date.now(),
          closed: true,
        });
      previous = time;
      callbacks.onBar({
        ...generatedBar(
          time,
          request.timeframe,
          this.options.seed,
          undefined,
          (Date.now() - time) / width,
        ),
        revision: Date.now(),
      });
    };
    const timer = setInterval(tick, this.options.updateMs ?? 500);
    const stop = () => {
      clearInterval(timer);
      this.stops.delete(stop);
    };
    this.stops.add(stop);
    return stop;
  }
  dispose(): void {
    for (const stop of [...this.stops]) stop();
  }
}
