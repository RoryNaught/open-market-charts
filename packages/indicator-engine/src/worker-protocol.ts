import type { IndicatorConfig, IndicatorContext, PackedIndicatorResult } from './types';

export type WorkerRequest = { generation: number; request: number } & (
  | { type: 'reset'; bars: Float64Array; configs: IndicatorConfig[]; context: IndicatorContext }
  | { type: 'update'; bars: Float64Array }
  | { type: 'indicators'; configs: IndicatorConfig[] }
  | { type: 'range'; from: number; to: number }
);
export type WorkerResponse = { generation: number; request: number } & (
  | {
      type: 'result';
      mode: 'reset' | 'update';
      results: PackedIndicatorResult[];
      durationMs: number;
    }
  | { type: 'error'; message: string }
);
