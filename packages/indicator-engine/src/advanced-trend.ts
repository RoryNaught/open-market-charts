import type { Bar } from '@omc/provider-sdk';
import type { IndicatorAnnotation, IndicatorDefinition, IndicatorKernel } from './types';

const GREEN = '#22c9a4';
const RED = '#ef6d7a';
const MAX_ANNOTATIONS = 200;
const period = (value: number, min = 1) => ({ default: value, min, max: 10_000, integer: true });
const copyAnnotations = (items: readonly IndicatorAnnotation[]) =>
  items.map((item) => ({ ...item }));
function appendAnnotation(items: IndicatorAnnotation[], annotation: IndicatorAnnotation) {
  items.push(annotation);
  if (items.length > MAX_ANNOTATIONS) items.shift();
}
function trueRange(bar: Readonly<Bar>, previous: number | undefined): number {
  return previous === undefined
    ? bar.high - bar.low
    : Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous));
}

/** Removable Welford moments keep close-price variance stable at large price offsets. */
class RollingMoments {
  values: number[] = [];
  cursor = 0;
  mean = 0;
  m2 = 0;
  constructor(readonly length: number) {}
  push(value: number) {
    if (this.values.length === this.length) {
      const old = this.values[this.cursor];
      if (this.length === 1) this.mean = this.m2 = 0;
      else {
        const nextMean = this.mean + (this.mean - old) / (this.length - 1);
        this.m2 -= (old - this.mean) * (old - nextMean);
        this.mean = nextMean;
      }
      const delta = value - this.mean;
      this.mean += delta / this.length;
      this.m2 = Math.max(0, this.m2 + delta * (value - this.mean));
      this.values[this.cursor] = value;
      this.cursor = (this.cursor + 1) % this.length;
    } else {
      this.values.push(value);
      const delta = value - this.mean;
      this.mean += delta / this.values.length;
      this.m2 += delta * (value - this.mean);
    }
  }
  get ready() {
    return this.values.length === this.length;
  }
  snapshot() {
    return { values: [...this.values], cursor: this.cursor, mean: this.mean, m2: this.m2 };
  }
  restore(state: ReturnType<RollingMoments['snapshot']>) {
    this.values = [...state.values];
    this.cursor = state.cursor;
    this.mean = state.mean;
    this.m2 = state.m2;
  }
}

/** Monotonic deque: rolling extrema in amortized O(1), without scanning every candle window. */
class RollingExtreme {
  entries: Array<{ index: number; value: number }> = [];
  head = 0;
  constructor(
    readonly length: number,
    readonly maximum: boolean,
  ) {}
  push(value: number, index: number) {
    while (this.head < this.entries.length && this.entries[this.head].index <= index - this.length)
      this.head++;
    while (this.entries.length > this.head) {
      const tail = this.entries[this.entries.length - 1].value;
      if (this.maximum ? tail > value : tail < value) break;
      this.entries.pop();
    }
    this.entries.push({ index, value });
    if (this.head > this.length) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
    return this.entries[this.head].value;
  }
  snapshot() {
    return this.entries.slice(this.head).map((entry) => ({ ...entry }));
  }
  restore(state: ReturnType<RollingExtreme['snapshot']>) {
    this.entries = state.map((entry) => ({ ...entry }));
    this.head = 0;
  }
}

