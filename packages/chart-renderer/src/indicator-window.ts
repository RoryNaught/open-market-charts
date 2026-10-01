import type { IndicatorPoint } from '@omc/indicator-engine';

/** Keep the real current price on its native label even while viewing historical candles. */
export function priceWindow<T>(points: readonly T[], from: number, to: number): T[] {
  const window = points.slice(Math.max(0, from), Math.min(points.length, to + 1));
  if (points.length && to < points.length - 1) window.push(points[points.length - 1]);
  return window;
}

/** Full-resolution indicator history; rendering slices never feed calculations. */
export class IndicatorWindowCache {
  private points: IndicatorPoint[] = [];
  reset(points: readonly IndicatorPoint[]): void {
    this.points = points.filter(
      (point) =>
        Number.isFinite(point.time) && (Number.isFinite(point.value) || Number.isNaN(point.value)),
    );
  }
  get length(): number {
    return this.points.length;
  }
  private lowerBound(time: number): number {
    let low = 0,
      high = this.points.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.points[middle].time < time) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  upsert(points: readonly IndicatorPoint[]): void {
    for (const point of points) {
      if (
        !Number.isFinite(point.time) ||
        (!Number.isFinite(point.value) && !Number.isNaN(point.value))
      )
        continue;
      const last = this.points.at(-1);
      if (!last || point.time > last.time) this.points.push(point);
      else if (point.time === last.time) this.points[this.points.length - 1] = point;
      else {
        const index = this.lowerBound(point.time);
        if (this.points[index]?.time === point.time) this.points[index] = point;
        else this.points.splice(index, 0, point);
      }
    }
  }
  /** Include a neighbor at both edges so line segments crossing a viewport stay continuous. */
  slice(from: number, to: number): IndicatorPoint[] {
    if (from > to || !this.points.length) return [];
    const first = this.lowerBound(from),
      after = this.lowerBound(to);
    return this.points.slice(
      Math.max(0, first - 1),
      Math.min(this.points.length, after + (this.points[after]?.time === to ? 2 : 1)),
    );
  }
}
