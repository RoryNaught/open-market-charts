import { describe, expect, it } from 'vitest';
import type { Bar } from '@omc/provider-sdk';
import { priceActionDefinitions } from './price-action';
import {
  calculateIndicators,
  createIndicatorConfig,
  IndicatorEngine,
  packBars,
  unpackBars,
} from './engine';
import type { IndicatorConfig, IndicatorContext, IndicatorKernel } from './types';

const start = Date.UTC(2026, 8, 30, 13, 30);
function bar(index: number, high: number, low: number, close = (high + low) / 2): Bar {
  return { time: start + index * 60_000, open: close, high, low, close, volume: 100, closed: true };
}
function kernel(
  type: 'MarketStructure' | 'FairValueGaps',
  params: Record<string, number> = {},
  context: IndicatorContext = {},
): IndicatorKernel {
  const definition = priceActionDefinitions.find((candidate) => candidate.type === type)!;
  return definition.create(
    {
      ...Object.fromEntries(
        Object.entries(definition.parameters).map(([key, value]) => [key, value.default]),
      ),
      ...params,
    },
    context,
  );
}
function feed(kernel: IndicatorKernel, input: Bar[]): void {
  input.forEach((item, index) => kernel.step(item, index, { isConfirmed: item.closed === true }));
}
function structureBars(): Bar[] {
  return [
    [10, 8, 9],
    [12, 9, 11],
    [11, 8, 9],
    [10, 7, 8],
    [11, 8, 10],
    [14, 10, 13],
    [15, 12, 14],
    [14, 11, 12],
    [14, 10, 13],
    [17, 13, 16],
    [16, 12, 13],
    [13, 8, 9],
  ].map(([high, low, close], i) => bar(i, high, low, close));
}
function bullishGap(): Bar[] {
  return [bar(0, 10, 8, 9), bar(1, 14, 10, 13), bar(2, 15, 12, 14)];
}

describe('confirmed market structure', () => {
  it('labels initial MSS, continuation BOS, and opposite CHoCH at the break candle', () => {
    const study = kernel('MarketStructure', { leftBars: 1, rightBars: 1, sweeps: 0 });
    const input = structureBars();
    feed(study, input);
    const events = study.annotations!();
    expect(events.map((event) => event.text)).toEqual([
      'Bullish MSS',
      'Bullish BOS',
      'Bearish CHoCH',
    ]);
    expect(events.map((event) => event.time)).toEqual([
      input[5].time,
      input[9].time,
      input[11].time,
    ]);
    expect(events.map((event) => event.originTime)).toEqual([
      input[1].time,
      input[6].time,
      input[8].time,
    ]);
    expect(events.map((event) => event.price)).toEqual([12, 15, 10]);
    for (const event of events) {
      expect(event.confirmedAt).toBe(event.time);
      expect(event.originTime).toBeLessThan(event.time);
    }
  });
  it('uses strict 3/3 pivots and never confirms a live break before its candle closes', () => {
    const study = kernel('MarketStructure', { sweeps: 0 });
    const input = [
      bar(0, 10, 8),
      bar(1, 11, 9),
      bar(2, 12, 10),
      bar(3, 20, 17),
      bar(4, 13, 11),
      bar(5, 12, 10),
      bar(6, 11, 9),
      bar(7, 22, 18, 21),
    ];
    feed(study, input.slice(0, 6));
    const before = study.snapshot();
    study.step({ ...input[6], closed: false }, 6, { isConfirmed: false });
    expect(study.snapshot()).toBe(before);
    expect(study.annotations!()).toEqual([]);
    study.step(input[6], 6, { isConfirmed: true });
    expect(study.annotations!()).toEqual([]);
    study.step({ ...input[7], closed: false }, 7, { isConfirmed: false });
    expect(study.annotations!()).toEqual([]);
    study.step(input[7], 7, { isConfirmed: true });
    expect(study.annotations!()).toMatchObject([
      { originTime: input[3].time, time: input[7].time, text: 'Bullish MSS' },
    ]);
  });
  it('excludes equal-high and equal-low plateaus instead of choosing an arbitrary pivot', () => {
    const study = kernel('MarketStructure', { leftBars: 1, rightBars: 1 });
    feed(study, [bar(0, 10, 7), bar(1, 12, 6), bar(2, 12, 6), bar(3, 10, 7), bar(4, 14, 5, 13)]);
    expect(study.annotations!()).toEqual([]);
  });
  it('consumes each broken pivot once and does not interpret repeated closes as new breaks', () => {
    const study = kernel('MarketStructure', { leftBars: 1, rightBars: 1, sweeps: 0 });
    feed(study, structureBars().slice(0, 6));
    for (let i = 6; i < 30; i++) study.step(bar(i, 20 + i, 13, 19 + i), i, { isConfirmed: true });
    expect(study.annotations!().map((event) => event.text)).toEqual(['Bullish MSS']);
  });
  it('emits one wick sweep per swing, then permits a genuine close break of that level', () => {
    const study = kernel('MarketStructure', { leftBars: 1, rightBars: 1 });
    feed(study, structureBars().slice(0, 5));
    study.step(bar(5, 13, 8, 11), 5, { isConfirmed: true });
    study.step(bar(6, 14, 9, 11), 6, { isConfirmed: true });
    study.step(bar(7, 15, 10, 13), 7, { isConfirmed: true });
    expect(study.annotations!().map((event) => event.text)).toEqual(['High sweep', 'Bullish MSS']);
    expect(study.annotations!()[0]).toMatchObject({
      kind: 'marker',
      price: 13,
      price2: 12,
      confirmedAt: start + 5 * 60_000,
    });
  });
  it('allows an outside candle to sweep both sides without inventing intrabar ordering', () => {
    const study = kernel('MarketStructure', { leftBars: 1, rightBars: 1 });
    feed(study, structureBars().slice(0, 5));
    study.step(bar(5, 13, 6, 10), 5, { isConfirmed: true });
    expect(study.annotations!().map((event) => event.text)).toEqual(['High sweep', 'Low sweep']);
    expect(new Set(study.annotations!().map((event) => event.confirmedAt)).size).toBe(1);
  });
  it('does not count equality with the swing level as a close break or sweep', () => {
    const study = kernel('MarketStructure', { leftBars: 1, rightBars: 1 });
    feed(study, structureBars().slice(0, 5));
    study.step(bar(5, 13, 8, 12), 5, { isConfirmed: true });
    expect(study.annotations!()).toEqual([]);
  });
  it('is prefix-consistent: future bars cannot add earlier structure events', () => {
    const input = structureBars();
    const complete = kernel('MarketStructure', { leftBars: 1, rightBars: 1 });
    feed(complete, input);
    for (let length = 1; length <= input.length; length++) {
      const prefix = kernel('MarketStructure', { leftBars: 1, rightBars: 1 });
      feed(prefix, input.slice(0, length));
      expect(prefix.annotations!()).toEqual(
        complete.annotations!().filter((event) => event.confirmedAt <= input[length - 1].time),
      );
    }
  });
});

