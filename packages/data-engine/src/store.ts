import { isValidBar, type Bar } from '@omc/provider-sdk';

/** Ordered authoritative bars. Live appends/replacements do not scan history. */
export class BarStore {
  private values: Bar[] = [];
  get bars(): readonly Bar[] {
    return this.values;
  }
  get length(): number {
    return this.values.length;
  }
  get first(): Bar | undefined {
    return this.values[0];
  }
  get last(): Bar | undefined {
    return this.values.at(-1);
  }
  reset(bars: readonly Bar[]): void {
    this.values = [];
    this.merge(bars);
  }
  replace(bars: readonly Bar[]): void {
    this.reset(bars);
  }
  update(bar: Bar): boolean {
    if (!isValidBar(bar)) return false;
    const last = this.last;
    if (!last || bar.time > last.time) {
      this.values.push({ ...bar });
      return true;
    }
    let lo = 0,
      hi = this.values.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.values[mid].time < bar.time) lo = mid + 1;
      else hi = mid;
    }
    const previous = this.values[lo];
    if (previous?.time === bar.time) {
      if ((bar.revision ?? 0) < (previous.revision ?? 0)) return false;
      this.values[lo] = { ...bar };
    } else this.values.splice(lo, 0, { ...bar });
    return true;
  }
  upsert(bar: Bar): boolean {
    return this.update(bar);
  }
  merge(bars: readonly Bar[]): { added: number; updated: number } {
    const incoming = new Map<number, Bar>();
    for (const bar of bars)
      if (isValidBar(bar)) {
        const prev = incoming.get(bar.time);
        if (!prev || (bar.revision ?? 0) >= (prev.revision ?? 0))
          incoming.set(bar.time, { ...bar });
      }
    const sorted = [...incoming.values()].sort((a, b) => a.time - b.time);
    if (!sorted.length) return { added: 0, updated: 0 };
    if (!this.last || sorted[0].time >= this.last.time) {
      let added = 0,
        updated = 0;
      for (const bar of sorted) {
        const previous = this.last;
        if (this.update(bar)) {
          if (previous?.time === bar.time) updated++;
          else added++;
        }
      }
      return { added, updated };
    }
    const result: Bar[] = [];
    let i = 0,
      j = 0,
      added = 0,
      updated = 0;
    while (i < this.values.length && j < sorted.length) {
      const old = this.values[i],
        next = sorted[j];
      if (old.time < next.time) {
        result.push(old);
        i++;
      } else if (old.time > next.time) {
        result.push(next);
        j++;
        added++;
      } else {
        const newer = (next.revision ?? 0) >= (old.revision ?? 0);
        result.push(newer ? next : old);
        if (newer) updated++;
        i++;
        j++;
      }
    }
    for (; i < this.values.length; i++) result.push(this.values[i]);
    for (; j < sorted.length; j++) {
      result.push(sorted[j]);
      added++;
    }
    this.values = result;
    return { added, updated };
  }
}

/** Coalesce complete bar replacements, after all trades have been aggregated. */
export function createBarBatcher(
  onBars: (bars: Bar[]) => void,
  schedule: (fn: () => void) => unknown = (fn) => requestAnimationFrame(fn),
) {
  const pending = new Map<number, Bar>();
  let scheduled = false,
    disposed = false;
  const flush = () => {
    scheduled = false;
    if (disposed || !pending.size) return;
    const bars = [...pending.values()].sort((a, b) => a.time - b.time);
    pending.clear();
    onBars(bars);
  };
  return {
    push(bar: Bar) {
      if (disposed) return;
      pending.set(bar.time, bar);
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    },
    flush,
    dispose() {
      disposed = true;
      pending.clear();
    },
  };
}
