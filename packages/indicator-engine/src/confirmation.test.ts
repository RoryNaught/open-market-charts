import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bar } from '@omc/provider-sdk';
import { IndicatorEngine, packBars, unpackResults } from './engine';
import { IndicatorRegistry } from './registry';
import type { IndicatorAnnotation, IndicatorDefinition } from './types';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';

const firstTime = Date.UTC(2026, 0, 1);
const makeBar = (index: number, closed?: boolean): Bar => ({
  time: firstTime + index * 60_000,
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: 2,
  ...(closed === undefined ? {} : { closed }),
});
const config = {
  id: 'confirmed',
  type: 'ConfirmedCounter',
  params: {},
  color: '#112233',
  pane: 'price' as const,
};
const definition: IndicatorDefinition = {
  type: config.type,
  name: 'Confirmation test',
  version: 1,
  pane: 'price',
  parameters: {},
  outputs: [{ key: 'value', kind: 'line', gaps: true }],
  create() {
    let count = 0,
      color: string | undefined;
    let annotations: IndicatorAnnotation[] = [];
    return {
      step(bar, _index, context) {
        if (!context?.isConfirmed) {
          color = undefined;
          return {};
        }
        count++;
        color = count % 2 ? '#112233' : '#aabbcc';
        annotations.push({
          id: `closed-${bar.time}`,
          kind: 'marker',
          time: bar.time,
          price: bar.close,
          text: String(count),
          color,
          confirmedAt: bar.time,
        });
        annotations = annotations.slice(-5);
        return { value: count };
      },
      colors: () => ({ value: color }),
      annotations: () => annotations,
      snapshot: () => ({ count, color, annotations: structuredClone(annotations) }),
      restore(snapshot) {
        const saved = snapshot as {
          count: number;
          color?: string;
          annotations: IndicatorAnnotation[];
        };
        count = saved.count;
        color = saved.color;
        annotations = structuredClone(saved.annotations);
      },
    };
  },
};
function makeEngine() {
  const registry = new IndicatorRegistry();
  registry.register(definition);
  return new IndicatorEngine([config], {}, registry);
}
afterEach(() => vi.unstubAllGlobals());

