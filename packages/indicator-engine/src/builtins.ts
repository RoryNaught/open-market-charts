import type { Bar } from '@omc/provider-sdk';
import type { IndicatorContext, IndicatorDefinition, IndicatorKernel } from './types';

const period = (value: number) => ({ default: value, min: 1, max: 10_000, integer: true });

/** Stable removable Welford moments; avoids catastrophic cancellation in sum(x²)-sum(x)². */
class Window {
  values: number[] = [];
  cursor = 0;
  mean = 0;
  m2 = 0;
  constructor(readonly length: number) {}
  push(value: number): void {
    if (this.values.length === this.length) {
      const old = this.values[this.cursor];
      if (this.length === 1) {
        this.mean = 0;
        this.m2 = 0;
      } else {
        const nextMean = this.mean + (this.mean - old) / (this.length - 1);
        this.m2 -= (old - this.mean) * (old - nextMean);
        this.mean = nextMean;
      }
      const count = this.length - 1;
      const delta = value - this.mean;
      this.mean += delta / (count + 1);
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
  get ready(): boolean {
    return this.values.length === this.length;
  }
  snapshot() {
    return { values: [...this.values], cursor: this.cursor, mean: this.mean, m2: this.m2 };
  }
  restore(state: ReturnType<Window['snapshot']>) {
    this.values = [...state.values];
    this.cursor = state.cursor;
    this.mean = state.mean;
    this.m2 = state.m2;
  }
}
class Average {
  count = 0;
  mean = 0;
  constructor(
    readonly length: number,
    readonly alpha: number,
  ) {}
  push(value: number): number | undefined {
    if (this.count < this.length) {
      this.count++;
      this.mean += (value - this.mean) / this.count;
    } else this.mean += this.alpha * (value - this.mean);
    return this.count >= this.length ? this.mean : undefined;
  }
  snapshot() {
    return { count: this.count, mean: this.mean };
  }
  restore(state: ReturnType<Average['snapshot']>) {
    this.count = state.count;
    this.mean = state.mean;
  }
}
function kernel<S>(
  step: (bar: Readonly<Bar>, index: number) => Record<string, number | undefined>,
  snapshot: () => S,
  restore: (state: S) => void,
): IndicatorKernel {
  return { step, snapshot, restore: (value) => restore(value as S) };
}
function sessionKey(context: IndicatorContext): (time: number) => string | number {
  const timezone = context.timezone ?? 'UTC';
  const anchor = context.vwapAnchor ?? 'session';
  const format =
    timezone === 'UTC'
      ? undefined
      : new Intl.DateTimeFormat('en-CA', {
          timeZone: timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        });
  const sessions = [...(context.sessions ?? [])].sort((a, b) => a.extendedOpen - b.extendedOpen);
  let previousMinute = NaN;
  let previousDate = '';
  return (time) => {
    if (anchor === 'session' && sessions.length) {
      let low = 0,
        high = sessions.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (sessions[middle].extendedOpen <= time) low = middle + 1;
        else high = middle;
      }
      const session = sessions[low - 1];
      if (session && time < session.extendedClose) return session.date;
    }
    let date: string;
    if (format) {
      const minute = Math.floor(time / 60_000);
      if (minute !== previousMinute) {
        const fields = format.formatToParts(time);
        const get = (type: string) => fields.find((field) => field.type === type)!.value;
        previousDate = `${get('year')}-${get('month')}-${get('day')}`;
        previousMinute = minute;
      }
      date = previousDate;
    } else date = new Date(time).toISOString().slice(0, 10);
    if (anchor === 'month') return date.slice(0, 7);
    if (anchor === 'week') return Math.floor((Date.parse(date) / 86_400_000 + 3) / 7);
    return date;
  };
}

export const builtinDefinitions: IndicatorDefinition[] = [
  {
    type: 'SMA',
    name: 'Simple moving average',
    version: 1,
    pane: 'price',
    parameters: { period: period(20) },
    outputs: [{ key: 'value', kind: 'line' }],
    create: (params) => {
      const window = new Window(params.period);
      return kernel(
        (bar) => {
          window.push(bar.close);
          return { value: window.ready ? window.mean : undefined };
        },
        () => window.snapshot(),
        (state) => window.restore(state),
      );
    },
  },
  {
    type: 'EMA',
    name: 'Exponential moving average',
    version: 1,
    pane: 'price',
    parameters: { period: period(20) },
    outputs: [{ key: 'value', kind: 'line' }],
    create: (params) => {
      const average = new Average(params.period, 2 / (params.period + 1));
      return kernel(
        (bar) => ({ value: average.push(bar.close) }),
        () => average.snapshot(),
        (state) => average.restore(state),
      );
    },
  },
  {
    type: 'VWAP',
    name: 'Volume weighted average price',
    version: 1,
    pane: 'price',
    parameters: {},
    outputs: [{ key: 'value', kind: 'line' }],
    create: (_params, context) => {
      const key = sessionKey(context);
      let state = { session: '' as string | number, volume: 0, weighted: 0 };
      return kernel(
        (bar) => {
          const session = key(bar.time);
          if (session !== state.session) state = { session, volume: 0, weighted: 0 };
          state.volume += bar.volume;
          state.weighted += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
          return { value: state.volume > 0 ? state.weighted / state.volume : undefined };
        },
        () => ({ ...state }),
        (snapshot) => {
          state = { ...snapshot };
        },
      );
    },
  },
  {
    type: 'RSI',
    name: 'Relative strength index',
    version: 1,
    pane: 'separate',
    parameters: { period: period(14) },
    outputs: [{ key: 'value', kind: 'line' }],
    create: (params) => {
      const gain = new Average(params.period, 1 / params.period),
        loss = new Average(params.period, 1 / params.period);
      let previous: number | undefined;
      return kernel(
        (bar) => {
          const change = previous === undefined ? undefined : bar.close - previous;
          previous = bar.close;
          if (change === undefined) return {};
          const up = gain.push(Math.max(change, 0)),
            down = loss.push(Math.max(-change, 0));
          return {
            value:
              up === undefined || down === undefined
                ? undefined
                : down === 0
                  ? up === 0
                    ? 50
                    : 100
                  : 100 - 100 / (1 + up / down),
          };
        },
        () => ({ previous, gain: gain.snapshot(), loss: loss.snapshot() }),
        (state) => {
          previous = state.previous;
          gain.restore(state.gain);
          loss.restore(state.loss);
        },
      );
    },
  },
  {
    type: 'MACD',
    name: 'Moving average convergence divergence',
    version: 1,
    pane: 'separate',
    parameters: { fast: period(12), slow: period(26), signal: period(9) },
    outputs: [
      { key: 'macd', kind: 'line' },
      { key: 'signal', kind: 'line', color: '#f3bb66' },
      { key: 'histogram', kind: 'histogram', color: '#658d99' },
    ],
    create: (params) => {
      const fast = new Average(params.fast, 2 / (params.fast + 1)),
        slow = new Average(params.slow, 2 / (params.slow + 1)),
        signal = new Average(params.signal, 2 / (params.signal + 1));
      return kernel(
        (bar) => {
          const f = fast.push(bar.close),
            s = slow.push(bar.close);
          if (f === undefined || s === undefined) return {};
          const macd = f - s,
            sig = signal.push(macd);
          return { macd, signal: sig, histogram: sig === undefined ? undefined : macd - sig };
        },
        () => ({ fast: fast.snapshot(), slow: slow.snapshot(), signal: signal.snapshot() }),
        (state) => {
          fast.restore(state.fast);
          slow.restore(state.slow);
          signal.restore(state.signal);
        },
      );
    },
  },
  {
    type: 'Bollinger',
    name: 'Bollinger bands',
    version: 1,
    pane: 'price',
    parameters: { period: period(20), deviation: { default: 2, min: 0, max: 100 } },
    outputs: [
      { key: 'middle', kind: 'line' },
      { key: 'upper', kind: 'line', color: '#799eab' },
      { key: 'lower', kind: 'line', color: '#799eab' },
    ],
    create: (params) => {
      const window = new Window(params.period);
      return kernel(
        (bar) => {
          window.push(bar.close);
          if (!window.ready) return {};
          const spread = params.deviation * Math.sqrt(Math.max(0, window.m2) / params.period);
          return { middle: window.mean, upper: window.mean + spread, lower: window.mean - spread };
        },
        () => window.snapshot(),
        (state) => window.restore(state),
      );
    },
  },
  {
    type: 'ATR',
    name: 'Average true range',
    version: 1,
    pane: 'separate',
    parameters: { period: period(14) },
    outputs: [{ key: 'value', kind: 'line' }],
    create: (params) => {
      const average = new Average(params.period, 1 / params.period);
      let previous: number | undefined;
      return kernel(
        (bar) => {
          const tr =
            previous === undefined
              ? bar.high - bar.low
              : Math.max(
                  bar.high - bar.low,
                  Math.abs(bar.high - previous),
                  Math.abs(bar.low - previous),
                );
          previous = bar.close;
          return { value: average.push(tr) };
        },
        () => ({ previous, average: average.snapshot() }),
        (state) => {
          previous = state.previous;
          average.restore(state.average);
        },
      );
    },
  },
  {
    type: 'VolumeProfile',
    name: 'Volume profile (estimated)',
    version: 1,
    pane: 'price',
    parameters: { bins: { default: 50, min: 1, max: 250, integer: true } },
    outputs: [],
    create: () =>
      kernel(
        () => ({}),
        () => null,
        () => {},
      ),
  },
];
