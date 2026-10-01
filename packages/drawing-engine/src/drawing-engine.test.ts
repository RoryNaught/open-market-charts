import { describe, expect, it } from 'vitest';
import {
  anchorCount,
  buildDrawingGeometry,
  clipLine,
  createDrawing,
  createValueScale,
  deserializeDrawings,
  distanceToSegment,
  DRAWING_TOOLS,
  DrawingInteraction,
  DrawingStore,
  hitTestDrawings,
  logicalToTime,
  scaleToValue,
  timeToLogical,
  valueToScale,
  type CoordinateAdapter,
  type Drawing,
  type DrawingTool,
} from './index';

const scope = { symbolId: 'BTC-USD', paneId: 'price', scaleId: 'right' };
const adapter: CoordinateAdapter = {
  width: 100,
  height: 100,
  timeToX: (time) => time,
  xToTime: (x) => x,
  priceToY: (value) => 100 - value,
  yToPrice: (y) => 100 - y,
};
function drawing(type: DrawingTool = 'trend-line'): Drawing {
  return createDrawing(
    type,
    [
      { time: 10, value: 80 },
      { time: 70, value: 40 },
      { time: 30, value: 30 },
    ].slice(0, anchorCount(type)),
    scope,
  );
}

describe('market coordinate transforms', () => {
  it('interpolates compressed time gaps, preserves exact bars, and handles both future and older anchors', () => {
    const t = 1_700_000_000_000,
      times = [t, t + 60_000, t + 240_000];
    expect(timeToLogical(t + 60_000, times, 60_000)).toBe(1);
    expect(timeToLogical(t + 150_000, times, 60_000)).toBe(1.5);
    expect(timeToLogical(t - 30_000, times, 60_000)).toBe(-0.5);
    expect(timeToLogical(t + 360_000, times, 60_000)).toBe(4);
    for (const index of [-3.75, 0, 0.23, 1, 1.99, 2, 7.5])
      expect(timeToLogical(logicalToTime(index, times, 60_000)!, times, 60_000)).toBeCloseTo(
        index,
        8,
      );
  });
  it('pagination changes logical indices without changing their timestamp anchors', () => {
    const times = [1000, 2000, 5000];
    for (const time of [1000, 1600, 2000, 3200, 5000])
      expect(timeToLogical(time, [-1000, 0, ...times], 1000)! - 2).toBeCloseTo(
        timeToLogical(time, times, 1000)!,
      );
  });
  it('rejects absent series, invalid coordinates, and invalid intervals', () => {
    expect(timeToLogical(12, [], 1)).toBeNull();
    expect(logicalToTime(0, [], 1)).toBeNull();
    expect(timeToLogical(NaN, [1], 1)).toBeNull();
    expect(logicalToTime(Infinity, [1], 1)).toBeNull();
    expect(timeToLogical(1, [1], 0)).toBeNull();
  });
  it.each(['linear', 'logarithmic', 'percentage'] as const)(
    'round trips raw prices through %s scale',
    (mode) => {
      const scale = createValueScale(10, 1000, 400, mode, 20);
      for (const value of [10, 11.7, 25, 250, 999, 1000])
        expect(scale.yToPrice(scale.priceToY(value)!)).toBeCloseTo(value, 8);
      expect(scale.priceToY(10)).toBeCloseTo(400);
      expect(scale.priceToY(1000)).toBeCloseTo(0);
    },
  );
  it('uses multiplicative midpoint for log and a fixed base for percentage values', () => {
    expect(createValueScale(10, 1000, 400, 'logarithmic').yToPrice(200)).toBeCloseTo(100);
    expect(valueToScale(125, 'percentage', 100)).toBe(25);
    expect(scaleToValue(-20, 'percentage', 100)).toBe(80);
    expect(valueToScale(-50, 'percentage', -100)).toBe(50);
    expect(createValueScale(0, 100, 100, 'logarithmic').priceToY(10)).toBeNull();
    expect(valueToScale(0, 'logarithmic')).toBeNull();
    expect(scaleToValue(1, 'percentage', 0)).toBeNull();
  });
});

