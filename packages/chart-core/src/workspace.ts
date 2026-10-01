import { openDB } from 'idb';
import { z } from 'zod';
import { deserializeDrawings } from '@omc/drawing-engine';
import { defaultRegistry } from '@omc/indicator-engine';

const config = z.object({
  id: z.string().max(100),
  type: z.string().max(40),
  params: z.record(z.number().finite()),
  color: z
    .string()
    .regex(
      /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i,
      'Indicator color must be a hex color',
    ),
  pane: z.enum(['price', 'separate']),
});
const instrument = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  provider: z.string(),
  assetClass: z.enum(['crypto', 'stock', 'etf', 'index']),
  currency: z.string(),
  timezone: z
    .string()
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown exchange timezone'),
  pricePrecision: z.number().int().min(0).max(10),
  volumeUnit: z.string(),
  session: z.enum(['24x7', 'us-equities']),
});
export const workspaceSchema = z.object({
  version: z.literal(1),
  name: z.string().max(100),
  instrument,
  timeframe: z.enum(['1m', '5m', '15m', '1h', '1D', '1W']),
  session: z.enum(['regular', 'extended']),
  chartType: z.enum(['candles', 'bars', 'line', 'area', 'heikin-ashi']),
  scale: z.enum(['linear', 'log', 'percentage']),
  indicators: z
    .array(config)
    .max(30)
    .superRefine((configs, ctx) => {
      if (new Set(configs.map((c) => c.id)).size !== configs.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate indicator IDs' });
      for (const c of configs)
        try {
          defaultRegistry.normalize(c);
        } catch (error) {
          ctx.addIssue({ code: 'custom', message: String(error) });
        }
    })
    .transform((configs) => configs.map((c) => defaultRegistry.normalize(c))),
  drawings: z.unknown().superRefine((value, ctx) => {
    try {
      deserializeDrawings(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid drawing document' });
    }
  }),
  watchlist: z.array(instrument).max(100),
  paneHeights: z.array(z.number().min(30).max(5000)).max(40).default([]),
  leftScale: z.boolean().optional(),
  showWatchlist: z.boolean().default(true),
  volume: z.boolean().default(true),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export type ChartType = Workspace['chartType'];
export type ScaleMode = Workspace['scale'];
export function parseWorkspace(text: string): Workspace {
  if (text.length > 5_000_000) throw new Error('Workspace exceeds the 5 MB limit');
  return workspaceSchema.parse(JSON.parse(text));
}
export class WorkspaceRepository {
  private database = openDB('open-market-charts', 1, {
    upgrade(db) {
      db.createObjectStore('workspace');
    },
  });
  async load(): Promise<Workspace | null> {
    const db = await this.database;
    for (const key of ['current', 'backup']) {
      const value = await db.get('workspace', key);
      if (value) {
        const parsed = workspaceSchema.safeParse(value);
        if (parsed.success) return parsed.data;
      }
    }
    return null;
  }
  async save(workspace: Workspace) {
    const safe = workspaceSchema.parse(workspace);
    const db = await this.database;
    const tx = db.transaction('workspace', 'readwrite');
    const previous = await tx.store.get('current');
    if (workspaceSchema.safeParse(previous).success) await tx.store.put(previous, 'backup');
    await tx.store.put(safe, 'current');
    await tx.done;
  }
  async close() {
    (await this.database).close();
  }
}
