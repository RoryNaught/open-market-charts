/** Binary-search interpolation on compressed chart time. Never store these indices. */
export function timeToLogical(
  time: number,
  times: readonly number[],
  intervalMs: number,
): number | null {
  if (!Number.isFinite(time) || !times.length || !(intervalMs > 0)) return null;
  const last = times.length - 1;
  if (time < times[0]) return (time - times[0]) / intervalMs;
  if (time > times[last]) return last + (time - times[last]) / intervalMs;
  let lo = 0,
    hi = last;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < time) lo = mid + 1;
    else hi = mid;
  }
  if (times[lo] === time) return lo;
  return lo - 1 + (time - times[lo - 1]) / (times[lo] - times[lo - 1]);
}

/** Uniform extrapolation is suitable for 24/7 feeds; session feeds must project through their calendar. */
export function logicalToTime(
  logical: number,
  times: readonly number[],
  intervalMs: number,
): number | null {
  if (!Number.isFinite(logical) || !times.length || !(intervalMs > 0)) return null;
  const last = times.length - 1;
  if (logical < 0) return times[0] + logical * intervalMs;
  if (logical > last) return times[last] + (logical - last) * intervalMs;
  const lo = Math.floor(logical);
  return lo === last ? times[last] : times[lo] + (logical - lo) * (times[lo + 1] - times[lo]);
}

export type ValueScaleMode = 'linear' | 'logarithmic' | 'percentage';
export function valueToScale(value: number, mode: ValueScaleMode, baseValue = 1): number | null {
  if (!Number.isFinite(value)) return null;
  if (mode === 'logarithmic') return value > 0 ? Math.log(value) : null;
  if (mode === 'percentage')
    return Number.isFinite(baseValue) && baseValue !== 0
      ? ((value - baseValue) / Math.abs(baseValue)) * 100
      : null;
  return value;
}
export function scaleToValue(value: number, mode: ValueScaleMode, baseValue = 1): number | null {
  if (!Number.isFinite(value)) return null;
  const result =
    mode === 'logarithmic'
      ? Math.exp(value)
      : mode === 'percentage'
        ? baseValue + (value * Math.abs(baseValue)) / 100
        : value;
  return Number.isFinite(result) &&
    (mode !== 'percentage' || (Number.isFinite(baseValue) && baseValue !== 0))
    ? result
    : null;
}
/** Reference transform for adapters/tests. A renderer should use its native scale API. */
export function createValueScale(
  min: number,
  max: number,
  height: number,
  mode: ValueScaleMode = 'linear',
  baseValue = 1,
) {
  const low = valueToScale(min, mode, baseValue),
    high = valueToScale(max, mode, baseValue);
  const valid =
    low !== null && high !== null && high > low && height > 0 && Number.isFinite(height);
  return {
    priceToY(value: number): number | null {
      const v = valueToScale(value, mode, baseValue);
      return valid && v !== null ? height * (1 - (v - low!) / (high! - low!)) : null;
    },
    yToPrice(y: number): number | null {
      return valid && Number.isFinite(y)
        ? scaleToValue(low! + (1 - y / height) * (high! - low!), mode, baseValue)
        : null;
    },
  };
}
