import { isValidBar, type Bar } from '@omc/provider-sdk';
import { builtinDefinitions } from './builtins';
import { anchoredVwapDefinition } from './anchored-vwap';
import { advancedTrendDefinitions } from './advanced-trend';
import { priceActionDefinitions } from './price-action';
import { IndicatorRegistry } from './registry';
import type {
  IndicatorConfig,
  IndicatorContext,
  IndicatorKernel,
  IndicatorResult,
  PackedIndicatorResult,
  VolumeProfile,
} from './types';

export const defaultRegistry = new IndicatorRegistry();
for (const definition of builtinDefinitions) defaultRegistry.register(definition);
defaultRegistry.register(anchoredVwapDefinition);
for (const definition of [...advancedTrendDefinitions, ...priceActionDefinitions])
  defaultRegistry.register(definition);
export const INDICATOR_TYPES = defaultRegistry.list().map((definition) => definition.type);
const colors = ['#60c7c1', '#e8b465', '#a79be5', '#8ab7da', '#df859c', '#9abc8c'];
let nextColor = 0;
export function createIndicatorConfig(
  type: string,
  id = `indicator-${globalThis.crypto.randomUUID()}`,
): IndicatorConfig {
  const definition = defaultRegistry.get(type);
  return {
    id,
    type,
    params: Object.fromEntries(
      Object.entries(definition.parameters).map(([key, value]) => [key, value.default]),
    ),
    color: colors[nextColor++ % colors.length],
    pane: definition.pane,
  };
}

