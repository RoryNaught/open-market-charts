import { describe, expect, it } from 'vitest';
import { annotationGeometry } from './annotations';
import type { IndicatorAnnotation } from '@omc/indicator-engine';
import type { CoordinateAdapter } from '@omc/drawing-engine';

const adapter: CoordinateAdapter = {
  width: 200,
  height: 100,
  timeToX: (t) => t / 1000,
  xToTime: (x) => x * 1000,
  priceToY: (v) => 100 - Math.log10(v) * 20,
  yToPrice: (y) => 10 ** ((100 - y) / 20),
};
const base: IndicatorAnnotation = {
  id: 'a',
  kind: 'zone',
  time: 50000,
  price: 10,
  price2: 100,
  text: 'FVG',
  color: '#00ff00',
  originTime: 30000,
  confirmedAt: 50000,
  status: 'active',
};
describe('computed annotation coordinates', () => {
  it('starts zones at confirmation, extends to current data and maps nonlinear prices independently', () => {
    expect(annotationGeometry(base, adapter, 150000)).toMatchObject({
      x1: 50,
      x2: 150,
      y1: 80,
      y2: 60,
      labelX: 50,
    });
    expect(
      annotationGeometry({ ...base, endTime: 90000, status: 'filled' }, adapter, 150000)?.x2,
    ).toBe(90);
  });
  it('references the original pivot but puts structure labels at the confirmation candle', () => {
    expect(
      annotationGeometry({ ...base, kind: 'level', endTime: 50000 }, adapter, 150000),
    ).toMatchObject({ x1: 30, x2: 50, labelX: 50 });
  });
  it('culls offscreen annotations but retains zones crossing the viewport', () => {
    expect(
      annotationGeometry({ ...base, time: -50000, endTime: -1000 }, adapter, 150000),
    ).toBeNull();
    expect(annotationGeometry({ ...base, time: -50000 }, adapter, 150000)?.x1).toBe(-50);
    expect(annotationGeometry({ ...base, price: -1 }, adapter, 150000)).toBeNull();
  });
});
