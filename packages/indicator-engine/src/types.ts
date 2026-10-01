import type { Bar, SessionInterval } from '@omc/provider-sdk';

export interface IndicatorConfig {
  id: string;
  type: string;
  params: Record<string, number>;
  color: string;
  pane: 'price' | 'separate';
}
export interface IndicatorPoint {
  time: number;
  /** NaN is an explicit whitespace point for outputs declaring gaps: true. */
  value: number;
  color?: string;
}
export interface IndicatorOutput {
  key: string;
  color?: string;
  kind: 'line' | 'histogram';
  gaps?: boolean;
  values: IndicatorPoint[];
}
export interface IndicatorAnnotation {
  id: string;
  kind: 'level' | 'zone' | 'marker';
  time: number;
  endTime?: number;
  price: number;
  price2?: number;
  text: string;
  color: string;
  originTime?: number;
  /** Open timestamp of the candle whose CLOSE confirmed the event, not the availability instant. */
  confirmedAt: number;
  status?: 'active' | 'touched' | 'filled';
}
export interface IndicatorStatus {
  state: 'needs-input' | 'incomplete';
  message: string;
}
export interface IndicatorStepContext {
  isConfirmed: boolean;
}
export interface VolumeProfile {
  bins: Array<{ low: number; high: number; volume: number }>;
  pointOfControl: number | null;
  estimated: true;
  totalVolume: number;
}
export interface IndicatorResult {
  id: string;
  type: string;
  outputs: IndicatorOutput[];
  profile?: VolumeProfile;
  annotations?: IndicatorAnnotation[];
  status?: IndicatorStatus;
}
export interface IndicatorContext {
  timezone?: string;
  sessions?: readonly SessionInterval[];
  vwapAnchor?: 'session' | 'week' | 'month';
  volumeProfileRange?: { from: number; to: number };
}
export interface IndicatorParameter {
  default: number;
  min: number;
  max: number;
  integer?: boolean;
}
/** Kernels are deterministic and renderer independent. Snapshots must not share mutable state. */
export interface IndicatorKernel {
  step(
    bar: Readonly<Bar>,
    index: number,
    context?: IndicatorStepContext,
  ): Record<string, number | undefined>;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
  colors?(): Record<string, string | undefined>;
  annotations?(): IndicatorAnnotation[];
  status?(): IndicatorStatus | undefined;
}
export interface IndicatorDefinition {
  type: string;
  name: string;
  version: number;
  category?: 'standard' | 'advanced';
  description?: string;
  pane: 'price' | 'separate';
  parameters: Record<string, IndicatorParameter>;
  outputs: Array<{ key: string; kind: 'line' | 'histogram'; color?: string; gaps?: boolean }>;
  create(
    params: Readonly<Record<string, number>>,
    context: Readonly<IndicatorContext>,
  ): IndicatorKernel;
}
export interface PackedIndicatorResult {
  id: string;
  type: string;
  outputs: Array<{
    key: string;
    color?: string;
    kind: 'line' | 'histogram';
    gaps?: boolean;
    values: Float64Array;
    colors?: Array<string | undefined>;
  }>;
  profile?: VolumeProfile;
  annotations?: IndicatorAnnotation[];
  status?: IndicatorStatus;
}