describe('geometry and hit testing', () => {
  it.each(DRAWING_TOOLS)('builds finite, visible geometry for %s', (type) => {
    const object = drawing(type),
      geometry = buildDrawingGeometry(object, adapter);
    expect(geometry.segments.length).toBeGreaterThan(0);
    expect(geometry.handles).toHaveLength(anchorCount(type));
    for (const segment of geometry.segments)
      for (const point of [segment.from, segment.to]) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(100);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(100);
      }
  });
  it('clips diagonal, reverse, vertical, and zero-length rays', () => {
    expect(clipLine({ x: 20, y: 20 }, { x: 40, y: 40 }, 100, 100, true)?.to).toEqual({
      x: 100,
      y: 100,
    });
    expect(clipLine({ x: 20, y: 20 }, { x: 10, y: 10 }, 100, 100, true)?.to).toEqual({
      x: 0,
      y: 0,
    });
    expect(clipLine({ x: 20, y: 20 }, { x: 20, y: 30 }, 100, 100, true)?.to).toEqual({
      x: 20,
      y: 100,
    });
    expect(clipLine({ x: -20, y: 20 }, { x: -10, y: 20 }, 100, 100)).toBeNull();
    expect(clipLine({ x: 20, y: 20 }, { x: 20, y: 20 }, 100, 100, true)?.to).toEqual({
      x: 20,
      y: 20,
    });
  });
  it('measures segment distance without selecting the imaginary line extension', () => {
    expect(distanceToSegment({ x: 5, y: 5 }, { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } })).toBe(
      5,
    );
    expect(distanceToSegment({ x: 20, y: 0 }, { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } })).toBe(
      10,
    );
  });
  it('keeps horizontal/vertical/date drawings usable when the irrelevant coordinate is unavailable', () => {
    expect(
      buildDrawingGeometry(drawing('horizontal-line'), { ...adapter, timeToX: () => null })
        .segments,
    ).toHaveLength(1);
    expect(
      buildDrawingGeometry(drawing('vertical-line'), { ...adapter, priceToY: () => null }).segments,
    ).toHaveLength(1);
    expect(
      buildDrawingGeometry(drawing('date-range'), { ...adapter, priceToY: () => null }).segments,
    ).toHaveLength(2);
  });
  it('calculates Fibonacci in raw value space on logarithmic charts', () => {
    const fib = createDrawing(
      'fibonacci',
      [
        { time: 10, value: 10 },
        { time: 90, value: 1000 },
      ],
      scope,
    );
    fib.levels = [0.5];
    const scale = createValueScale(10, 1000, 100, 'logarithmic');
    const geometry = buildDrawingGeometry(fib, { ...adapter, ...scale });
    expect(geometry.segments[1].from.y).toBeCloseTo(scale.priceToY(505)!);
    expect(geometry.segments[1].from.y).not.toBeCloseTo(50);
  });
  it('constructs parallel channels for vertical baselines', () => {
    const channel = createDrawing(
      'parallel-channel',
      [
        { time: 20, value: 80 },
        { time: 20, value: 20 },
        { time: 60, value: 50 },
      ],
      scope,
    );
    const geometry = buildDrawingGeometry(channel, adapter);
    expect(geometry.segments).toEqual([
      { from: { x: 20, y: 20 }, to: { x: 20, y: 80 } },
      { from: { x: 60, y: 20 }, to: { x: 60, y: 80 } },
    ]);
  });
  it('gives selected handles priority over later objects and honors pane/symbol visibility', () => {
    const selected = drawing('trend-line'),
      covering = drawing('rectangle');
    expect(
      hitTestDrawings([selected, covering], { x: 10, y: 20 }, adapter, { selectedId: selected.id }),
    ).toMatchObject({ id: selected.id, handleIndex: 0 });
    expect(hitTestDrawings([covering], { x: 30, y: 30 }, adapter)).toMatchObject({
      id: covering.id,
    });
    expect(hitTestDrawings([covering], { x: 30, y: 30 }, adapter, { paneId: 'rsi' })).toBeNull();
    expect(
      hitTestDrawings([{ ...covering, visible: false }], { x: 30, y: 30 }, adapter),
    ).toBeNull();
  });
  it('does not expose locked handles or select rays behind their start', () => {
    const line = drawing('horizontal-line');
    line.locked = true;
    expect(
      hitTestDrawings([line], { x: 10, y: 20 }, adapter, { selectedId: line.id })?.handleIndex,
    ).toBeUndefined();
    const ray = createDrawing(
      'ray',
      [
        { time: 40, value: 60 },
        { time: 60, value: 40 },
      ],
      scope,
    );
    expect(hitTestDrawings([ray], { x: 10, y: 10 }, adapter)).toBeNull();
  });
});

