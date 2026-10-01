import type { Bar, SessionInterval } from '@omc/provider-sdk';
import type {
  IndicatorAnnotation,
  IndicatorContext,
  IndicatorDefinition,
  IndicatorKernel,
  IndicatorStepContext,
} from './types';

const bullish = '#55c9a5';
const bearish = '#ee8297';
type Direction = -1 | 1;
type Candle = Readonly<Pick<Bar, 'time' | 'open' | 'high' | 'low' | 'close'>>;
type Annotation = Readonly<IndicatorAnnotation>;
const candle = (bar: Readonly<Bar>): Candle =>
  Object.freeze({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
const confirmed = (bar: Readonly<Bar>, context?: IndicatorStepContext) =>
  context?.isConfirmed ?? bar.closed === true;
const frozenAnnotation = (annotation: IndicatorAnnotation): Annotation => Object.freeze(annotation);
function appendBounded<T>(values: readonly T[], value: T, limit: number): readonly T[] {
  return Object.freeze([...values.slice(Math.max(0, values.length - limit + 1)), value]);
}

interface Swing {
  readonly time: number;
  readonly price: number;
  readonly consumed: boolean;
  readonly swept: boolean;
}
interface StructureState {
  readonly window: readonly Candle[];
  readonly high?: Swing;
  readonly low?: Swing;
  readonly direction: Direction | 0;
  readonly annotations: readonly Annotation[];
  readonly lastTime?: number;
  readonly previousClose?: number;
}

function marketStructure(params: Readonly<Record<string, number>>): IndicatorKernel {
  const left = params.leftBars ?? 3;
  const right = params.rightBars ?? 3;
  const retention = params.maxAnnotations ?? 100;
  const detectSweeps = (params.sweeps ?? 1) === 1;
  const windowLength = left + right + 1;
  let state: StructureState = Object.freeze({
    window: Object.freeze([]),
    direction: 0,
    annotations: Object.freeze([]),
  });

  return {
    step(bar, _index, context) {
      if (!confirmed(bar, context) || (state.lastTime !== undefined && bar.time <= state.lastTime))
        return {};
      let high = state.high;
      let low = state.low;
      let direction = state.direction;
      let annotations = state.annotations;
      const emitBreak = (swing: Swing, next: Direction) => {
        const label = direction === 0 ? 'MSS' : direction === next ? 'BOS' : 'CHoCH';
        annotations = appendBounded(
          annotations,
          frozenAnnotation({
            id: `structure:${next}:${swing.time}:${bar.time}`,
            kind: 'level',
            time: bar.time,
            endTime: bar.time,
            price: swing.price,
            text: `${next === 1 ? 'Bullish' : 'Bearish'} ${label}`,
            color: next === 1 ? bullish : bearish,
            originTime: swing.time,
            confirmedAt: bar.time,
          }),
          retention,
        );
        direction = next;
      };
      const emitSweep = (swing: Swing, side: 'high' | 'low') => {
        annotations = appendBounded(
          annotations,
          frozenAnnotation({
            id: `sweep:${side}:${swing.time}:${bar.time}`,
            kind: 'marker',
            time: bar.time,
            price: side === 'high' ? bar.high : bar.low,
            price2: swing.price,
            text: side === 'high' ? 'High sweep' : 'Low sweep',
            color: side === 'high' ? bearish : bullish,
            originTime: swing.time,
            confirmedAt: bar.time,
          }),
          retention,
        );
      };

      // Only levels that were already known before this candle can trigger an event.
      if (high && !high.consumed) {
        if (bar.close > high.price) {
          emitBreak(high, 1);
          high = Object.freeze({ ...high, consumed: true });
        } else if (
          detectSweeps &&
          !high.swept &&
          bar.high > high.price &&
          bar.close < high.price &&
          state.previousClose !== undefined &&
          state.previousClose <= high.price
        ) {
          emitSweep(high, 'high');
          high = Object.freeze({ ...high, swept: true });
        }
      }
      if (low && !low.consumed) {
        if (bar.close < low.price) {
          emitBreak(low, -1);
          low = Object.freeze({ ...low, consumed: true });
        } else if (
          detectSweeps &&
          !low.swept &&
          bar.low < low.price &&
          bar.close > low.price &&
          state.previousClose !== undefined &&
          state.previousClose >= low.price
        ) {
          emitSweep(low, 'low');
          low = Object.freeze({ ...low, swept: true });
        }
      }

      const window = appendBounded(state.window, candle(bar), windowLength);
      if (window.length === windowLength) {
        const candidate = window[left];
        let isHigh = true;
        let isLow = true;
        for (let i = 0; i < window.length; i++) {
          if (i === left) continue;
          if (candidate.high <= window[i].high) isHigh = false;
          if (candidate.low >= window[i].low) isLow = false;
        }
        if (isHigh)
          high = Object.freeze({
            time: candidate.time,
            price: candidate.high,
            consumed: false,
            swept: false,
          });
        if (isLow)
          low = Object.freeze({
            time: candidate.time,
            price: candidate.low,
            consumed: false,
            swept: false,
          });
      }
      state = Object.freeze({
        window,
        high,
        low,
        direction,
        annotations,
        lastTime: bar.time,
        previousClose: bar.close,
      });
      return {};
    },
    // Persistent frozen state makes rollback O(1), with no shared mutable snapshots.
    snapshot: () => state,
    restore: (snapshot) => {
      state = snapshot as StructureState;
    },
    annotations: () => state.annotations.map((annotation) => ({ ...annotation })),
  };
}

interface Gap {
  readonly direction: Direction;
  readonly annotation: Annotation;
}
interface GapState {
  readonly window: readonly Candle[];
  readonly gaps: readonly Gap[];
  readonly lastTime?: number;
}

function sessionAt(time: number, sessions: readonly SessionInterval[]): string | undefined {
  let low = 0;
  let high = sessions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sessions[middle].extendedOpen <= time) low = middle + 1;
    else high = middle;
  }
  const session = sessions[low - 1];
  return session && time < session.extendedClose ? session.date : undefined;
}

