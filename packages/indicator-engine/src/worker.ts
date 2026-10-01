import { IndicatorEngine, unpackBars } from './engine';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};
let engine = new IndicatorEngine();
let activeGeneration = 0;
scope.onmessage = ({ data }) => {
  const started = performance.now();
  try {
    if (data.type === 'reset') {
      activeGeneration = data.generation;
      engine = new IndicatorEngine(data.configs, data.context);
      engine.setData(unpackBars(data.bars));
    } else if (data.generation !== activeGeneration) return;
    let mode: 'reset' | 'update' = 'reset';
    let from: number | undefined;
    if (data.type === 'update') {
      mode = 'update';
      from = Infinity;
      for (const bar of unpackBars(data.bars)) {
        engine.updateBar(bar);
        from = Math.min(from, engine.lastChangedFrom);
        if (engine.lastChange === 'reset') mode = 'reset';
      }
    } else if (data.type === 'indicators') engine.setIndicators(data.configs);
    else if (data.type === 'range') {
      engine.setVisibleRange(data.from, data.to);
      mode = 'update';
    }
    const results = engine.getPackedResults(
      mode === 'update',
      data.type === 'update' && mode === 'update' ? from : undefined,
    );
    // A profile viewport change must not emit unrelated series points.
    const filtered = data.type === 'range' ? results.filter((result) => result.profile) : results;
    scope.postMessage(
      {
        type: 'result',
        generation: data.generation,
        request: data.request,
        mode,
        results: filtered,
        durationMs: performance.now() - started,
      },
      filtered.flatMap((result) =>
        result.outputs.map((output) => output.values.buffer as ArrayBuffer),
      ),
    );
  } catch (error) {
    scope.postMessage({
      type: 'error',
      generation: data.generation,
      request: data.request,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