/** Eight Float64 values per bar: UTC-ms time, OHLCV, closed (-1 unknown/0 false/1 true), revision (NaN absent). */
export const PACKED_BAR_STRIDE = 8;
export function packBars(bars: readonly Bar[]): Float64Array {
  const packed = new Float64Array(bars.length * PACKED_BAR_STRIDE);
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i],
      offset = i * PACKED_BAR_STRIDE;
    packed.set(
      [
        bar.time,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume,
        bar.closed === undefined ? -1 : Number(bar.closed),
        bar.revision ?? NaN,
      ],
      offset,
    );
  }
  return packed;
}
export function unpackBars(packed: Float64Array): Bar[] {
  if (packed.length % PACKED_BAR_STRIDE !== 0)
    throw new Error('Packed bars must contain time, OHLCV, closed flag, revision');
  const result: Bar[] = [];
  for (let i = 0; i < packed.length; i += PACKED_BAR_STRIDE) {
    if (![-1, 0, 1].includes(packed[i + 6]))
      throw new Error('Invalid packed bar confirmation flag');
    result.push({
      time: packed[i],
      open: packed[i + 1],
      high: packed[i + 2],
      low: packed[i + 3],
      close: packed[i + 4],
      volume: packed[i + 5],
      ...(packed[i + 6] === -1 ? {} : { closed: packed[i + 6] === 1 }),
      ...(Number.isNaN(packed[i + 7]) ? {} : { revision: packed[i + 7] }),
    });
  }
  return result;
}
class BarStore {
  private values = new Float64Array(PACKED_BAR_STRIDE * 256);
  length = 0;
  get(index: number): Bar {
    const i = index * PACKED_BAR_STRIDE;
    return {
      time: this.values[i],
      open: this.values[i + 1],
      high: this.values[i + 2],
      low: this.values[i + 3],
      close: this.values[i + 4],
      volume: this.values[i + 5],
      ...(this.values[i + 6] === -1 ? {} : { closed: this.values[i + 6] === 1 }),
      ...(Number.isNaN(this.values[i + 7]) ? {} : { revision: this.values[i + 7] }),
    };
  }
  set(index: number, bar: Bar) {
    if ((index + 1) * PACKED_BAR_STRIDE > this.values.length) {
      const next = new Float64Array(
        Math.max((index + 1) * PACKED_BAR_STRIDE, this.values.length * 2),
      );
      next.set(this.values);
      this.values = next;
    }
    const i = index * PACKED_BAR_STRIDE;
    this.values[i] = bar.time;
    this.values[i + 1] = bar.open;
    this.values[i + 2] = bar.high;
    this.values[i + 3] = bar.low;
    this.values[i + 4] = bar.close;
    this.values[i + 5] = bar.volume;
    this.values[i + 6] = bar.closed === undefined ? -1 : Number(bar.closed);
    this.values[i + 7] = bar.revision ?? NaN;
    this.length = Math.max(this.length, index + 1);
  }
  toArray(): Bar[] {
    return Array.from({ length: this.length }, (_, index) => this.get(index));
  }
  lowerBound(time: number): number {
    let low = 0,
      high = this.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.values[mid * PACKED_BAR_STRIDE] < time) low = mid + 1;
      else high = mid;
    }
    return low;
  }
}
class SeriesBuffer {
  private values = new Float64Array(512);
  private colors?: Array<string | undefined>;
  length = 0;
  write(time: number, value: number | undefined, color?: string, gaps = false): boolean {
    const replace = this.length > 0 && this.values[(this.length - 1) * 2] === time;
    if (!gaps && (value === undefined || !Number.isFinite(value))) {
      if (replace) {
        this.length--;
        if (this.colors) this.colors.length = this.length;
      }
      return replace;
    }
    const pointIndex = replace ? this.length - 1 : this.length;
    const offset = pointIndex * 2;
    if (offset + 2 > this.values.length) {
      const next = new Float64Array(this.values.length * 2);
      next.set(this.values);
      this.values = next;
    }
    this.values[offset] = time;
    this.values[offset + 1] = value !== undefined && Number.isFinite(value) ? value : NaN;
    if (color !== undefined && !this.colors) this.colors = new Array(this.length);
    if (this.colors) this.colors[pointIndex] = color;
    if (!replace) this.length++;
    return false;
  }
  packed(lastOnly = false): Float64Array {
    return this.values.slice(lastOnly ? Math.max(0, this.length - 1) * 2 : 0, this.length * 2);
  }
  packedFrom(from: number): Float64Array {
    return this.values.slice(this.indexFrom(from) * 2, this.length * 2);
  }
  private indexFrom(from: number): number {
    let low = 0,
      high = this.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.values[mid * 2] < from) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  packedColors(lastOnly: boolean, from?: number): Array<string | undefined> | undefined {
    return this.colors?.slice(
      from === undefined ? (lastOnly ? Math.max(0, this.length - 1) : 0) : this.indexFrom(from),
      this.length,
    );
  }
}
interface Runtime {
  config: IndicatorConfig;
  kernel: IndicatorKernel;
  beforeLast: unknown;
  outputs: Array<{
    key: string;
    kind: 'line' | 'histogram';
    color?: string;
    gaps?: boolean;
    buffer: SeriesBuffer;
  }>;
  profile?: VolumeProfile;
}
function inRange(bar: Bar, context: IndicatorContext): boolean {
  const range = context.volumeProfileRange;
  return !range || (bar.time >= range.from && bar.time <= range.to);
}
function contribute(profile: VolumeProfile, bar: Bar, factor = 1) {
  if (!bar.volume || !profile.bins.length) return;
  const low = profile.bins[0].low,
    high = profile.bins[profile.bins.length - 1].high,
    width = (high - low) / profile.bins.length;
  const index = (value: number) =>
    Math.max(0, Math.min(profile.bins.length - 1, Math.floor((value - low) / width)));
  if (bar.high === bar.low) profile.bins[index(bar.low)].volume += bar.volume * factor;
  else
    for (let i = index(bar.low); i <= index(bar.high); i++) {
      const bin = profile.bins[i];
      const overlap = Math.max(0, Math.min(bin.high, bar.high) - Math.max(bin.low, bar.low));
      bin.volume += (factor * bar.volume * overlap) / (bar.high - bar.low);
    }
  profile.totalVolume += bar.volume * factor;
}
function finishProfile(profile: VolumeProfile) {
  let best = -1;
  for (let i = 0; i < profile.bins.length; i++) {
    profile.bins[i].volume = Math.max(0, profile.bins[i].volume);
    if (best === -1 || profile.bins[i].volume > profile.bins[best].volume) best = i;
  }
  profile.pointOfControl =
    best < 0 || profile.totalVolume <= 0
      ? null
      : (profile.bins[best].low + profile.bins[best].high) / 2;
}
function calculateProfile(store: BarStore, bins: number, context: IndicatorContext): VolumeProfile {
  let low = Infinity,
    high = -Infinity;
  const start = context.volumeProfileRange ? store.lowerBound(context.volumeProfileRange.from) : 0;
  const end = context.volumeProfileRange
    ? store.lowerBound(context.volumeProfileRange.to + 1)
    : store.length;
  for (let i = start; i < end; i++) {
    const bar = store.get(i);
    low = Math.min(low, bar.low);
    high = Math.max(high, bar.high);
  }
  const profile: VolumeProfile = {
    bins: [],
    pointOfControl: null,
    estimated: true,
    totalVolume: 0,
  };
  if (!Number.isFinite(low)) return profile;
  if (high === low) {
    const pad = Math.max(Math.abs(low) * 1e-6, 1e-6);
    low -= pad;
    high += pad;
  }
  const width = (high - low) / bins;
  profile.bins = Array.from({ length: bins }, (_, index) => ({
    low: low + index * width,
    high: index === bins - 1 ? high : low + (index + 1) * width,
    volume: 0,
  }));
  for (let i = start; i < end; i++) contribute(profile, store.get(i));
  finishProfile(profile);
  return profile;
}
function unpackResults(results: PackedIndicatorResult[]): IndicatorResult[] {
  return results.map((result) => ({
    ...result,
    outputs: result.outputs.map(({ colors, ...output }) => ({
      ...output,
      values: Array.from({ length: output.values.length / 2 }, (_, index) => ({
        time: output.values[index * 2],
        value: output.values[index * 2 + 1],
        ...(colors?.[index] === undefined ? {} : { color: colors[index] }),
      })),
    })),
  }));
}
export { unpackResults };