function fairValueGaps(
  params: Readonly<Record<string, number>>,
  context: Readonly<IndicatorContext>,
): IndicatorKernel {
  const retention = params.maxAnnotations ?? 100;
  const minGapPercent = params.minGapPercent ?? 0;
  const withinSession = (params.withinSession ?? 0) === 1;
  const sessions = [...(context.sessions ?? [])].sort((a, b) => a.extendedOpen - b.extendedOpen);
  let state: GapState = Object.freeze({ window: Object.freeze([]), gaps: Object.freeze([]) });
  return {
    step(bar, _index, stepContext) {
      if (
        !confirmed(bar, stepContext) ||
        (state.lastTime !== undefined && bar.time <= state.lastTime)
      )
        return {};
      // Existing zones evolve before a new zone is created: formation cannot mitigate itself.
      let gaps: readonly Gap[] = state.gaps;
      let changed = false;
      const updated = state.gaps.map((gap) => {
        const annotation = gap.annotation;
        if (annotation.status === 'filled') return gap;
        const lower = annotation.price;
        const upper = annotation.price2!;
        const filled = gap.direction === 1 ? bar.low <= lower : bar.high >= upper;
        const touched = gap.direction === 1 ? bar.low <= upper : bar.high >= lower;
        const status = filled ? 'filled' : touched ? 'touched' : annotation.status;
        if (status === annotation.status) return gap;
        changed = true;
        return Object.freeze({
          direction: gap.direction,
          annotation: frozenAnnotation({
            ...annotation,
            status,
            ...(filled ? { endTime: bar.time } : {}),
          }),
        });
      });
      if (changed) gaps = Object.freeze(updated);

      if (state.window.length === 2) {
        const [first, middle] = state.window;
        const session = withinSession ? sessionAt(first.time, sessions) : undefined;
        const allowed =
          !withinSession ||
          (session !== undefined &&
            sessionAt(middle.time, sessions) === session &&
            sessionAt(bar.time, sessions) === session);
        const direction: Direction | 0 = bar.low > first.high ? 1 : bar.high < first.low ? -1 : 0;
        if (allowed && direction) {
          const lower = direction === 1 ? first.high : bar.high;
          const upper = direction === 1 ? bar.low : first.low;
          // Percentage threshold is relative to the middle candle's absolute close.
          const qualifies =
            minGapPercent === 0 ||
            (middle.close !== 0 &&
              ((upper - lower) / Math.abs(middle.close)) * 100 >= minGapPercent);
          if (qualifies)
            gaps = appendBounded(
              gaps,
              Object.freeze({
                direction,
                annotation: frozenAnnotation({
                  id: `fvg:${direction}:${first.time}:${bar.time}`,
                  kind: 'zone',
                  time: bar.time,
                  price: lower,
                  price2: upper,
                  text: direction === 1 ? 'Bullish FVG' : 'Bearish FVG',
                  color: direction === 1 ? bullish : bearish,
                  originTime: first.time,
                  confirmedAt: bar.time,
                  status: 'active',
                }),
              }),
              retention,
            );
        }
      }
      state = Object.freeze({
        window: appendBounded(state.window, candle(bar), 2),
        gaps,
        lastTime: bar.time,
      });
      return {};
    },
    snapshot: () => state,
    restore: (snapshot) => {
      state = snapshot as GapState;
    },
    annotations: () => state.gaps.map(({ annotation }) => ({ ...annotation })),
    status: () =>
      withinSession && sessions.length === 0
        ? {
            state: 'needs-input',
            message: 'Within-session gaps require an exchange session calendar.',
          }
        : undefined,
  };
}

export const priceActionDefinitions: IndicatorDefinition[] = [
  {
    type: 'MarketStructure',
    name: 'Market Structure',
    version: 1,
    category: 'advanced',
    description:
      'Strict confirmed pivots; closed-candle breaks initialize MSS, continue as BOS, or reverse as CHoCH. Optional swing-level wick sweeps. Signals arrive after right-bar confirmation; no order-book liquidity is measured.',
    pane: 'price',
    parameters: {
      leftBars: { default: 3, min: 1, max: 50, integer: true },
      rightBars: { default: 3, min: 1, max: 50, integer: true },
      sweeps: { default: 1, min: 0, max: 1, integer: true },
      maxAnnotations: { default: 100, min: 10, max: 500, integer: true },
    },
    outputs: [],
    create: marketStructure,
  },
  {
    type: 'FairValueGaps',
    name: 'Fair Value Gaps',
    version: 1,
    category: 'advanced',
    description:
      'Strict three-candle wick gaps, confirmed at the third close. Later wick contact marks touched; crossing the far boundary marks filled. Original bounds remain fixed. Optional session filtering requires a calendar.',
    pane: 'price',
    parameters: {
      minGapPercent: { default: 0, min: 0, max: 10 },
      withinSession: { default: 0, min: 0, max: 1, integer: true },
      maxAnnotations: { default: 100, min: 10, max: 500, integer: true },
    },
    outputs: [],
    create: fairValueGaps,
  },
];
