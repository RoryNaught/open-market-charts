import { afterEach, expect, it, vi } from 'vitest';
import type { Bar, SessionInterval } from '@omc/provider-sdk';
import { newYorkTimestamp } from '@omc/data-engine';
import { AlpacaClient } from './alpaca-client';
import { readConfig } from './config';

afterEach(() => vi.useRealTimers());
const calendar: SessionInterval[] = ['2024-11-27', '2024-11-29'].map((date) => ({
  date,
  open: newYorkTimestamp(date, '09:30'),
  close: newYorkTimestamp(date, date.endsWith('29') ? '13:00' : '16:00'),
  extendedOpen: newYorkTimestamp(date, '04:00'),
  extendedClose: newYorkTimestamp(date, '20:00'),
}));
const minute = (time: number): Bar => ({
  time,
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: 10,
  closed: true,
});

it.each(['5m', '1D', '1W'] as const)(
  'does not mark partial historical %s bars closed just because minutes are complete',
  async (timeframe) => {
    vi.useFakeTimers();
    const observedThrough = newYorkTimestamp('2024-11-29', '10:02');
    vi.setSystemTime(observedThrough);
    const client = new AlpacaClient(readConfig({}));
    const calendarRequest = vi.spyOn(client, 'calendar').mockResolvedValue(calendar);
    vi.spyOn(client, 'minutes').mockResolvedValue([
      minute(newYorkTimestamp('2024-11-29', '10:01')),
    ]);
    const history = await client.history('SPY', timeframe, 'regular', undefined, 10);
    expect(history.bars[0].closed).toBe(false);
    expect(calendarRequest.mock.calls[0][1]).toBeGreaterThanOrEqual(
      observedThrough + 7 * 86_400_000,
    );
  },
);

it('confirms the final half-day weekly history candle without waiting until next week', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(newYorkTimestamp('2024-11-29', '13:01'));
  const client = new AlpacaClient(readConfig({}));
  vi.spyOn(client, 'calendar').mockResolvedValue(calendar);
  vi.spyOn(client, 'minutes').mockResolvedValue([
    minute(calendar[0].close - 60_000),
    minute(calendar[1].close - 60_000),
  ]);
  const history = await client.history('SPY', '1W', 'regular', undefined, 10);
  expect(history.bars[0]).toMatchObject({ time: calendar[0].open, closed: true, volume: 20 });
});
