import {
  timeframeMs,
  type Bar,
  type SessionInterval,
  type SessionMode,
  type Timeframe,
} from '@omc/provider-sdk';

export function utcBucket(time: number, timeframe: Timeframe): number {
  const width = timeframeMs[timeframe];
  // Unix epoch is Thursday; exchange-independent crypto weeks begin Monday UTC.
  const origin = timeframe === '1W' ? -259_200_000 : 0;
  return Math.floor((time - origin) / width) * width + origin;
}

export function isInSession(
  time: number,
  intervals: readonly SessionInterval[],
  mode: SessionMode,
): boolean {
  return intervals.some(
    (s) =>
      time >= (mode === 'regular' ? s.open : s.extendedOpen) &&
      time < (mode === 'regular' ? s.close : s.extendedClose),
  );
}

/** Calendar intervals, not weekday guesses, define stock aggregation boundaries. */
export function sessionBucket(
  time: number,
  timeframe: Timeframe,
  intervals: readonly SessionInterval[],
  mode: SessionMode,
): number | undefined {
  const session = intervals.find(
    (s) =>
      time >= (mode === 'regular' ? s.open : s.extendedOpen) &&
      time < (mode === 'regular' ? s.close : s.extendedClose),
  );
  if (!session) return undefined;
  if (timeframe === '1D') return session.open;
  if (timeframe === '1W') {
    const week = utcBucket(Date.parse(`${session.date}T12:00:00Z`), '1W');
    return intervals.find((s) => utcBucket(Date.parse(`${s.date}T12:00:00Z`), '1W') === week)?.open;
  }
  const origin = mode === 'regular' ? session.open : session.extendedOpen;
  return origin + Math.floor((time - origin) / timeframeMs[timeframe]) * timeframeMs[timeframe];
}

export function aggregateBars(
  bars: readonly Bar[],
  bucket: (time: number) => number | undefined,
): Bar[] {
  const result = new Map<number, Bar>();
  for (const bar of [...bars].sort((a, b) => a.time - b.time)) {
    const time = bucket(bar.time);
    if (time === undefined) continue;
    const existing = result.get(time);
    if (!existing) result.set(time, { ...bar, time });
    else {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close;
      existing.volume += bar.volume;
      existing.revision = Math.max(existing.revision ?? 0, bar.revision ?? 0);
      existing.closed = bar.closed;
    }
  }
  return [...result.values()].sort((a, b) => a.time - b.time);
}

/** End of a stock candle, clipped to the provider's actual session calendar. */
export function sessionBucketEnd(
  time: number,
  timeframe: Timeframe,
  intervals: readonly SessionInterval[],
  mode: SessionMode,
  calendarThrough?: number,
): number | undefined {
  const session = intervals.find(
    (s) =>
      time >= (mode === 'regular' ? s.open : s.extendedOpen) &&
      time < (mode === 'regular' ? s.close : s.extendedClose),
  );
  if (!session) return undefined;
  const end = mode === 'regular' ? session.close : session.extendedClose;
  if (timeframe === '1D') return end;
  if (timeframe === '1W') {
    const week = utcBucket(Date.parse(`${session.date}T12:00:00Z`), '1W');
    // A calendar ending midweek cannot establish that today's session is the last one.
    if (calendarThrough === undefined || calendarThrough < week + timeframeMs['1W'])
      return undefined;
    return Math.max(
      ...intervals
        .filter((s) => utcBucket(Date.parse(`${s.date}T12:00:00Z`), '1W') === week)
        .map((s) => (mode === 'regular' ? s.close : s.extendedClose)),
    );
  }
  const bucket = sessionBucket(time, timeframe, intervals, mode)!;
  return Math.min(bucket + timeframeMs[timeframe], end);
}

/** Constituent completion is necessary, but does not by itself close an aggregate candle. */
export function aggregateSessionBars(
  minutes: readonly Bar[],
  timeframe: Timeframe,
  intervals: readonly SessionInterval[],
  mode: SessionMode,
  observedThrough: number,
  calendarThrough?: number,
): Bar[] {
  const complete = new Map<number, boolean>();
  const bucket = (time: number) => sessionBucket(time, timeframe, intervals, mode);
  for (const bar of minutes) {
    const time = bucket(bar.time);
    if (time !== undefined) complete.set(time, (complete.get(time) ?? true) && bar.closed === true);
  }
  return aggregateBars(minutes, bucket).map((bar) => {
    const end = sessionBucketEnd(bar.time, timeframe, intervals, mode, calendarThrough);
    return {
      ...bar,
      closed: complete.get(bar.time) === true && end !== undefined && end <= observedThrough,
    };
  });
}

const nyDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export function newYorkDate(time: number): string {
  return nyDate.format(time);
}
export function newYorkTimestamp(date: string, clock: string): number {
  const target = Date.parse(`${date}T${clock.length === 5 ? `${clock}:00` : clock}Z`);
  // Resolve the actual offset on this date; both 04:00 and exchange opens are unambiguous across DST.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'longOffset',
  });
  let candidate = target;
  for (let i = 0; i < 3; i++) {
    const offset = formatter.formatToParts(candidate).find((p) => p.type === 'timeZoneName')!.value;
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offset);
    if (!match) throw new Error('Could not resolve exchange timezone');
    const next =
      target - (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
    if (next === candidate) break;
    candidate = next;
  }
  return candidate;
}
