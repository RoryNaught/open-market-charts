import {
  timeframeMs,
  type Bar,
  type SessionInterval,
  type SessionMode,
  type Timeframe,
} from '@omc/provider-sdk';

export function heikinAshi(bars: readonly Bar[]): Bar[] {
  const result: Bar[] = [];
  for (const bar of bars) result.push(heikinAshiBar(bar, result.at(-1)));
  return result;
}
export function heikinAshiBar(bar: Bar, previous?: Bar): Bar {
  const close = (bar.open + bar.high + bar.low + bar.close) / 4;
  const open = previous ? (previous.open + previous.close) / 2 : (bar.open + bar.close) / 2;
  return {
    ...bar,
    open,
    high: Math.max(bar.high, open, close),
    low: Math.min(bar.low, open, close),
    close,
  };
}
/** Binary search plus interpolation preserves anchors within gaps and after prepends. */
export function timeToLogical(times: readonly number[], time: number, step: number): number | null {
  if (!times.length) return null;
  let low = 0,
    high = times.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (times[mid] < time) low = mid + 1;
    else high = mid;
  }
  if (low === 0) return (time - times[0]) / step;
  if (low === times.length) return low - 1 + (time - times[low - 1]) / step;
  return low - 1 + (time - times[low - 1]) / (times[low] - times[low - 1]);
}
export function logicalToTime(
  times: readonly number[],
  index: number,
  step: number,
): number | null {
  if (!times.length) return null;
  if (index <= 0) return times[0] + index * step;
  if (index >= times.length - 1) return times.at(-1)! + (index - times.length + 1) * step;
  const lower = Math.floor(index);
  return times[lower] + (times[lower + 1] - times[lower]) * (index - lower);
}

/** Project future drawing anchors through the provider's actual exchange calendar. No candles are fabricated. */
export function futureSessionTimes(
  last: number,
  timeframe: Timeframe,
  sessions: readonly SessionInterval[],
  mode: SessionMode,
): number[] {
  const result: number[] = [];
  const seenWeeks = new Set<number>();
  for (const session of [...sessions].sort((a, b) => a.open - b.open)) {
    if (timeframe === '1D') {
      if (session.open > last) result.push(session.open);
      continue;
    }
    if (timeframe === '1W') {
      const date = Date.parse(session.date + 'T12:00:00Z');
      const week = Math.floor((date + 259200000) / 604800000);
      if (!seenWeeks.has(week)) {
        seenWeeks.add(week);
        if (session.open > last) result.push(session.open);
      }
      continue;
    }
    const open = mode === 'regular' ? session.open : session.extendedOpen,
      close = mode === 'regular' ? session.close : session.extendedClose;
    for (let t = open; t < close; t += timeframeMs[timeframe]) if (t > last) result.push(t);
  }
  return result;
}
