import { describe, expect, it } from 'vitest';
import type { Bar } from '@omc/provider-sdk';
import {
  calculateIndicators,
  createIndicatorConfig,
  IndicatorEngine,
  packBars,
  unpackBars,
} from './engine';

const start = Date.UTC(2026, 8, 1);
const bar = (index: number, price: number, volume: number): Bar => ({
  time: start + index * 60_000,
  open: price,
  high: price,
  low: price,
  close: price,
  volume,
});
const config = (anchorTime = start) => ({
  ...createIndicatorConfig('AnchoredVWAP', 'anchored-test'),
  color: '#60c7c1',
  params: { anchorTime, bands1: 1, bands2: 2 },
});
const read = (engine: IndicatorEngine, key = 'vwap') =>
  engine.getResults()[0].outputs.find((output) => output.key === key)!.values;

describe('Anchored VWAP with weighted population deviation', () => {
  it('matches the weighted mean and population variance known answer', () => {
    const engine = new IndicatorEngine([config()]);
    engine.setData([bar(0, 10, 1), bar(1, 14, 3)]);
    expect(read(engine).map((point) => point.value)).toEqual([10, 13]);
    expect(read(engine, 'upper1').at(-1)!.value).toBeCloseTo(13 + Math.sqrt(3), 12);
    expect(read(engine, 'lower2').at(-1)!.value).toBeCloseTo(13 - 2 * Math.sqrt(3), 12);
  });
  it('uses HLC3, not close, and ignores zero-volume contributions', () => {
    const engine = new IndicatorEngine([config()]);
    engine.setData([{ ...bar(0, 9, 2), high: 15, low: 9 }, bar(1, 100, 0)]);
    expect(read(engine).map((point) => point.value)).toEqual([11, 11]);
    expect(read(engine, 'upper2').map((point) => point.value)).toEqual([11, 11]);
    engine.setData([bar(0, 10, 0), bar(1, 14, 0)]);
    expect(read(engine)).toEqual([]);
  });
  it('leaves outputs empty until a fixed anchor is selected', () => {
    const result = calculateIndicators([bar(0, 10, 2)], [config(0)])[0];
    expect(result.outputs.every((output) => output.values.length === 0)).toBe(true);
    expect(result.status?.state).toBe('needs-input');
  });
  it('starts at the first bar at or after the anchor and persists across session boundaries', () => {
    const input = [bar(0, 2, 1000), bar(1, 10, 1), { ...bar(2, 14, 3), time: start + 86_400_000 }];
    const result = calculateIndicators(input, [config(start + 30_000)])[0];
    expect(result.outputs[0].values.map((point) => point.value)).toEqual([10, 13]);
    expect(result.status).toBeUndefined();
  });
  it('suppresses incomplete history instead of silently moving the anchor', () => {
    const engine = new IndicatorEngine([config()]);
    engine.setData([bar(1, 14, 3)]);
    expect(read(engine)).toEqual([]);
    expect(engine.getResults()[0].status?.state).toBe('incomplete');
    engine.prepend([bar(0, 10, 1)]);
    expect(read(engine).at(-1)!.value).toBe(13);
    expect(engine.getResults()[0].status).toBeUndefined();
  });
  it('prepending observations before the anchor does not change anchored values', () => {
    const engine = new IndicatorEngine([config(start + 2 * 60_000)]);
    engine.setData([bar(2, 10, 1), bar(3, 14, 3)]);
    const initial = engine.getResults();
    engine.prepend([bar(0, 100, 500), bar(1, 200, 1000)]);
    expect(engine.getResults()).toEqual(initial);
  });
  it('does not compound volume or variance across revisions or inferred candle closure', () => {
    const engine = new IndicatorEngine([config()]);
    engine.setData([bar(0, 10, 1), { ...bar(1, 12, 1), closed: false }]);
    const revision = { ...bar(1, 14, 3), closed: false };
    for (let i = 0; i < 20; i++) engine.updateBar(revision);
    expect(read(engine).at(-1)!.value).toBe(13);
    const next = { ...bar(2, 16, 2), closed: false };
    engine.updateBar(next);
    expect(engine.getResults()).toEqual(
      calculateIndicators([bar(0, 10, 1), revision, next], [config()]),
    );
    engine.updateBar({ ...bar(1, 18, 3), closed: true });
    expect(engine.lastChange).toBe('reset');
    expect(engine.getResults()).toEqual(
      calculateIndicators([bar(0, 10, 1), bar(1, 18, 3), next], [config()]),
    );
  });
  it('keeps variance finite at large price magnitudes with small spreads', () => {
    const result = calculateIndicators(
      [bar(0, 1e9, 1), bar(1, 1e9 + 0.01, 1), bar(2, 1e9 - 0.01, 1)],
      [config()],
    )[0];
    const center = result.outputs[0].values.at(-1)!.value;
    const spread =
      result.outputs.find((output) => output.key === 'upper1')!.values.at(-1)!.value - center;
    expect(spread).toBeGreaterThan(0.008);
    expect(spread).toBeLessThan(0.0083);
  });
  it('round-trips unknown, open, and closed flags with provider revisions', () => {
    const input = [
      bar(0, 10, 1),
      { ...bar(1, 11, 2), closed: false, revision: 0 },
      { ...bar(2, 12, 3), closed: true, revision: 42 },
    ];
    expect(unpackBars(packBars(input))).toEqual(input);
    const invalid = packBars(input);
    invalid[6] = 2;
    expect(() => unpackBars(invalid)).toThrow('confirmation');
  });
});