describe('fair-value gap lifecycle', () => {
  it('creates exact bullish bounds on the third close, then touches and fills on later candles', () => {
    const study = kernel('FairValueGaps');
    feed(study, bullishGap());
    const created = study.annotations!()[0];
    expect(created).toMatchObject({
      kind: 'zone',
      time: start + 2 * 60_000,
      originTime: start,
      confirmedAt: start + 2 * 60_000,
      price: 10,
      price2: 12,
      status: 'active',
    });
    expect(created.endTime).toBeUndefined();
    study.step(bar(3, 14, 11, 13), 3, { isConfirmed: true });
    expect(study.annotations!()[0]).toMatchObject({
      id: created.id,
      price: 10,
      price2: 12,
      status: 'touched',
    });
    study.step(bar(4, 13, 10, 12), 4, { isConfirmed: true });
    expect(study.annotations!()[0]).toMatchObject({
      id: created.id,
      price: 10,
      price2: 12,
      status: 'filled',
      endTime: start + 4 * 60_000,
    });
    study.step(bar(5, 16, 13, 15), 5, { isConfirmed: true });
    expect(study.annotations!()[0].endTime).toBe(start + 4 * 60_000);
  });
  it('uses symmetric bearish bounds and lifecycle comparisons', () => {
    const study = kernel('FairValueGaps');
    feed(study, [bar(0, 12, 10, 11), bar(1, 10, 6, 7), bar(2, 8, 5, 6)]);
    expect(study.annotations!()[0]).toMatchObject({
      price: 8,
      price2: 10,
      status: 'active',
      text: 'Bearish FVG',
    });
    study.step(bar(3, 9, 6, 7), 3, { isConfirmed: true });
    expect(study.annotations!()[0].status).toBe('touched');
    study.step(bar(4, 10, 7, 9), 4, { isConfirmed: true });
    expect(study.annotations!()[0]).toMatchObject({
      status: 'filled',
      endTime: start + 4 * 60_000,
    });
  });
  it('requires strict gaps and a meaningful optional percentage threshold', () => {
    const equal = kernel('FairValueGaps');
    feed(equal, [bar(0, 10, 8), bar(1, 11, 9), bar(2, 12, 10)]);
    expect(equal.annotations!()).toEqual([]);
    const small = [bar(0, 10, 8), bar(1, 14, 10, 13), bar(2, 12, 10.5)];
    const accept = kernel('FairValueGaps', { minGapPercent: 3 });
    feed(accept, small);
    expect(accept.annotations!()).toHaveLength(1);
    const reject = kernel('FairValueGaps', { minGapPercent: 4 });
    feed(reject, small);
    expect(reject.annotations!()).toEqual([]);
    const zeroBase = kernel('FairValueGaps', { minGapPercent: 1 });
    feed(zeroBase, [bar(0, -2, -3), bar(1, 1, -1, 0), bar(2, 3, 2)]);
    expect(zeroBase.annotations!()).toEqual([]);
  });
  it('ignores provisional creation and mitigation, preserving confirmed zones across every live revision', () => {
    const study = kernel('FairValueGaps');
    const input = bullishGap();
    feed(study, input.slice(0, 2));
    const snapshot = study.snapshot();
    for (let i = 0; i < 100; i++)
      study.step({ ...input[2], low: 12 + i / 100, closed: false }, 2, { isConfirmed: false });
    expect(study.snapshot()).toBe(snapshot);
    expect(study.annotations!()).toEqual([]);
    study.step(input[2], 2, { isConfirmed: true });
    const active = study.annotations!();
    study.step({ ...bar(3, 15, 5, 6), closed: false }, 3, { isConfirmed: false });
    expect(study.annotations!()).toEqual(active);
    study.step(bar(3, 16, 13, 15), 3, { isConfirmed: true });
    expect(study.annotations!()[0].status).toBe('active');
  });
  it('suppresses gaps spanning supplied exchange sessions and reports missing calendar input', () => {
    const sessions = [
      {
        date: 'a',
        open: start,
        close: start + 120_000,
        extendedOpen: start,
        extendedClose: start + 120_000,
      },
      {
        date: 'b',
        open: start + 120_000,
        close: start + 600_000,
        extendedOpen: start + 120_000,
        extendedClose: start + 600_000,
      },
    ];
    const filtered = kernel('FairValueGaps', { withinSession: 1 }, { sessions });
    feed(filtered, bullishGap());
    expect(filtered.annotations!()).toEqual([]);
    const continuous = kernel(
      'FairValueGaps',
      { withinSession: 1 },
      { sessions: [{ ...sessions[0], close: start + 600_000, extendedClose: start + 600_000 }] },
    );
    feed(continuous, bullishGap());
    expect(continuous.annotations!()).toHaveLength(1);
    const missing = kernel('FairValueGaps', { withinSession: 1 });
    feed(missing, bullishGap());
    expect(missing.annotations!()).toEqual([]);
    expect(missing.status!()).toMatchObject({ state: 'needs-input' });
  });
  it('preserves lifecycle state on historical prefixes instead of applying future fills early', () => {
    const input = [...bullishGap(), bar(3, 14, 11), bar(4, 13, 10)];
    const streaming = kernel('FairValueGaps');
    input.forEach((item, i) => {
      streaming.step(item, i, { isConfirmed: true });
      const prefix = kernel('FairValueGaps');
      feed(prefix, input.slice(0, i + 1));
      expect(streaming.annotations!()).toEqual(prefix.annotations!());
    });
  });
});

