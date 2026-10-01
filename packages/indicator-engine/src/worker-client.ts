import type { Bar } from '@omc/provider-sdk';
import { packBars, unpackResults } from './engine';
import type { IndicatorConfig, IndicatorContext, IndicatorResult } from './types';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';

export interface IndicatorWorkerLike {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}
export interface IndicatorWorkerOptions {
  onResults(results: IndicatorResult[], mode: 'reset' | 'update'): void;
  onError?(error: Error): void;
  onMetrics?(metrics: { durationMs: number; mode: 'reset' | 'update' }): void;
  workerFactory?: () => IndicatorWorkerLike;
}
/** Reset terminates obsolete backfills; generation checks also reject already queued old messages. */
export class IndicatorWorkerClient {
  private worker?: IndicatorWorkerLike;
  private generation = 0;
  private request = 0;
  private lastResponse = -1;
  private disposed = false;
  constructor(private readonly options: IndicatorWorkerOptions) {}
  private makeWorker() {
    const generation = this.generation;
    const worker =
      this.options.workerFactory?.() ??
      new Worker(new URL('./worker.ts', import.meta.url), {
        type: 'module',
        name: 'market-indicators',
      });
    worker.onmessage = ({ data }) => {
      if (
        this.disposed ||
        generation !== this.generation ||
        data.generation !== this.generation ||
        data.request <= this.lastResponse
      )
        return;
      this.lastResponse = data.request;
      if (data.type === 'error') {
        this.options.onError?.(new Error(data.message));
        return;
      }
      this.options.onMetrics?.({ durationMs: data.durationMs, mode: data.mode });
      this.options.onResults(unpackResults(data.results), data.mode);
    };
    worker.onerror = (event) => {
      if (!this.disposed && generation === this.generation)
        this.options.onError?.(new Error(event.message));
    };
    this.worker = worker;
  }
  reset(
    bars: readonly Bar[],
    configs: readonly IndicatorConfig[],
    context: IndicatorContext = {},
  ): void {
    if (this.disposed) return;
    this.worker?.terminate();
    this.generation++;
    this.lastResponse = -1;
    this.makeWorker();
    const packed = packBars(bars);
    this.worker!.postMessage(
      {
        type: 'reset',
        generation: this.generation,
        request: ++this.request,
        bars: packed,
        configs: [...configs],
        context,
      },
      [packed.buffer],
    );
  }
  update(input: Bar | readonly Bar[]): void {
    if (this.disposed || !this.worker) return;
    const bars = Array.isArray(input) ? (input as readonly Bar[]) : [input as Bar];
    if (!bars.length) return;
    const packed = packBars(bars);
    this.worker.postMessage(
      { type: 'update', generation: this.generation, request: ++this.request, bars: packed },
      [packed.buffer],
    );
  }
  setIndicators(configs: readonly IndicatorConfig[]): void {
    if (this.disposed || !this.worker) return;
    const request = ++this.request;
    // The UI has already replaced its series/configuration; old-config results no longer apply.
    this.lastResponse = request - 1;
    this.worker.postMessage({
      type: 'indicators',
      generation: this.generation,
      request,
      configs: [...configs],
    });
  }
  setVisibleRange(from: number, to: number): void {
    if (this.disposed || !this.worker) return;
    this.worker.postMessage({
      type: 'range',
      generation: this.generation,
      request: ++this.request,
      from,
      to,
    });
  }
  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = undefined;
  }
}