/** Endpoint of least-squares y = intercept + slope*x for x = 0..period-1. */
class RollingRegression {
  values: number[] = [];
  cursor = 0;
  sum = 0;
  weighted = 0;
  pushes = 0;
  constructor(readonly length: number) {}
  push(value: number): number | undefined {
    if (this.values.length === this.length) {
      const old = this.values[this.cursor];
      this.weighted -= this.sum - old;
      this.sum -= old;
      this.values[this.cursor] = value;
      this.cursor = (this.cursor + 1) % this.length;
      this.weighted += (this.length - 1) * value;
    } else {
      this.weighted += this.values.length * value;
      this.values.push(value);
    }
    this.sum += value;
    // Periodic rebasing bounds rounding drift in very long streams.
    if (++this.pushes % 4096 === 0) {
      this.sum = this.weighted = 0;
      for (let i = 0; i < this.values.length; i++) {
        const y = this.values[(this.cursor + i) % this.values.length];
        this.sum += y;
        this.weighted += i * y;
      }
    }
    if (this.values.length < this.length) return undefined;
    const meanX = (this.length - 1) / 2;
    const denominator = (this.length * (this.length * this.length - 1)) / 12;
    const slope = (this.weighted - meanX * this.sum) / denominator;
    return this.sum / this.length + slope * meanX;
  }
  snapshot() {
    return {
      values: [...this.values],
      cursor: this.cursor,
      sum: this.sum,
      weighted: this.weighted,
      pushes: this.pushes,
    };
  }
  restore(state: ReturnType<RollingRegression['snapshot']>) {
    this.values = [...state.values];
    this.cursor = state.cursor;
    this.sum = state.sum;
    this.weighted = state.weighted;
    this.pushes = state.pushes;
  }
}

function supertrend(params: Readonly<Record<string, number>>): IndicatorKernel {
  let state = {
    previousClose: undefined as number | undefined,
    count: 0,
    atr: 0,
    upper: undefined as number | undefined,
    lower: undefined as number | undefined,
    up: false,
    markers: [] as IndicatorAnnotation[],
  };
  return {
    step(bar, _index, context) {
      const tr = trueRange(bar, state.previousClose);
      const previousClose = state.previousClose;
      state.previousClose = bar.close;
      if (state.count < params.period) {
        state.count++;
        state.atr += (tr - state.atr) / state.count;
      } else state.atr += (tr - state.atr) / params.period;
      if (state.count < params.period) return {};
      const middle = (bar.high + bar.low) / 2;
      const basicUpper = middle + params.multiplier * state.atr;
      const basicLower = middle - params.multiplier * state.atr;
      const previousUpper = state.upper;
      const previousLower = state.lower;
      const previousUp = state.up;
      state.upper =
        previousUpper === undefined || basicUpper < previousUpper || previousClose! > previousUpper
          ? basicUpper
          : previousUpper;
      state.lower =
        previousLower === undefined || basicLower > previousLower || previousClose! < previousLower
          ? basicLower
          : previousLower;
      // ATR's first defined observation initializes DOWN; equality never reverses direction.
      if (previousUpper !== undefined)
        state.up = previousUp ? !(bar.close < state.lower) : bar.close > state.upper;
      const value = state.up ? state.lower : state.upper;
      if (
        previousUpper !== undefined &&
        state.up !== previousUp &&
        (context?.isConfirmed ?? bar.closed === true)
      ) {
        appendAnnotation(state.markers, {
          id: `supertrend:${bar.time}`,
          kind: 'marker',
          time: bar.time,
          price: value,
          text: state.up ? 'Supertrend up' : 'Supertrend down',
          color: state.up ? GREEN : RED,
          confirmedAt: bar.time,
        });
      }
      return { up: state.up ? value : undefined, down: state.up ? undefined : value };
    },
    annotations: () => copyAnnotations(state.markers),
    snapshot: () => ({ ...state, markers: copyAnnotations(state.markers) }),
    restore(snapshot) {
      const saved = snapshot as typeof state;
      state = { ...saved, markers: copyAnnotations(saved.markers) };
    },
  };
}

