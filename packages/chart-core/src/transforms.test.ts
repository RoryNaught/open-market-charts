import { describe, it, expect } from 'vitest';
import { heikinAshi, logicalToTime, timeToLogical, futureSessionTimes } from './transforms';
describe('coordinate and display transforms', () => {
  it('round trips inside gaps and beyond the data', () => {
    const times = [100, 200, 500, 600];
    for (const t of [-20, 100, 160, 400, 700])
      expect(logicalToTime(times, timeToLogical(times, t, 100)!, 100)).toBeCloseTo(t);
  });
  it('preserves time anchors when history is prepended', () => {
    expect(timeToLogical([100, 200, 500], 350, 100)).toBe(1.5);
    expect(timeToLogical([0, 100, 200, 500], 350, 100)).toBe(2.5);
  });
  it('calculates recursive HA without altering market bars', () => {
    const bars = [
      { time: 1, open: 10, high: 16, low: 8, close: 14, volume: 100 },
      { time: 2, open: 14, high: 18, low: 12, close: 16, volume: 200 },
    ];
    const ha = heikinAshi(bars);
    expect(ha[0].close).toBe(12);
    expect(ha[1].open).toBe(12);
    expect(ha[1].close).toBe(15);
    expect(bars[1].open).toBe(14);
  });
});

describe('provider calendar projection', () => {
  it('skips a holiday and weekend after an early close', () => {
    const sessions = [
      {
        date: '2025-07-03',
        open: Date.parse('2025-07-03T13:30Z'),
        close: Date.parse('2025-07-03T17:00Z'),
        extendedOpen: Date.parse('2025-07-03T08:00Z'),
        extendedClose: Date.parse('2025-07-03T21:00Z'),
      },
      {
        date: '2025-07-07',
        open: Date.parse('2025-07-07T13:30Z'),
        close: Date.parse('2025-07-07T20:00Z'),
        extendedOpen: Date.parse('2025-07-07T08:00Z'),
        extendedClose: Date.parse('2025-07-08T00:00Z'),
      },
    ];
    const last = Date.parse('2025-07-03T16:55Z');
    const future = futureSessionTimes(last, '5m', sessions, 'regular');
    expect(future[0]).toBe(Date.parse('2025-07-07T13:30Z'));
    const times = [last, ...future];
    expect(logicalToTime(times, 1, 300000)).toBe(future[0]);
    expect(timeToLogical(times, future[1], 300000)).toBe(2);
  });
});