/** Canonical history and numeric output buffers stay separate from any renderer. */
export class IndicatorEngine {
  private bars = new BarStore();
  private runtimes: Runtime[] = [];
  private configs: IndicatorConfig[] = [];
  private context: IndicatorContext;
  lastChange: 'reset' | 'update' = 'reset';
  /** Earliest timestamp changed by the latest update, including a preceding bar finalized at rollover. */
  lastChangedFrom = Infinity;
  constructor(
    configs: readonly IndicatorConfig[] = [],
    context: IndicatorContext = {},
    readonly registry = defaultRegistry,
  ) {
    this.context = context;
    this.setIndicators(configs);
  }
  get length() {
    return this.bars.length;
  }
  private initialize(configs: readonly IndicatorConfig[]) {
    const ids = new Set<string>();
    this.runtimes = configs.map((input) => {
      if (ids.has(input.id)) throw new Error(`Duplicate indicator instance: ${input.id}`);
      ids.add(input.id);
      const config = this.registry.normalize(input),
        definition = this.registry.get(config.type);
      const kernel = definition.create(config.params, this.context);
      return {
        config,
        kernel,
        beforeLast: kernel.snapshot(),
        outputs: definition.outputs.map((output) => ({
          ...output,
          color: output.color ?? config.color,
          buffer: new SeriesBuffer(),
        })),
      };
    });
    this.configs = this.runtimes.map((runtime) => runtime.config);
  }
  private process(bar: Bar, index: number, capture: boolean, isConfirmed: boolean) {
    let removed = false;
    for (const runtime of this.runtimes) {
      if (runtime.config.type === 'VolumeProfile') continue;
      if (capture) runtime.beforeLast = runtime.kernel.snapshot();
      const output = runtime.kernel.step(bar, index, { isConfirmed });
      const colors = runtime.kernel.colors?.();
      for (const series of runtime.outputs)
        removed =
          series.buffer.write(bar.time, output[series.key], colors?.[series.key], series.gaps) ||
          removed;
    }
    return removed;
  }
  private rebuild() {
    this.initialize(this.configs);
    for (let i = 0; i < this.bars.length; i++) {
      const bar = this.bars.get(i);
      const isConfirmed = i < this.bars.length - 1 || bar.closed === true;
      if (isConfirmed && bar.closed !== true) {
        bar.closed = true;
        this.bars.set(i, bar);
      }
      this.process(bar, i, i === this.bars.length - 1, isConfirmed);
    }
    this.rebuildProfiles();
    this.lastChange = 'reset';
    this.lastChangedFrom = this.bars.length ? this.bars.get(0).time : Infinity;
  }
  private rebuildProfiles() {
    for (const runtime of this.runtimes)
      if (runtime.config.type === 'VolumeProfile')
        runtime.profile = calculateProfile(this.bars, runtime.config.params.bins, this.context);
  }
  setData(bars: readonly Bar[]): void {
    const sorted = new Map<number, Bar>();
    for (const bar of bars) {
      if (!isValidBar(bar)) throw new Error(`Invalid OHLCV bar at ${bar.time}`);
      sorted.set(bar.time, bar);
    }
    this.bars = new BarStore();
    for (const bar of [...sorted.values()].sort((a, b) => a.time - b.time))
      this.bars.set(this.bars.length, bar);
    this.rebuild();
  }
  setIndicators(configs: readonly IndicatorConfig[]): void {
    this.initialize(configs);
    this.rebuild();
  }
  addIndicator(config: IndicatorConfig): void {
    this.setIndicators([...this.configs, config]);
  }
  removeIndicator(id: string): void {
    this.setIndicators(this.configs.filter((config) => config.id !== id));
  }
  setContext(context: IndicatorContext): void {
    this.context = context;
    this.rebuild();
  }
  setVisibleRange(from: number, to: number): void {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to)
      throw new Error('Invalid volume profile range');
    this.context = { ...this.context, volumeProfileRange: { from, to } };
    this.rebuildProfiles();
  }
  prepend(bars: readonly Bar[]): void {
    this.setData([...bars, ...this.bars.toArray()]);
  }
  /** Returns compact series deltas for current/new bars; a historical correction returns a reset. */
  update(bar: Bar): IndicatorResult[] {
    this.updateBar(bar);
    return this.getResults(false, this.lastChange === 'update' ? this.lastChangedFrom : undefined);
  }
  /** Worker path avoids allocating point objects when the transport needs typed buffers. */
  updateBar(bar: Bar): void {
    if (!isValidBar(bar)) throw new Error(`Invalid OHLCV bar at ${bar.time}`);
    const previous = this.bars.length ? this.bars.get(this.bars.length - 1) : undefined;
    if (previous && bar.time < previous.time) {
      this.setData([...this.bars.toArray(), bar]);
      return;
    }
    const replace = previous?.time === bar.time;
    const index = replace ? this.bars.length - 1 : this.bars.length;
    this.lastChangedFrom = bar.time;
    let removed = false;
    if (replace) {
      for (const runtime of this.runtimes) runtime.kernel.restore(runtime.beforeLast);
      // Once observed closed, a missing flag on a correction must not make a candle provisional again.
      if (previous?.closed === true && bar.closed !== true) bar = { ...bar, closed: true };
    } else if (previous && previous.closed !== true) {
      // Re-run the provisional bar from its checkpoint, now confirmed, before committing the new one.
      for (const runtime of this.runtimes) runtime.kernel.restore(runtime.beforeLast);
      const finalized = { ...previous, closed: true };
      this.bars.set(index - 1, finalized);
      removed = this.process(finalized, index - 1, false, true);
      this.lastChangedFrom = previous.time;
    }
    this.bars.set(index, bar);
    removed = this.process(bar, index, !replace, bar.closed === true) || removed;
    for (const runtime of this.runtimes)
      if (runtime.config.type === 'VolumeProfile') {
        const profile = runtime.profile;
        const retractsBoundary = !!(
          replace &&
          previous &&
          profile?.bins.length &&
          inRange(previous, this.context) &&
          ((previous.low === profile.bins[0].low && bar.low > previous.low) ||
            (previous.high === profile.bins[profile.bins.length - 1].high &&
              bar.high < previous.high))
        );
        const needsRebuild =
          !profile?.bins.length ||
          retractsBoundary ||
          (inRange(bar, this.context) &&
            (bar.low < profile.bins[0].low ||
              bar.high > profile.bins[profile.bins.length - 1].high));
        if (needsRebuild)
          runtime.profile = calculateProfile(this.bars, runtime.config.params.bins, this.context);
        else {
          if (replace && previous && inRange(previous, this.context))
            contribute(profile, previous, -1);
          if (inRange(bar, this.context)) contribute(profile, bar);
          finishProfile(profile);
        }
      }
    this.lastChange = removed ? 'reset' : 'update';
  }
  getPackedResults(lastOnly = false, from?: number): PackedIndicatorResult[] {
    return this.runtimes.map((runtime) => ({
      id: runtime.config.id,
      type: runtime.config.type,
      outputs: runtime.outputs.map((output) => ({
        key: output.key,
        color: output.color,
        kind: output.kind,
        ...(output.gaps ? { gaps: true } : {}),
        values:
          from === undefined ? output.buffer.packed(lastOnly) : output.buffer.packedFrom(from),
        colors: output.buffer.packedColors(lastOnly, from),
      })),
      ...(runtime.profile ? { profile: structuredClone(runtime.profile) } : {}),
      ...(runtime.kernel.annotations
        ? { annotations: structuredClone(runtime.kernel.annotations()) }
        : {}),
      status: runtime.kernel.status?.(),
    }));
  }
  getResults(lastOnly = false, from?: number): IndicatorResult[] {
    return unpackResults(this.getPackedResults(lastOnly, from));
  }
}

export function calculateIndicators(
  bars: readonly Bar[],
  configs: readonly IndicatorConfig[],
  context: IndicatorContext = {},
): IndicatorResult[] {
  const engine = new IndicatorEngine(configs, context);
  engine.setData(bars);
  return engine.getResults();
}
