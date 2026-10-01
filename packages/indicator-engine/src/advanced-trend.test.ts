import { describe, expect, it } from 'vitest';
import type { Bar } from '@omc/provider-sdk';
import { advancedTrendDefinitions } from './advanced-trend';
import type { IndicatorKernel } from './types';

const start = Date.UTC(2026, 0, 5);
function candle(index: number, close: number, high = close + 1, low = close - 1): Bar {
  return { time: start + index * 60_000, open: close, high, low, close, volume: 10, closed: true };
}
function create(type: string, overrides: Record<string, number> = {}): IndicatorKernel {
  const definition = advancedTrendDefinitions.find((item) => item.type === type)!;
  const params = Object.fromEntries(
    Object.entries(definition.parameters).map(([key, rule]) => [key, rule.default]),
  );
  return definition.create({ ...params, ...overrides }, {});
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
function ranges(bars: Bar[]) {
  return bars.map((bar, i) =>
    i === 0
      ? bar.high - bar.low
      : Math.max(
          bar.high - bar.low,
          Math.abs(bar.high - bars[i - 1].close),
          Math.abs(bar.low - bars[i - 1].close),
        ),
  );
}

/** Deliberately slow full-window reference, independent of rolling production kernels. */
function squeezeReference(bars: Bar[], period: number, bbMultiplier = 2, kcMultiplier = 1.5) {
  const tr = ranges(bars);
  const detrended: number[] = [];
  return bars.map((bar, index) => {
    if (index + 1 < period) return {} as { momentum?: number; squeezed?: boolean };
    const window = bars.slice(index - period + 1, index + 1);
    const average = mean(window.map((item) => item.close));
    const std = Math.sqrt(mean(window.map((item) => (item.close - average) ** 2)));
    const kc = kcMultiplier * mean(tr.slice(index - period + 1, index + 1));
    const high = Math.max(...window.map((item) => item.high));
    const low = Math.min(...window.map((item) => item.low));
    detrended.push(bar.close - ((high + low) / 2 + average) / 2);
    let momentum: number | undefined;
    if (detrended.length >= period) {
      const y = detrended.slice(-period);
      const averageY = mean(y),
        averageX = (period - 1) / 2;
      let numerator = 0,
        denominator = 0;
      y.forEach((value, x) => {
        numerator += (x - averageX) * (value - averageY);
        denominator += (x - averageX) ** 2;
      });
      momentum = averageY + (numerator / denominator) * averageX;
    }
    return { momentum, squeezed: bbMultiplier * std < kc };
  });
}
function supertrendReference(bars: Bar[], period: number, multiplier: number) {
  const tr = ranges(bars),
    atr: number[] = [],
    upper: number[] = [],
    lower: number[] = [],
    up: boolean[] = [];
  return bars.map((bar, index) => {
    if (index + 1 < period) return {} as { up?: number; down?: number };
    atr[index] =
      index === period - 1
        ? mean(tr.slice(0, period))
        : (atr[index - 1] * (period - 1) + tr[index]) / period;
    const middle = (bar.high + bar.low) / 2;
    upper[index] = middle + multiplier * atr[index];
    lower[index] = middle - multiplier * atr[index];
    if (index > period - 1) {
      if (upper[index] >= upper[index - 1] && bars[index - 1].close <= upper[index - 1])
        upper[index] = upper[index - 1];
      if (lower[index] <= lower[index - 1] && bars[index - 1].close >= lower[index - 1])
        lower[index] = lower[index - 1];
      up[index] = up[index - 1] ? bar.close >= lower[index] : bar.close > upper[index];
    } else up[index] = false;
    return up[index]
      ? { up: lower[index], down: undefined }
      : { down: upper[index], up: undefined };
  });
}
function expectNumericRecord(
  actual: Record<string, number | undefined>,
  expected: Record<string, number | undefined>,
) {
  for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
    if (expected[key] === undefined) expect(actual[key]).toBeUndefined();
    else expect(actual[key]).toBeCloseTo(expected[key]!, 8);
  }
}

describe('Supertrend', () => {
  it('matches an independent Wilder-ATR reference including overnight gaps and warm-up', () => {
    const input = Array.from({ length: 600 }, (_, i) =>
      candle(i, 100 + Math.sin(i / 3) * 10 + (i > 250 ? 80 : 0)),
    );
    const actual = create('Supertrend');
    const expected = supertrendReference(input, 10, 3);
    input.forEach((bar, i) => expectNumericRecord(actual.step(bar, i), expected[i]));
    expect(actual.annotations!().length).toBeGreaterThan(0);
  });

  it('starts down, requires strict band crossings, and emits reversal markers only after close', () => {
    const input = [
      candle(0, 10, 11, 9),
      candle(1, 12, 12, 10),
      candle(2, 13, 13, 11),
      candle(3, 10, 11, 9),
      candle(4, 9, 10, 8),
    ];
    const kernel = create('Supertrend', { period: 1, multiplier: 1 });
    expect(kernel.step(input[0], 0)).toEqual({ up: undefined, down: 12 });
    expect(kernel.step(input[1], 1)).toEqual({ up: undefined, down: 12 });
    const checkpoint = kernel.snapshot();
    expect(kernel.step(input[2], 2, { isConfirmed: false })).toEqual({ up: 10, down: undefined });
    expect(kernel.annotations!()).toEqual([]);
    kernel.restore(checkpoint);
    kernel.step({ ...input[2], closed: undefined }, 2);
    expect(kernel.annotations!()).toEqual([]);
    kernel.restore(checkpoint);
    kernel.step(input[2], 2, { isConfirmed: true });
    expect(kernel.annotations!()).toMatchObject([
      { text: 'Supertrend up', time: input[2].time, confirmedAt: input[2].time },
    ]);
    expect(kernel.step(input[3], 3)).toEqual({ up: 10, down: undefined });
    expect(kernel.step(input[4], 4)).toEqual({ up: undefined, down: 11 });
    expect(kernel.annotations!().map((marker) => marker.text)).toEqual([
      'Supertrend up',
      'Supertrend down',
    ]);
  });

  it('bounds annotations and prevents callers or restored checkpoints mutating saved state', () => {
    const kernel = create('Supertrend', { period: 1, multiplier: 0 });
    for (let i = 0; i < 450; i++) kernel.step(candle(i, i % 2 ? 11 : 9, 11, 9), i);
    expect(kernel.annotations!()).toHaveLength(200);
    const saved = kernel.snapshot();
    const before = kernel.annotations!();
    kernel.annotations!()[0].text = 'external mutation';
    kernel.step(candle(450, 9, 11, 9), 450);
    kernel.restore(saved);
    expect(kernel.annotations!()).toEqual(before);
    kernel.step(candle(450, 9, 11, 9), 450);
    kernel.restore(saved);
    expect(kernel.annotations!()).toEqual(before);
  });
});

