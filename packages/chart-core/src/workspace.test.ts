import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { parseWorkspace, WorkspaceRepository, type Workspace } from './workspace';
const workspace: Workspace = {
  version: 1,
  name: 'test',
  instrument: {
    id: 'test:A',
    symbol: 'A',
    name: 'A',
    provider: 'test',
    assetClass: 'crypto',
    currency: 'USD',
    timezone: 'UTC',
    pricePrecision: 2,
    volumeUnit: 'A',
    session: '24x7',
  },
  timeframe: '1m',
  session: 'regular',
  chartType: 'candles',
  scale: 'linear',
  indicators: [],
  drawings: { schemaVersion: 1, drawings: [] },
  watchlist: [],
  paneHeights: [],
  showWatchlist: true,
  volume: true,
};
describe('workspace portability', () => {
  it('restores fixed anchors and normalizes annotation-only studies onto the price pane', () => {
    const anchorTime = Date.UTC(2026, 8, 30, 12);
    const restored = parseWorkspace(
      JSON.stringify({
        ...workspace,
        indicators: [
          {
            id: 'anchor',
            type: 'AnchoredVWAP',
            params: { anchorTime },
            color: '#aabbcc',
            pane: 'price',
          },
          { id: 'gaps', type: 'FairValueGaps', params: {}, color: '#aabbcc', pane: 'separate' },
        ],
      }),
    );
    expect(restored.indicators[0].params).toEqual({ anchorTime, bands1: 1, bands2: 2 });
    expect(restored.indicators[1].pane).toBe('price');
    expect(restored.indicators[1].params.maxAnnotations).toBe(100);
  });
  it('rejects timezone and color values that would fail in the chart adapter', () => {
    expect(() =>
      parseWorkspace(
        JSON.stringify({
          ...workspace,
          instrument: { ...workspace.instrument, timezone: 'Invalid/Clock' },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseWorkspace(
        JSON.stringify({
          ...workspace,
          indicators: [
            { id: 'sma', type: 'SMA', params: { period: 20 }, color: 'not-a-color', pane: 'price' },
          ],
        }),
      ),
    ).toThrow();
  });
  it('validates before replacing local state', () => {
    expect(parseWorkspace(JSON.stringify(workspace))).toEqual(workspace);
    expect(() => parseWorkspace(JSON.stringify({ ...workspace, version: 99 }))).toThrow();
    expect(() => parseWorkspace(JSON.stringify({ ...workspace, drawings: {} }))).toThrow();
    expect(() =>
      parseWorkspace(
        JSON.stringify({
          ...workspace,
          indicators: [{ id: 'x', type: 'unknown', params: {}, color: 'red', pane: 'price' }],
        }),
      ),
    ).toThrow();
  });
  it('saves and restores versioned browser data', async () => {
    const repo = new WorkspaceRepository();
    await repo.save(workspace);
    await repo.save({ ...workspace, name: 'second' });
    expect((await repo.load())?.name).toBe('second');
    await repo.close();
  });
  it('strips credentials from imported snapshots', () => {
    const restored = parseWorkspace(
      JSON.stringify({ ...workspace, apiKey: 'secret', gatewayToken: 'secret' }),
    );
    expect(restored).not.toHaveProperty('apiKey');
    expect(JSON.stringify(restored)).not.toContain('secret');
  });
});
