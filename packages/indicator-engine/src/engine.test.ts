import { describe, expect, it } from 'vitest';
import type { Bar } from '@omc/provider-sdk';
import {
  calculateIndicators,
  createIndicatorConfig,
  defaultRegistry,
  IndicatorEngine,
  INDICATOR_TYPES,
  packBars,
  unpackBars,
} from './engine';
import { IndicatorRegistry } from './registry';
import { candleRangePlugin } from './example-plugin';
import type { IndicatorConfig, IndicatorResult } from './types';

const start = Date.UTC(2026, 0, 5);
function bars(closes: number[]): Bar[] {
  return closes.map((close, index) => ({
    time: start + index * 60_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
  }));
}
function config(type: string, params: Record<string, number> = {}): IndicatorConfig {
  return {
    ...createIndicatorConfig(type, type),
    params: { ...createIndicatorConfig(type).params, ...params },
  };
}
function values(
  type: string,
  input: Bar[],
  params: Record<string, number> = {},
  key = 'value',
): number[] {
  return calculateIndicators(input, [config(type, params)])[0]
    .outputs.find((output) => output.key === key)!
    .values.map((point) => point.value);
}
function expectResultsClose(actual: IndicatorResult[], expected: IndicatorResult[]) {
  expect(actual.map((result) => result.id)).toEqual(expected.map((result) => result.id));
  actual.forEach((result, i) => {
    result.outputs.forEach((output, j) => {
      const reference = expected[i].outputs[j];
      expect(output.values.length).toBe(reference.values.length);
      output.values.forEach((point, k) => {
        expect(point.time).toBe(reference.values[k].time);
        if (Number.isNaN(reference.values[k].value)) expect(Number.isNaN(point.value)).toBe(true);
        else expect(point.value).toBeCloseTo(reference.values[k].value, 9);
      });
    });
    if (result.profile) {
      expect(result.profile.totalVolume).toBeCloseTo(expected[i].profile!.totalVolume, 8);
      expect(result.profile.bins.length).toBe(expected[i].profile!.bins.length);
      result.profile.bins.forEach((bin, j) => {
        expect(bin.low).toBeCloseTo(expected[i].profile!.bins[j].low, 9);
        expect(bin.high).toBeCloseTo(expected[i].profile!.bins[j].high, 9);
        expect(bin.volume).toBeCloseTo(expected[i].profile!.bins[j].volume, 8);
      });
    }
  });
}