describe('drawing state and persistence', () => {
  it('undoes style, deletion and restoration while preserving drawing order', () => {
    const store = new DrawingStore(),
      first = drawing(),
      second = drawing('rectangle');
    store.add(first);
    store.add(second);
    store.update(first.id, { style: { color: '#ffffff', lineWidth: 4 } });
    store.remove(first.id);
    expect(store.getAll().map((d) => d.id)).toEqual([second.id]);
    store.undo();
    expect(store.getAll().map((d) => d.id)).toEqual([first.id, second.id]);
    expect(store.get(first.id)?.style.color).toBe('#ffffff');
    store.undo();
    expect(store.get(first.id)?.style.color).toBe(first.style.color);
    store.redo();
    expect(store.get(first.id)?.style.lineWidth).toBe(4);
    const restored = new DrawingStore();
    restored.restore(store.serialize());
    expect(restored.getAll()).toEqual(store.getAll());
    expect(restored.canUndo).toBe(false);
  });
  it('isolates external mutation, ignores no-ops, and clears redo after new edits', () => {
    const object = drawing(),
      store = new DrawingStore([object]);
    object.anchors[0].value = 0;
    store.getAll()[0].anchors[0].value = 999;
    expect(store.getAll()[0].anchors[0].value).toBe(80);
    store.update(object.id, { visible: true });
    expect(store.canUndo).toBe(false);
    store.update(object.id, { locked: true });
    store.undo();
    expect(store.canRedo).toBe(true);
    store.update(object.id, { visible: false });
    expect(store.canRedo).toBe(false);
  });
  it('rejects malformed/unknown documents atomically', () => {
    const object = drawing(),
      store = new DrawingStore([object]);
    expect(() => store.restore({ schemaVersion: 2, drawings: [] })).toThrow();
    expect(() =>
      store.restore({
        schemaVersion: 1,
        drawings: [{ ...object, anchors: [{ time: NaN, value: 1 }] }],
      }),
    ).toThrow();
    expect(() => store.restore({ schemaVersion: 1, drawings: [object, object] })).toThrow();
    expect(store.getAll()).toEqual([object]);
  });
  it('migrates version zero price anchors without mutating the input', () => {
    const { paneId: _, scaleId: __, ...object } = drawing();
    const legacy = {
      ...object,
      anchors: object.anchors.map(({ time, value }) => ({ time, price: value })),
    };
    const restored = deserializeDrawings({ schemaVersion: 0, drawings: [legacy] });
    expect(restored[0].paneId).toBe('price');
    expect(restored[0].anchors[0].value).toBe(80);
    expect(legacy.anchors[0]).toHaveProperty('price');
  });
  it('limits undo history and emits subscription updates', () => {
    const store = new DrawingStore([], 2);
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls++;
    });
    store.add(drawing());
    store.add(drawing());
    store.add(drawing());
    expect(calls).toBe(3);
    expect(store.undo()).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.undo()).toBe(false);
    expect(store.getAll()).toHaveLength(1);
    unsubscribe();
    store.clear();
    expect(calls).toBe(5);
  });
});