describe('price-action state isolation and bounds', () => {
  it.each(['MarketStructure', 'FairValueGaps'] as const)(
    'keeps %s snapshots independent and supports corrected replay',
    (type) => {
      const study = kernel(type, { leftBars: 1, rightBars: 1 });
      const input =
        type === 'MarketStructure'
          ? structureBars()
          : [...bullishGap(), bar(3, 14, 11), bar(4, 13, 10)];
      feed(study, input.slice(0, -1));
      const checkpoint = study.snapshot(),
        before = study.annotations!(),
        serial = JSON.stringify(checkpoint);
      study.step(input.at(-1)!, input.length - 1, { isConfirmed: true });
      expect(JSON.stringify(checkpoint)).toBe(serial);
      study.restore(checkpoint);
      expect(study.annotations!()).toEqual(before);
      const corrected = { ...input.at(-1)!, high: 19, low: 11, close: 14, open: 14 };
      study.step(corrected, input.length - 1, { isConfirmed: true });
      const reference = kernel(type, { leftBars: 1, rightBars: 1 });
      feed(reference, [...input.slice(0, -1), corrected]);
      expect(study.annotations!()).toEqual(reference.annotations!());
      const returned = study.annotations!();
      if (returned.length) returned[0].price = 999;
      expect(study.annotations!()).not.toEqual(returned.length ? returned : [{ price: 999 }]);
    },
  );
  it.each(['MarketStructure', 'FairValueGaps'] as const)(
    'does not retain unbounded history for %s',
    (type) => {
      const study = kernel(type, { leftBars: 1, rightBars: 1, maxAnnotations: 10 });
      const input =
        type === 'FairValueGaps'
          ? Array.from({ length: 1000 }, (_, i) => bar(i, i * 3 + 2, i * 3 + 1))
          : Array.from({ length: 100 }, (_, cycle) =>
              structureBars().map((item, offset) => ({
                ...item,
                time: start + (cycle * 12 + offset) * 60_000,
                open: item.open + cycle * 30,
                high: item.high + cycle * 30,
                low: item.low + cycle * 30,
                close: item.close + cycle * 30,
              })),
            ).flat();
      feed(study, input);
      expect(study.annotations!()).toHaveLength(10);
      expect(new Set(study.annotations!().map((annotation) => annotation.id)).size).toBe(10);
      const snapshot = study.snapshot() as {
        window: unknown[];
        gaps?: unknown[];
        annotations?: unknown[];
      };
      expect(snapshot.window.length).toBeLessThanOrEqual(3);
      expect(snapshot.gaps?.length ?? snapshot.annotations?.length).toBe(10);
      expect(Object.isFrozen(snapshot)).toBe(true);
    },
  );
  it('requires explicit confirmation when invoked directly without engine context', () => {
    const study = kernel('FairValueGaps');
    for (const item of bullishGap()) study.step({ ...item, closed: undefined }, 0);
    expect(study.annotations!()).toEqual([]);
    for (const item of bullishGap()) study.step(item, 0);
    expect(study.annotations!()).toHaveLength(1);
  });
  it('uses UTC timestamps rather than offsets or sequential indices for stable annotation IDs', () => {
    const a = kernel('FairValueGaps'),
      b = kernel('FairValueGaps');
    bullishGap().forEach((item, i) => {
      a.step(item, i, { isConfirmed: true });
      b.step(item, i + 1000, { isConfirmed: true });
    });
    expect(a.annotations!()).toEqual(b.annotations!());
  });
});