describe('confirmation, gaps, and colored output lifecycle', () => {
  it('creates distinct instance IDs after reloading the module with persisted instances', async () => {
    const original = await import('./engine');
    const persisted = original.createIndicatorConfig('SMA');
    vi.resetModules();
    const reloaded = await import('./engine');
    const added = reloaded.createIndicatorConfig('SMA');
    expect(added.id).not.toBe(persisted.id);
    expect(() => new reloaded.IndicatorEngine([persisted, added])).not.toThrow();
    expect(reloaded.createIndicatorConfig('SMA', 'explicit-instance').id).toBe('explicit-instance');
  });
  it('confirms historical bars while the unknown final bar remains provisional', () => {
    const engine = makeEngine();
    engine.setData([makeBar(0), makeBar(1), makeBar(2)]);
    const result = engine.getResults()[0];
    expect(result.outputs[0].values.map((point) => point.value)).toEqual([1, 2, NaN]);
    expect(result.outputs[0].values.map((point) => point.color)).toEqual([
      '#112233',
      '#aabbcc',
      undefined,
    ]);
    expect(result.annotations?.map((annotation) => annotation.time)).toEqual([
      firstTime,
      firstTime + 60_000,
    ]);
  });
  it('finalizes a forming bar exactly once at rollover and includes both changed timestamps', () => {
    const engine = makeEngine();
    engine.setData([makeBar(0, false)]);
    for (let i = 0; i < 10; i++) engine.updateBar(makeBar(0, false));
    expect(engine.getResults()[0].annotations).toEqual([]);
    const changes = engine.update(makeBar(1));
    expect(engine.lastChangedFrom).toBe(firstTime);
    expect(changes[0].outputs[0].values).toEqual([
      { time: firstTime, value: 1, color: '#112233' },
      { time: firstTime + 60_000, value: NaN },
    ]);
    expect(changes[0].annotations).toHaveLength(1);
    engine.updateBar(makeBar(1, true));
    engine.updateBar(makeBar(1));
    engine.updateBar(makeBar(2));
    expect(engine.getResults()[0].outputs[0].values.map((point) => point.value)).toEqual([
      1,
      2,
      NaN,
    ]);
    expect(engine.getResults()[0].annotations).toHaveLength(2);
  });
  it('preserves gaps, colors, and detached annotation snapshots in packed results', () => {
    const engine = makeEngine();
    engine.setData([makeBar(0), makeBar(1)]);
    const result = unpackResults(engine.getPackedResults())[0];
    expect(result.outputs[0].gaps).toBe(true);
    expect(Number.isNaN(result.outputs[0].values[1].value)).toBe(true);
    result.annotations![0].text = 'changed outside engine';
    expect(engine.getResults()[0].annotations![0].text).toBe('1');
    engine.updateBar(makeBar(2));
    const delta = unpackResults(engine.getPackedResults(false, engine.lastChangedFrom))[0];
    expect(delta.outputs[0].values.map((point) => point.time)).toEqual([
      firstTime + 60_000,
      firstTime + 120_000,
    ]);
    expect(delta.outputs[0].values[0].color).toBe('#aabbcc');
  });
  it('matches full rebuilds after live closure, historical correction, and prepend', () => {
    const engine = makeEngine();
    engine.setData([makeBar(3), makeBar(4)]);
    for (let i = 5; i < 10; i++) engine.updateBar(makeBar(i));
    engine.prepend([makeBar(0), makeBar(1), makeBar(2)]);
    const batch = makeEngine();
    const bars = Array.from({ length: 10 }, (_, index) => makeBar(index));
    batch.setData(bars);
    expect(engine.getResults()).toEqual(batch.getResults());
    engine.updateBar({ ...makeBar(6), close: 12 });
    bars[6].close = 12;
    batch.setData(bars);
    expect(engine.getResults()).toEqual(batch.getResults());
    expect(engine.getResults()[0].annotations).toHaveLength(5);
  });
  it('keeps annotation-only definitions on the price pane', () => {
    const registry = new IndicatorRegistry();
    registry.register({ ...definition, type: 'AnnotationsOnly', outputs: [] });
    expect(registry.normalize({ ...config, type: 'AnnotationsOnly', pane: 'separate' }).pane).toBe(
      'price',
    );
  });
  it('worker protocol preserves closure, gap points, colors, annotations and ignores stale generations', async () => {
    vi.resetModules();
    const { defaultRegistry } = await import('./engine');
    const unregister = defaultRegistry.register(definition);
    const messages: WorkerResponse[] = [];
    const scope = {
      onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
      postMessage: (message: WorkerResponse) => messages.push(message),
    };
    vi.stubGlobal('self', scope);
    await import('./worker');
    const send = (data: WorkerRequest) => scope.onmessage!(new MessageEvent('message', { data }));
    send({
      type: 'reset',
      generation: 2,
      request: 1,
      bars: packBars([makeBar(0, false)]),
      configs: [config],
      context: {},
    });
    send({ type: 'update', generation: 1, request: 2, bars: packBars([makeBar(1)]) });
    expect(messages).toHaveLength(1);
    send({ type: 'update', generation: 2, request: 3, bars: packBars([makeBar(1, false)]) });
    const response = messages.at(-1)!;
    expect(response.type).toBe('result');
    if (response.type === 'result') {
      const result = unpackResults(response.results)[0];
      expect(response.mode).toBe('update');
      expect(result.outputs[0].values.map((point) => point.value)).toEqual([1, NaN]);
      expect(result.outputs[0].values[0].color).toBe('#112233');
      expect(result.annotations).toHaveLength(1);
      expect(result.annotations![0].confirmedAt).toBe(firstTime);
    }
    unregister();
  });
});