describe('pointer interactions', () => {
  it.each(DRAWING_TOOLS)('creates, serializes, and undoes %s', (type) => {
    const store = new DrawingStore(),
      interaction = new DrawingInteraction(
        store,
        () => adapter,
        () => scope,
      );
    interaction.setTool(type);
    expect(interaction.pointerDown({ x: 10, y: 20 })).toBe(true);
    interaction.pointerMove({ x: 70, y: 60 });
    expect(store.getAll()).toHaveLength(0);
    expect(interaction.getRenderDrawings()).toHaveLength(1);
    interaction.pointerUp();
    if (type === 'parallel-channel') {
      expect(interaction.active).toBe(true);
      interaction.pointerMove({ x: 30, y: 75 });
      interaction.pointerDown({ x: 30, y: 75 });
      interaction.pointerUp();
    }
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].type).toBe(type);
    expect(deserializeDrawings(store.serialize())).toEqual(store.getAll());
    store.undo();
    expect(store.getAll()).toHaveLength(0);
    expect(store.canUndo).toBe(false);
  });
  it('commits hundreds of drag moves as one reversible edit', () => {
    const object = drawing('rectangle'),
      store = new DrawingStore([object]),
      interaction = new DrawingInteraction(
        store,
        () => adapter,
        () => scope,
      );
    interaction.pointerDown({ x: 40, y: 40 });
    for (let i = 0; i < 200; i++) interaction.pointerMove({ x: 40 + i / 20, y: 40 + i / 20 });
    expect(store.getAll()[0].anchors).toEqual(object.anchors);
    interaction.pointerUp({ x: 50, y: 50 });
    expect(store.getAll()[0].anchors[0]).toEqual({ time: 20, value: 70 });
    store.undo();
    expect(store.getAll()[0].anchors).toEqual(object.anchors);
    expect(store.canUndo).toBe(false);
  });
  it('resizes a selected endpoint without moving its opposite endpoint', () => {
    const object = drawing(),
      store = new DrawingStore([object]);
    store.select(object.id);
    const interaction = new DrawingInteraction(
      store,
      () => adapter,
      () => scope,
    );
    interaction.pointerDown({ x: 70, y: 60 });
    interaction.pointerUp({ x: 85, y: 80 });
    expect(store.getAll()[0].anchors).toEqual([
      { time: 10, value: 80 },
      { time: 85, value: 20 },
    ]);
  });
  it('constrains horizontal and date-range edits to their relevant axes', () => {
    const horizontal = drawing('horizontal-line'),
      store = new DrawingStore([horizontal]);
    const interaction = new DrawingInteraction(
      store,
      () => adapter,
      () => scope,
    );
    interaction.pointerDown({ x: 50, y: 20 });
    interaction.pointerUp({ x: 70, y: 40 });
    expect(store.getAll()[0].anchors[0]).toEqual({ time: 10, value: 60 });
    const range = drawing('date-range');
    store.add(range);
    interaction.pointerDown({ x: 40, y: 50 });
    interaction.pointerUp({ x: 50, y: 65 });
    expect(store.get(range.id)?.anchors).toEqual([
      { time: 20, value: 80 },
      { time: 80, value: 40 },
    ]);
  });
  it('cancels a gesture without changing committed objects and ignores locked edits', () => {
    const object = drawing('rectangle'),
      store = new DrawingStore([object]),
      interaction = new DrawingInteraction(
        store,
        () => adapter,
        () => scope,
      );
    interaction.pointerDown({ x: 30, y: 30 });
    interaction.pointerMove({ x: 50, y: 50 });
    interaction.cancel();
    expect(store.getAll()).toEqual([object]);
    expect(store.canUndo).toBe(false);
    store.update(object.id, { locked: true });
    interaction.pointerDown({ x: 30, y: 30 });
    interaction.pointerMove({ x: 50, y: 50 });
    interaction.pointerUp();
    expect(store.getAll()[0].anchors).toEqual(object.anchors);
  });
  it('leaves empty-space gestures to chart panning and supports vertical channels', () => {
    const store = new DrawingStore(),
      interaction = new DrawingInteraction(
        store,
        () => adapter,
        () => scope,
      );
    expect(interaction.pointerDown({ x: 50, y: 50 })).toBe(false);
    interaction.setTool('parallel-channel');
    interaction.pointerDown({ x: 20, y: 20 });
    interaction.pointerUp({ x: 20, y: 80 });
    interaction.pointerDown({ x: 60, y: 50 });
    interaction.pointerUp();
    expect(store.getAll()[0].anchors).toEqual([
      { time: 20, value: 80 },
      { time: 20, value: 20 },
      { time: 60, value: 50 },
    ]);
  });
  it('moves drawings through the current log transform rather than adding raw price deltas', () => {
    const scale = createValueScale(10, 1000, 100, 'logarithmic'),
      logAdapter = { ...adapter, ...scale };
    const object = createDrawing(
      'rectangle',
      [
        { time: 10, value: 100 },
        { time: 70, value: 10 },
      ],
      scope,
    );
    const store = new DrawingStore([object]),
      interaction = new DrawingInteraction(
        store,
        () => logAdapter,
        () => scope,
      );
    interaction.pointerDown({ x: 40, y: 75 });
    interaction.pointerUp({ x: 45, y: 25 });
    const anchors = store.getAll()[0].anchors;
    expect(anchors[0].value).toBeCloseTo(1000);
    expect(anchors[1].value).toBeCloseTo(100);
  });
});
