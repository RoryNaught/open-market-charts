import { expect, it, vi } from 'vitest';
import { IndicatorWorkerClient, type IndicatorWorkerLike } from './worker-client';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';

class FakeWorker implements IndicatorWorkerLike {
  onmessage: IndicatorWorkerLike['onmessage'] = null;
  onerror: IndicatorWorkerLike['onerror'] = null;
  messages: WorkerRequest[] = [];
  terminate = vi.fn();
  postMessage(message: WorkerRequest) {
    this.messages.push(message);
  }
  result(generation: number, request: number) {
    this.onmessage?.(
      new MessageEvent<WorkerResponse>('message', {
        data: { type: 'result', generation, request, mode: 'reset', durationMs: 1, results: [] },
      }),
    );
  }
}
it('terminates stale backfills, ignores old and out-of-order responses, and disposes', () => {
  const workers: FakeWorker[] = [];
  const onResults = vi.fn();
  const client = new IndicatorWorkerClient({
    onResults,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  client.reset([], []);
  client.reset([], []);
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  workers[0].result(1, 1);
  expect(onResults).not.toHaveBeenCalled();
  workers[1].result(2, 2);
  expect(onResults).toHaveBeenCalledOnce();
  workers[1].result(2, 1);
  expect(onResults).toHaveBeenCalledOnce();
  client.dispose();
  workers[1].result(2, 3);
  expect(onResults).toHaveBeenCalledOnce();
  expect(workers[1].terminate).toHaveBeenCalledOnce();
});
it('transfers compact typed bars and reports current-generation errors', () => {
  const worker = new FakeWorker(),
    onError = vi.fn();
  const client = new IndicatorWorkerClient({
    onResults: () => {},
    onError,
    workerFactory: () => worker,
  });
  const bar = { time: 1_700_000_000_123, open: 10, high: 12, low: 9, close: 11, volume: 4 };
  client.reset([bar], []);
  client.update([bar, { ...bar, time: bar.time + 60_000 }]);
  const request = worker.messages[1];
  expect(request.type).toBe('update');
  if (request.type === 'update') {
    expect(request.bars).toBeInstanceOf(Float64Array);
    expect(request.bars.length).toBe(16);
  }
  worker.onmessage?.({
    data: { type: 'error', generation: 1, request: 2, message: 'Invalid configuration' },
  } as MessageEvent<WorkerResponse>);
  expect(onError.mock.calls[0][0].message).toBe('Invalid configuration');
});
it('does not paint queued old parameter results after indicator settings change', () => {
  const worker = new FakeWorker(),
    onResults = vi.fn();
  const client = new IndicatorWorkerClient({ onResults, workerFactory: () => worker });
  client.reset([], []);
  client.setIndicators([]);
  worker.result(1, 1);
  expect(onResults).not.toHaveBeenCalled();
  worker.result(1, 2);
  expect(onResults).toHaveBeenCalledOnce();
});
