import type { IndicatorDefinition } from './types';

/** Example community plugin: the range of each candle, in price units. */
export const candleRangePlugin: IndicatorDefinition = {
  type: 'CommunityCandleRange',
  name: 'Candle range',
  version: 1,
  pane: 'separate',
  parameters: {},
  outputs: [{ key: 'range', kind: 'histogram' }],
  create: () => ({
    step: (bar) => ({ range: bar.high - bar.low }),
    snapshot: () => null,
    restore: () => {},
  }),
};
