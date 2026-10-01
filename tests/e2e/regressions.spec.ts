import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { Workspace } from '@omc/chart-core';
import { test, expect, mockCoinbase, openSimulator, chartPoints, drawings } from './fixtures';

async function exportWorkspace(page: Page): Promise<Workspace> {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export workspace' }).click();
  const file = await (await event).path();
  if (!file) throw new Error('Workspace download missing');
  return JSON.parse(await readFile(file, 'utf8')) as Workspace;
}
async function importWorkspace(page: Page, workspace: Workspace): Promise<void> {
  await page.locator('input[type=file]').setInputFiles({
    name: 'regression-workspace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(workspace)),
  });
  await expect(page.getByRole('status')).toContainText('Workspace restored.');
}

test('clears candles and closes the old stream when an imported provider is unavailable', async ({
  page,
}) => {
  const exchange = await mockCoinbase(page);
  await page.goto('/');
  await expect(page.locator('.feed-status')).toHaveText('LIVE');
  await expect(page.locator('footer')).toContainText('900 bars');
  expect(await page.evaluate(() => '__OMC' in window)).toBe(false);
  const workspace = await exportWorkspace(page);
  workspace.instrument = {
    id: 'alpaca:SPY',
    symbol: 'SPY',
    name: 'SPDR S&P 500 ETF',
    provider: 'alpaca',
    assetClass: 'etf',
    currency: 'USD',
    timezone: 'America/New_York',
    pricePrecision: 2,
    volumeUnit: 'shares',
    session: 'us-equities',
  };
  await importWorkspace(page, workspace);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('SPDR S&P 500 ETF');
  await expect(page.locator('footer')).toContainText('0 bars');
  await expect(page.locator('.feed-status')).toHaveText('OFFLINE');
  await expect(page.locator('.current-price')).toContainText('—');
  await expect.poll(() => exchange.openSockets).toBe(0);
  const oldSeriesColors = [
    '#39c6a4',
    '#ed7183',
    ...workspace.indicators.map((indicator) => indicator.color),
  ].map((color) => [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
  ]);
  // A disconnected provider must leave no old candle or indicator pixels under its new symbol.
  await expect
    .poll(() =>
      page.getByTestId('chart').evaluate((host, colors) => {
        let coloredPixels = 0;
        for (const canvas of host.querySelectorAll('canvas')) {
          const ctx = canvas.getContext('2d');
          if (!ctx || !canvas.width || !canvas.height) continue;
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let i = 0; i < pixels.length; i += 4)
            if (
              colors.some(
                ([red, green, blue]) =>
                  pixels[i] === red && pixels[i + 1] === green && pixels[i + 2] === blue,
              )
            )
              coloredPixels++;
        }
        return coloredPixels;
      }, oldSeriesColors),
    )
    .toBe(0);
  exchange.sendTrade(65000);
  await expect(page.locator('.current-price')).toContainText('—');
});

test('reconnects the stock provider when Connect is used again for the same instrument', async ({
  page,
}) => {
  const barsRequests: string[] = [];
  const websocketConnections: string[] = [];
  await page.clock.setFixedTime(new Date('2026-09-30T15:00:00Z'));
  await page.route(/http:\/\/127\.0\.0\.1:878[78]\/api\//, (route) => {
    const url = new URL(route.request().url());
    if (
      url.pathname === '/api/calendar' ||
      url.pathname === '/api/minutes' ||
      url.pathname === '/api/symbols'
    )
      return route.fulfill({ json: [] });
    if (url.pathname === '/api/bars') {
      barsRequests.push(url.origin);
      const close = url.port === '8787' ? 601 : 701;
      return route.fulfill({
        json: {
          bars: [
            {
              time: Date.parse('2026-09-30T14:55:00Z'),
              open: close - 1,
              high: close + 1,
              low: close - 2,
              close,
              volume: 100,
            },
          ],
          hasMore: false,
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.routeWebSocket(/ws:\/\/127\.0\.0\.1:878[78]\/stream/, (socket) => {
    websocketConnections.push(socket.url());
    socket.onMessage(() => socket.send(JSON.stringify({ type: 'ready' })));
  });
  await openSimulator(page);
  await page.getByRole('button', { name: 'Feed settings', exact: true }).click();
  await page.getByRole('button', { name: 'Connect stock feed', exact: true }).click();
  await expect(page.locator('.current-price')).toContainText('601.00');
  await page.getByRole('button', { name: 'Feed settings', exact: true }).click();
  await page.getByLabel('Gateway URL').fill('http://127.0.0.1:8788');
  await page.getByRole('button', { name: 'Connect stock feed', exact: true }).click();
  await expect(page.locator('.current-price')).toContainText('701.00');
  expect(barsRequests).toContain('http://127.0.0.1:8788');
  expect(websocketConnections).toContain('ws://127.0.0.1:8788/stream');
  await expect(page.locator('.feed-status')).toHaveText('LIVE');
});

test('applies imported pane heights and restores a workspace with zero indicators', async ({
  page,
}) => {
  await openSimulator(page);
  await page.getByRole('button', { name: 'Remove EMA', exact: true }).click();
  await expect(page.getByText('Price chart', { exact: true })).toBeVisible();
  const heights = await page.evaluate(() => window.__OMC!.renderer.getPaneHeights());
  const expected = [heights[0] - 120, heights[1] + 120].map(Math.round);
  const workspace = await exportWorkspace(page);
  workspace.indicators = [];
  workspace.paneHeights = expected;
  await importWorkspace(page, workspace);
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.renderer.getPaneHeights().map(Math.round)))
    .toEqual(expected);
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Price chart', { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.renderer.getPaneHeights().map(Math.round)))
    .toEqual(expected);
});

test('returns the toolbar to selection mode after completing a drawing', async ({ page }) => {
  await openSimulator(page);
  await page.getByRole('button', { name: 'Trend line', exact: true }).click();
  const { start, end } = await chartPoints(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await drawings(page)).length).toBe(1);
  await expect(page.getByRole('button', { name: 'Select / pan', exact: true })).toHaveClass(
    /active/,
  );
  await expect(page.getByRole('button', { name: 'Trend line', exact: true })).not.toHaveClass(
    /active/,
  );
  await expect(page.locator('.drawing-hint')).toHaveCount(0);
});
