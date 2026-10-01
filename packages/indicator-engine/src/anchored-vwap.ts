import type { IndicatorDefinition, IndicatorStatus } from './types';

/** Original implementation of the public anchored volume-weighted mean and variance formulas. */
export const anchoredVwapDefinition: IndicatorDefinition = {
  type: 'AnchoredVWAP',
  name: 'Anchored VWAP + deviation bands',
  version: 1,
  category: 'advanced',
  description:
    'Choose a candle to anchor volume-weighted HLC3 and population deviation bands. A fixed time anchor survives panning and pagination.',
  pane: 'price',
  parameters: {
    anchorTime: { default: 0, min: 0, max: 8_640_000_000_000_000, integer: true },
    bands1: { default: 1, min: 0, max: 10 },
    bands2: { default: 2, min: 0, max: 10 },
  },
  outputs: [
    { key: 'vwap', kind: 'line' },
    { key: 'upper1', kind: 'line', color: '#82b8d9' },
    { key: 'lower1', kind: 'line', color: '#82b8d9' },
    { key: 'upper2', kind: 'line', color: '#697ca9' },
    { key: 'lower2', kind: 'line', color: '#697ca9' },
  ],
  create(params) {
    let state = {
      firstTime: undefined as number | undefined,
      latestTime: undefined as number | undefined,
      weight: 0,
      mean: 0,
      m2: 0,
    };
    const status = (): IndicatorStatus | undefined => {
      if (params.anchorTime === 0)
        return { state: 'needs-input', message: 'Choose an anchor candle.' };
      if (state.firstTime !== undefined && params.anchorTime < state.firstTime)
        return {
          state: 'incomplete',
          message: 'Load history back to the anchor to calculate Anchored VWAP.',
        };
      if (state.latestTime !== undefined && params.anchorTime > state.latestTime)
        return { state: 'incomplete', message: 'The anchor is beyond the loaded history.' };
      return undefined;
    };
    return {
      step(bar) {
        state.firstTime ??= bar.time;
        state.latestTime = bar.time;
        if (
          !params.anchorTime ||
          params.anchorTime < state.firstTime ||
          bar.time < params.anchorTime
        )
          return {};
        if (bar.volume > 0) {
          const price = (bar.high + bar.low + bar.close) / 3;
          const totalWeight = state.weight + bar.volume;
          const delta = price - state.mean;
          state.mean += delta * (bar.volume / totalWeight);
          state.m2 += bar.volume * delta * (price - state.mean);
          state.weight = totalWeight;
        }
        if (state.weight === 0) return {};
        const deviation = Math.sqrt(Math.max(0, state.m2) / state.weight);
        return {
          vwap: state.mean,
          upper1: state.mean + params.bands1 * deviation,
          lower1: state.mean - params.bands1 * deviation,
          upper2: state.mean + params.bands2 * deviation,
          lower2: state.mean - params.bands2 * deviation,
        };
      },
      snapshot: () => ({ ...state }),
      restore: (snapshot) => {
        state = { ...(snapshot as typeof state) };
      },
      status,
    };
  },
};