describe('price-action engine integration', () => {
  const configs = (): IndicatorConfig[] =>
    ['MarketStructure', 'FairValueGaps'].map((type) => {
      const params: Record<string, number> =
        type === 'MarketStructure'
          ? { leftBars: 1, rightBars: 1, sweeps: 1, maxAnnotations: 100 }
          : { minGapPercent: 0, withinSession: 0, maxAnnotations: 100 };
      return { ...createIndicatorConfig(type, type), params };
    });
  it('matches a closed-bar batch after streaming forming bars and confirming on rollover', () => {
    const input = structureBars();
    const engine = new IndicatorEngine(configs());
    input.forEach((item, i) => {
      engine.updateBar({ ...item, closed: false });
      engine.updateBar({ ...item, volume: 150, closed: false });
      const history = input
        .slice(0, i + 1)
        .map((entry, j) => ({ ...entry, volume: 150, closed: j < i }));
      const reference = calculateIndicators(history, configs());
      expect(engine.getResults().map((result) => result.annotations)).toEqual(
        reference.map((result) => result.annotations),
      );
    });
    engine.updateBar({ ...input.at(-1)!, volume: 150, closed: true });
    expect(engine.getResults().map((result) => result.annotations)).toEqual(
      calculateIndicators(
        input.map((item) => ({ ...item, volume: 150 })),
        configs(),
      ).map((result) => result.annotations),
    );
  });
  it('recomputes an amended historical pivot and retracts an amended final gap', () => {
    const input = structureBars();
    const engine = new IndicatorEngine(configs());
    engine.setData(input);
    const corrected = { ...input[1], high: 20 };
    engine.updateBar(corrected);
    expect(engine.lastChange).toBe('reset');
    expect(engine.getResults().map((result) => result.annotations)).toEqual(
      calculateIndicators(
        input.map((item, i) => (i === 1 ? corrected : item)),
        configs(),
      ).map((result) => result.annotations),
    );
    const gapEngine = new IndicatorEngine([createIndicatorConfig('FairValueGaps', 'gap')]);
    gapEngine.setData(bullishGap());
    expect(gapEngine.getResults()[0].annotations).toHaveLength(1);
    gapEngine.updateBar({ ...bullishGap()[2], low: 9, closed: undefined });
    expect(gapEngine.getResults()[0].annotations).toEqual([]);
  });
  it('preserves confirmation flags through packed worker transport', () => {
    const input = bullishGap().map((item, i) => ({ ...item, closed: i === 2 ? false : true }));
    const decoded = unpackBars(packBars(input));
    const config = createIndicatorConfig('FairValueGaps', 'gap');
    expect(calculateIndicators(decoded, [config])[0].annotations).toEqual([]);
    decoded[2].closed = true;
    expect(
      calculateIndicators(unpackBars(packBars(decoded)), [config])[0].annotations,
    ).toHaveLength(1);
  });
});