describe('Squeeze momentum', () => {
  it('matches a full-window reference through regression rebasing with 2*period-1 warm-up', () => {
    const input = Array.from({ length: 4300 }, (_, i) =>
      candle(i, 100 + Math.sin(i / 8) * 7 + Math.cos(i / 3) * 2 + i * 0.003),
    );
    const reference = squeezeReference(input, 20);
    const kernel = create('SqueezeMomentum');
    input.forEach((bar, i) => {
      const actual = kernel.step(bar, i);
      if (i < 38) expect(actual.momentum).toBeUndefined();
      else expect(actual.momentum).toBeCloseTo(reference[i].momentum!, 8);
      if (i < 19) expect(actual.squeeze).toBeUndefined();
      else {
        expect(actual.squeeze).toBe(0);
        expect(kernel.colors!().squeeze).toBe(reference[i].squeezed ? '#f2c35b' : '#6b7b8f');
      }
    });
  });

  it('treats exact band equality as outside and confirms a release only on close', () => {
    const kernel = create('SqueezeMomentum', { period: 2, bbMultiplier: 2, kcMultiplier: 1 });
    kernel.step(candle(0, 9, 10, 8), 0);
    kernel.step(candle(1, 9, 10, 8), 1);
    expect(kernel.colors!().squeeze).toBe('#f2c35b');
    const saved = kernel.snapshot();
    const release = candle(2, 11, 11, 11);
    kernel.step(release, 2, { isConfirmed: false });
    expect(kernel.colors!().squeeze).toBe('#6b7b8f');
    expect(kernel.annotations!()).toEqual([]);
    kernel.restore(saved);
    kernel.step({ ...release, closed: undefined }, 2);
    expect(kernel.annotations!()).toEqual([]);
    kernel.restore(saved);
    const output = kernel.step(release, 2, { isConfirmed: true });
    expect(kernel.annotations!()).toMatchObject([
      {
        time: release.time,
        confirmedAt: release.time,
        price: output.momentum,
        text: 'Squeeze release',
      },
    ]);
    kernel.step(candle(3, 15, 15, 15), 3);
    expect(kernel.annotations!()).toHaveLength(1);
  });

  it('uses four histogram colors for sign and strengthening or weakening momentum', () => {
    const kernel = create('SqueezeMomentum', { period: 5 });
    const colors = new Set<string>();
    let previous = 0;
    for (let i = 0; i < 250; i++) {
      const { momentum } = kernel.step(candle(i, 100 + Math.sin(i / 7) * 10), i);
      if (momentum === undefined) continue;
      const expected =
        momentum >= 0
          ? momentum > previous
            ? '#2dd4bf'
            : '#137c72'
          : momentum < previous
            ? '#f06c80'
            : '#8c4656';
      expect(kernel.colors!().momentum).toBe(expected);
      colors.add(expected);
      previous = momentum;
    }
    expect(colors.size).toBe(4);
  });

  it('handles flat, zero-volume data without inventing squeeze on coincident zero-width bands', () => {
    const kernel = create('SqueezeMomentum');
    for (let i = 0; i < 80; i++) {
      const output = kernel.step({ ...candle(i, 100, 100, 100), volume: 0 }, i);
      if (i >= 38) expect(output.momentum).toBe(0);
    }
    expect(kernel.colors!().squeeze).toBe('#6b7b8f');
    expect(kernel.annotations!()).toEqual([]);
  });
});

describe('advanced trend rollback contract', () => {
  it.each(['Supertrend', 'SqueezeMomentum'])(
    '%s restores all rolling state through repeated provisional revisions',
    (type) => {
      const input = Array.from({ length: 180 }, (_, i) => candle(i, 100 + Math.sin(i / 4) * 12));
      const baseline = create(type),
        revised = create(type);
      input.forEach((bar, index) => {
        const saved = revised.snapshot();
        for (let attempt = 0; attempt < 3; attempt++) {
          revised.step({ ...bar, high: bar.high + 10, close: bar.high + 9 }, index, {
            isConfirmed: false,
          });
          revised.restore(saved);
        }
        expectNumericRecord(revised.step(bar, index), baseline.step(bar, index));
        expect(revised.colors?.()).toEqual(baseline.colors?.());
        expect(revised.annotations!()).toEqual(baseline.annotations!());
      });
    },
  );
});