describe('indicator calculation conventions', () => {
  it('calculates SMA and SMA-seeded EMA with no premature warm-up values', () => {
    expect(values('SMA', bars([1, 2, 3, 4, 8]), { period: 3 })).toEqual([2, 3, 5]);
    expect(values('EMA', bars([1, 2, 3, 4, 8]), { period: 3 })).toEqual([2, 3, 5.5]);
    expect(values('SMA', bars([1, 2, 3]), { period: 1 })).toEqual([1, 2, 3]);
    expect(values('EMA', bars([1, 2]), { period: 3 })).toEqual([]);
  });
  it('uses Wilder RSI with explicit flat/up/down boundaries', () => {
    expect(values('RSI', bars([10, 11, 10, 12]), { period: 2 })[0]).toBe(50);
    expect(values('RSI', bars([10, 11, 10, 12]), { period: 2 })[1]).toBeCloseTo(83.3333333333, 8);
    expect(values('RSI', bars([10, 10, 10]), { period: 2 })).toEqual([50]);
    expect(values('RSI', bars([10, 11, 12]), { period: 2 })).toEqual([100]);
    expect(values('RSI', bars([10, 9, 8]), { period: 2 })).toEqual([0]);
  });
  it('includes overnight price gaps in ATR', () => {
    const result = values('ATR', bars([10, 11, 20, 20]), { period: 2 });
    expect(result).toEqual([2, 6, 4]);
  });
  it('uses population deviation for Bollinger bands', () => {
    const input = bars([1, 2, 3, 4]);
    expect(values('Bollinger', input, { period: 3 }, 'middle')).toEqual([2, 3]);
    expect(values('Bollinger', input, { period: 3 }, 'upper')[0]).toBeCloseTo(
      2 + 2 * Math.sqrt(2 / 3),
      12,
    );
    const large = values(
      'Bollinger',
      bars([1e9, 1e9 + 0.01, 1e9 - 0.01]),
      { period: 3 },
      'upper',
    )[0];
    expect(large - 1e9).toBeGreaterThan(0.015);
    expect(large - 1e9).toBeLessThan(0.018);
  });
  it('seeds MACD signal only after valid MACD observations', () => {
    const result = calculateIndicators(bars([1, 2, 3, 4, 5, 6]), [
      config('MACD', { fast: 2, slow: 3, signal: 2 }),
    ])[0];
    expect(result.outputs[0].values.map((point) => point.value)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(result.outputs[1].values.map((point) => point.value)).toEqual([0.5, 0.5, 0.5]);
    expect(result.outputs[2].values.map((point) => point.value)).toEqual([0, 0, 0]);
  });
  it('weights typical price by volume and resets VWAP at exchange session boundaries', () => {
    const input = bars([10, 20, 30]);
    input[0].volume = 0;
    input[1].volume = 20;
    expect(values('VWAP', input)).toEqual([20, 70 / 3]);
    input[2].time = start + 86_400_000;
    expect(values('VWAP', input)).toEqual([20, 30]);
    const sessions = [
      {
        date: 'session-a',
        open: start,
        close: start + 60_000,
        extendedOpen: start,
        extendedClose: start + 120_000,
      },
      {
        date: 'session-b',
        open: start + 120_000,
        close: start + 180_000,
        extendedOpen: start + 120_000,
        extendedClose: start + 240_000,
      },
    ];
    expect(
      calculateIndicators(bars([10, 20, 30]), [config('VWAP')], {
        sessions,
      })[0].outputs[0].values.map((point) => point.value),
    ).toEqual([10, 15, 30]);
  });
  it('anchors higher-timeframe VWAP monthly when requested', () => {
    const input = bars([10, 20, 30]);
    input[1].time = Date.UTC(2026, 0, 6);
    input[2].time = Date.UTC(2026, 1, 1);
    const result = calculateIndicators(input, [config('VWAP')], { vwapAnchor: 'month' });
    expect(result[0].outputs[0].values.map((point) => point.value)).toEqual([10, 15, 30]);
  });
  it('rejects invalid periods, unknown plugins, nonfinite inputs, and invalid OHLCV', () => {
    expect(() => calculateIndicators([], [config('SMA', { period: 0 })])).toThrow();
    expect(() => calculateIndicators([], [config('SMA', { period: 2.5 })])).toThrow();
    expect(() => calculateIndicators([], [config('MACD', { fast: 30, slow: 20 })])).toThrow();
    expect(() => calculateIndicators([{ ...bars([10])[0], high: NaN }], [])).toThrow();
    expect(() => defaultRegistry.get('unregistered')).toThrow();
  });
});

describe('streaming and history equivalence', () => {
  const configs = INDICATOR_TYPES.map((type) => config(type));
  const input = bars(Array.from({ length: 125 }, (_, i) => 100 + i * 0.11 + Math.sin(i) * 3));
  it('incremental calculation agrees with batch and revisions do not compound', () => {
    const engine = new IndicatorEngine(configs);
    engine.setData(input.slice(0, 80));
    for (const bar of input.slice(80)) engine.updateBar(bar);
    expectResultsClose(engine.getResults(), calculateIndicators(input, configs));
    const changed = { ...input.at(-1)!, close: 140, high: 145, volume: 37 };
    for (let i = 0; i < 15; i++) engine.updateBar(changed);
    expectResultsClose(
      engine.getResults(),
      calculateIndicators([...input.slice(0, -1), changed], configs),
    );
    engine.updateBar(input.at(-1)!);
    expectResultsClose(engine.getResults(), calculateIndicators(input, configs));
  });
  it('prepend recomputes recursive seeds against expanded history', () => {
    const engine = new IndicatorEngine(configs);
    engine.setData(input.slice(75));
    engine.prepend(input.slice(0, 80));
    expect(engine.length).toBe(input.length);
    expectResultsClose(engine.getResults(), calculateIndicators(input, configs));
  });
  it('historical correction triggers a reset and recomputes dependents', () => {
    const engine = new IndicatorEngine(configs);
    engine.setData(input);
    const correction = { ...input[30], close: 80, low: 75 };
    engine.updateBar(correction);
    expect(engine.lastChange).toBe('reset');
    const expected = [...input];
    expected[30] = correction;
    expectResultsClose(engine.getResults(), calculateIndicators(expected, configs));
  });
  it('dynamic add/remove uses complete existing history and independent instances', () => {
    const engine = new IndicatorEngine([config('EMA')]);
    engine.setData(input);
    engine.addIndicator(config('RSI'));
    expectResultsClose(
      engine.getResults(),
      calculateIndicators(input, [config('EMA'), config('RSI')]),
    );
    engine.removeIndicator('EMA');
    expect(engine.getResults().map((result) => result.type)).toEqual(['RSI']);
    expect(() => engine.addIndicator(config('RSI'))).toThrow('Duplicate');
  });
  it('removing an open VWAP point with zero corrected volume requests reset', () => {
    const engine = new IndicatorEngine([config('VWAP')]);
    engine.setData(bars([10]));
    engine.updateBar({ ...bars([10])[0], volume: 0 });
    expect(engine.lastChange).toBe('reset');
    expect(engine.getResults()[0].outputs[0].values).toEqual([]);
  });
  it('typed transport retains millisecond timestamps and numeric precision', () => {
    expect(unpackBars(packBars(input))).toEqual(input);
    expect(() => unpackBars(new Float64Array(7))).toThrow();
    const engine = new IndicatorEngine([config('SMA', { period: 3 })]);
    engine.setData(input);
    const delta = engine.getPackedResults(false, input[120].time)[0].outputs[0].values;
    expect(delta.length).toBe(10);
    expect(delta[0]).toBe(input[120].time);
  });
});

describe('estimated volume profile and community plugins', () => {
  it('conserves volume, handles flat candles, and respects visible range', () => {
    const input = bars([10, 12, 15]);
    input[1] = { ...input[1], high: 12, low: 12 };
    const engine = new IndicatorEngine([config('VolumeProfile', { bins: 5 })]);
    engine.setData(input);
    let profile = engine.getResults()[0].profile!;
    expect(profile.estimated).toBe(true);
    expect(profile.bins.reduce((sum, bin) => sum + bin.volume, 0)).toBeCloseTo(30, 10);
    engine.setVisibleRange(input[1].time, input[2].time);
    profile = engine.getResults()[0].profile!;
    expect(profile.totalVolume).toBe(20);
    expect(profile.bins.reduce((sum, bin) => sum + bin.volume, 0)).toBeCloseTo(20, 10);
    engine.setVisibleRange(0, 1);
    expect(engine.getResults()[0].profile!.bins).toEqual([]);
  });
  it('supports a flat entire market and zero-volume profiles', () => {
    const flat = bars([10, 10]).map((bar) => ({ ...bar, high: 10, low: 10 }));
    const result = calculateIndicators(flat, [config('VolumeProfile')])[0].profile!;
    expect(result.bins.reduce((sum, bin) => sum + bin.volume, 0)).toBeCloseTo(20, 8);
    expect(Number.isFinite(result.pointOfControl)).toBe(true);
    expect(
      calculateIndicators(
        flat.map((bar) => ({ ...bar, volume: 0 })),
        [config('VolumeProfile')],
      )[0].profile!.pointOfControl,
    ).toBeNull();
  });
  it('registers a renderer-independent local plugin and unregisters it', () => {
    const registry = new IndicatorRegistry();
    const unregister = registry.register(candleRangePlugin);
    const engine = new IndicatorEngine(
      [{ id: 'plugin', type: candleRangePlugin.type, params: {}, color: '#fff', pane: 'separate' }],
      {},
      registry,
    );
    engine.setData(bars([10, 20]));
    expect(engine.getResults()[0].outputs[0].values.map((point) => point.value)).toEqual([2, 2]);
    unregister();
    expect(() => registry.get(candleRangePlugin.type)).toThrow();
  });
});
