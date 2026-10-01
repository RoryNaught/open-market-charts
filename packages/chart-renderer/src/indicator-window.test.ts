import { describe, expect, it } from 'vitest';
import { IndicatorWindowCache, priceWindow } from './indicator-window';
import { heikinAshi } from '@omc/chart-core';

describe('indicator render windows', () => {
  it('preserves explicit gaps and directional colors through windowing and revisions', () => {
    const cache = new IndicatorWindowCache();
    cache.reset([
      { time: 1, value: 4, color: '#00ff00' },
      { time: 2, value: NaN },
      { time: 3, value: 8 },
    ]);
    expect(cache.slice(2, 2)).toEqual([
      { time: 1, value: 4, color: '#00ff00' },
      { time: 2, value: NaN },
      { time: 3, value: 8 },
    ]);
    cache.upsert([
      { time: 3, value: NaN },
      { time: 4, value: 9, color: '#ff0000' },
    ]);
    expect(cache.slice(3, 4).map((p) => p.value)).toEqual([NaN, NaN, 9]);
    expect(cache.slice(3, 4).at(-1)?.color).toBe('#ff0000');
  });
  it('retains the latest candle for the native price label while panning into history', () => {
    const points = Array.from({ length: 10000 }, (_, time) => ({ time, close: time }));
    const window = priceWindow(points, 100, 200);
    expect(window.length).toBe(102);
    expect(window[0]).toBe(points[100]);
    expect(window.at(-2)).toBe(points[200]);
    expect(window.at(-1)).toBe(points[9999]);
    expect(priceWindow(points, 9900, 9999).length).toBe(100);
    expect(priceWindow([], 0, 1)).toEqual([]);
  });
  it('slices Heikin-Ashi after recursive calculation and keeps the true transformed tail', () => {
    const bars = Array.from({ length: 5000 }, (_, i) => ({
      time: i * 60000,
      open: 100 + Math.sin(i),
      high: 102 + Math.sin(i),
      low: 98 + Math.sin(i),
      close: 101 + Math.sin(i),
      volume: 10,
    }));
    const transformed = heikinAshi(bars);
    const window = priceWindow(transformed, 2000, 2200);
    expect(window[0]).toEqual(transformed[2000]);
    expect(window.at(-1)).toEqual(transformed.at(-1));
    expect(window[0].open).not.toBe(heikinAshi(bars.slice(2000))[0].open);
  });
  it('keeps boundary neighbors and missing warm-up observations intact', () => {
    const cache = new IndicatorWindowCache();
    cache.reset([20, 30, 50, 60].map((time) => ({ time, value: time / 10 })));
    expect(cache.slice(0, 10).map((point) => point.time)).toEqual([20]);
    expect(cache.slice(31, 49).map((point) => point.time)).toEqual([30, 50]);
    expect(cache.slice(30, 50).map((point) => point.time)).toEqual([20, 30, 50, 60]);
    expect(cache.slice(100, 200).map((point) => point.time)).toEqual([60]);
  });
  it('retains offscreen changes for later panning, replaces newest values, and appends bars', () => {
    const cache = new IndicatorWindowCache();
    cache.reset(Array.from({ length: 10000 }, (_, time) => ({ time, value: time })));
    cache.upsert([
      { time: 9999, value: 77 },
      { time: 10000, value: 88 },
      { time: 2, value: 99 },
    ]);
    expect(cache.length).toBe(10001);
    expect(cache.slice(9999, 10000).map((point) => point.value)).toEqual([9998, 77, 88]);
    expect(cache.slice(2, 2).find((point) => point.time === 2)?.value).toBe(99);
    expect(cache.slice(4000, 4100).length).toBe(103);
  });
  it('replaces the full cache after recursive recalculation or prepend', () => {
    const cache = new IndicatorWindowCache();
    cache.reset([
      { time: 20, value: 2 },
      { time: 30, value: 3 },
    ]);
    cache.reset([
      { time: 10, value: 1 },
      { time: 20, value: 2.5 },
      { time: 30, value: 3.5 },
    ]);
    expect(cache.slice(-Infinity, Infinity).map((point) => point.value)).toEqual([1, 2.5, 3.5]);
    cache.reset([]);
    expect(cache.slice(0, 100)).toEqual([]);
  });
});
