import { test as base, expect, type Page, type WebSocketRoute } from '@playwright/test';
import type {
  CoordinateAdapter,
  Drawing,
  DrawingInteraction,
  DrawingStore,
} from '@omc/drawing-engine';
import type { Bar, SessionInterval } from '@omc/provider-sdk';
import type { IndicatorAnnotation, IndicatorWorkerClient } from '@omc/indicator-engine';
import type { ChartRenderer } from '@omc/chart-renderer';

interface InspectRuntime {
  drawings: DrawingStore;
  interaction: DrawingInteraction;
  session: {
    store: { bars: Bar[]; last?: Bar; length: number; reset(bars: readonly Bar[]): void };
    state: { loading: boolean; status: string };
    dispose(): void;
  };
  refreshSessions(sessions: SessionInterval[]): void;
  worker: Pick<IndicatorWorkerClient, 'reset' | 'update'>;
  renderer: {
    adapter(paneId?: string): CoordinateAdapter;
    getPaneHeights(): number[];
    getBarCount(): number;
    getIndicatorAnnotations(paneId?: string): IndicatorAnnotation[];
    setBars(
      bars: readonly Bar[],
      change: 'reset' | 'update' | 'prepend',
      changed?: readonly Bar[],
    ): void;
    chart: ChartRenderer['chart'];
    annotationAt(x: number, y: number, paneId: string): IndicatorAnnotation | undefined;
  };
}
declare global {
  interface Window {
    __OMC?: InspectRuntime;
  }
}

export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      // UI tests are independent of font-provider availability.
      await page.route('https://fonts.googleapis.com/**', (route) =>
        route.fulfill({ contentType: 'text/css', body: '' }),
      );
      await use(errors);
      expect(errors, 'Uncaught errors in the browser').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export async function openSimulator(page: Page): Promise<void> {
  await page.goto('/?dev=1');
  await expect(page.locator('.feed-status')).toHaveText('SIMULATED');
  await expect
    .poll(() => page.evaluate(() => window.__OMC?.session.store.length ?? 0))
    .toBeGreaterThanOrEqual(900);
  await expect(page.locator('.chart-message')).toHaveCount(0);
}

export async function drawings(page: Page): Promise<Drawing[]> {
  return page.evaluate(() => window.__OMC!.drawings.getAll());
}

export async function chartPoints(
  page: Page,
  start = { x: 0.28, y: 0.3 },
  end = { x: 0.63, y: 0.57 },
) {
  const bounds = await page.getByTestId('chart').boundingBox();
  if (!bounds) throw new Error('Chart has no bounding box');
  const size = await page.evaluate(() => {
    const a = window.__OMC!.renderer.adapter('price');
    return { width: a.width, height: a.height };
  });
  return {
    start: { x: bounds.x + size.width * start.x, y: bounds.y + size.height * start.y },
    end: { x: bounds.x + size.width * end.x, y: bounds.y + size.height * end.y },
    bounds,
    size,
  };
}

export async function dragDrawing(page: Page, label = 'Trend line'): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click();
  const { start, end } = await chartPoints(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  if (label === 'Parallel channel') await page.mouse.click(end.x - 20, end.y + 45);
  await page.getByRole('button', { name: 'Select / pan', exact: true }).click();
}

/** Mock the real Coinbase transport; application code still uses CoinbaseProvider. */
export async function mockCoinbase(page: Page, failHistory = false) {
  const sockets = new Set<WebSocketRoute>();
  let tradeId = 1000;
  const products = [
    {
      id: 'BTC-USD',
      base_currency: 'BTC',
      quote_currency: 'USD',
      quote_increment: '0.01',
      status: 'online',
      display_name: 'Bitcoin / US Dollar',
    },
    {
      id: 'ETH-USD',
      base_currency: 'ETH',
      quote_currency: 'USD',
      quote_increment: '0.01',
      status: 'online',
      display_name: 'Ethereum / US Dollar',
    },
  ];
  await page.route('https://api.exchange.coinbase.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/candles')) {
      if (failHistory)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Fixture exchange unavailable' }),
        });
      const start = Date.parse(url.searchParams.get('start')!) / 1000,
        end = Date.parse(url.searchParams.get('end')!) / 1000,
        interval = Number(url.searchParams.get('granularity'));
      const rows: number[][] = [];
      for (let time = start; time < end; time += interval) {
        const offset = Math.sin(time / 36000) * 300;
        rows.push([time, 59950 + offset, 60150 + offset, 60000 + offset, 60100 + offset, 12]);
      }
      return route.fulfill({ json: rows.reverse() });
    }
    if (url.pathname.endsWith('/trades'))
      return route.fulfill({
        json: [{ trade_id: tradeId, time: new Date().toISOString(), price: '60100', size: '0.25' }],
      });
    if (url.pathname === '/products') return route.fulfill({ json: products });
    return route.fulfill({ status: 404, json: { message: 'Unknown fixture endpoint' } });
  });
  await page.routeWebSocket('wss://ws-feed.exchange.coinbase.com/**', (socket) => {
    sockets.add(socket);
    socket.onMessage(() =>
      socket.send(
        JSON.stringify({
          type: 'subscriptions',
          channels: [{ name: 'matches', product_ids: ['BTC-USD'] }],
        }),
      ),
    );
    socket.onClose(() => {
      sockets.delete(socket);
    });
  });
  return {
    get openSockets() {
      return sockets.size;
    },
    sendTrade(price: number) {
      for (const socket of sockets)
        socket.send(
          JSON.stringify({
            type: 'match',
            trade_id: ++tradeId,
            product_id: 'BTC-USD',
            time: new Date().toISOString(),
            price: String(price),
            size: '0.5',
          }),
        );
    },
  };
}