function squeezeMomentum(params: Readonly<Record<string, number>>): IndicatorKernel {
  const closes = new RollingMoments(params.period);
  const ranges = new RollingMoments(params.period);
  const highest = new RollingExtreme(params.period, true);
  const lowest = new RollingExtreme(params.period, false);
  const regression = new RollingRegression(params.period);
  let state = {
    previousClose: undefined as number | undefined,
    previousMomentum: undefined as number | undefined,
    squeezed: false,
    momentumColor: '#137c72',
    squeezeColor: '#6b7b8f',
    markers: [] as IndicatorAnnotation[],
  };
  const snapshot = () => ({
    ...state,
    markers: copyAnnotations(state.markers),
    closes: closes.snapshot(),
    ranges: ranges.snapshot(),
    highest: highest.snapshot(),
    lowest: lowest.snapshot(),
    regression: regression.snapshot(),
  });
  return {
    step(bar, index, context) {
      ranges.push(trueRange(bar, state.previousClose));
      closes.push(bar.close);
      state.previousClose = bar.close;
      const high = highest.push(bar.high, index);
      const low = lowest.push(bar.low, index);
      if (!closes.ready) return {};
      const bbWidth = params.bbMultiplier * Math.sqrt(Math.max(0, closes.m2) / params.period);
      const kcWidth = params.kcMultiplier * ranges.mean;
      // Both envelopes use SMA(close), so strict containment is equivalent to strict width comparison.
      const squeezed = bbWidth < kcWidth;
      const momentum = regression.push(bar.close - ((high + low) / 2 + closes.mean) / 2);
      if (momentum !== undefined) {
        const previous = state.previousMomentum ?? 0;
        state.momentumColor =
          momentum >= 0
            ? momentum > previous
              ? '#2dd4bf'
              : '#137c72'
            : momentum < previous
              ? '#f06c80'
              : '#8c4656';
        state.previousMomentum = momentum;
      }
      if (state.squeezed && !squeezed && (context?.isConfirmed ?? bar.closed === true)) {
        appendAnnotation(state.markers, {
          id: `squeeze:${bar.time}`,
          kind: 'marker',
          time: bar.time,
          price: momentum ?? 0,
          text: 'Squeeze release',
          color: '#f2c35b',
          confirmedAt: bar.time,
        });
      }
      state.squeezed = squeezed;
      state.squeezeColor = squeezed ? '#f2c35b' : '#6b7b8f';
      return { momentum, squeeze: 0 };
    },
    colors: () => ({ momentum: state.momentumColor, squeeze: state.squeezeColor }),
    annotations: () => copyAnnotations(state.markers),
    snapshot,
    restore(saved) {
      const value = saved as ReturnType<typeof snapshot>;
      state = {
        previousClose: value.previousClose,
        previousMomentum: value.previousMomentum,
        squeezed: value.squeezed,
        momentumColor: value.momentumColor,
        squeezeColor: value.squeezeColor,
        markers: copyAnnotations(value.markers),
      };
      closes.restore(value.closes);
      ranges.restore(value.ranges);
      highest.restore(value.highest);
      lowest.restore(value.lowest);
      regression.restore(value.regression);
    },
  };
}

export const advancedTrendDefinitions: IndicatorDefinition[] = [
  {
    type: 'Supertrend',
    name: 'Supertrend',
    version: 1,
    category: 'advanced',
    pane: 'price',
    description: 'Wilder ATR trailing bands; reversals confirm at the candle close.',
    parameters: { period: period(10), multiplier: { default: 3, min: 0, max: 100 } },
    outputs: [
      { key: 'up', kind: 'line', color: GREEN, gaps: true },
      { key: 'down', kind: 'line', color: RED, gaps: true },
    ],
    create: supertrend,
  },
  {
    type: 'SqueezeMomentum',
    name: 'Squeeze momentum',
    version: 1,
    category: 'advanced',
    pane: 'separate',
    description:
      'Bollinger/Keltner compression with detrended linear-regression momentum. Amber baseline means compression.',
    parameters: {
      period: period(20, 2),
      bbMultiplier: { default: 2, min: 0, max: 100 },
      kcMultiplier: { default: 1.5, min: 0, max: 100 },
    },
    outputs: [
      { key: 'momentum', kind: 'histogram', color: '#2dd4bf' },
      { key: 'squeeze', kind: 'line', color: '#6b7b8f' },
    ],
    create: squeezeMomentum,
  },
];
