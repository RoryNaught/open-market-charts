import { test, expect, mockCoinbase, openSimulator } from './fixtures';

test('uses the production Coinbase adapter with REST history and streamed trade fixtures', async ({
  page,
}) => {
  const exchange = await mockCoinbase(page);
  await page.goto('/');
  await expect(page.locator('.feed-status')).toHaveText('LIVE');
  await expect(page.locator('.chart-message')).toHaveCount(0);
  await expect(page.locator('footer')).toContainText('900 bars');
  expect(await page.evaluate(() => '__OMC' in window)).toBe(false);
  exchange.sendTrade(61234.56);
  await expect(page.locator('.current-price')).toContainText('61,234.56');
  await page.locator('.symbol-control').click();
  await page.getByPlaceholder('Search symbol or name…').fill('ETH');
  await page.locator('.symbol-result > button:first-child').filter({ hasText: 'ETH-USD' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Ethereum / US Dollar');
  await expect(page.locator('.chart-message')).toHaveCount(0);
});

test('shows exchange failure and never silently switches to simulated data', async ({ page }) => {
  await mockCoinbase(page, true);
  await page.goto('/');
  await expect(page.getByText('Market data unavailable', { exact: true })).toBeVisible();
  await expect(page.locator('footer')).toContainText('0 bars');
  await expect(page.locator('.feed-status')).not.toHaveText('SIMULATED');
  await expect(page.getByRole('button', { name: 'Retry connection' })).toBeVisible();
});

test('switches equity sessions through the gateway adapter and resolves calendar-based future anchors', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-09-30T15:00:00Z'));
  const sessions = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'].map((date) => ({
    date,
    open: Date.parse(`${date}T13:30:00Z`),
    close: Date.parse(`${date}T20:00:00Z`),
    extendedOpen: Date.parse(`${date}T08:00:00Z`),
    extendedClose: Date.parse(`${date}T00:00:00Z`) + 86400000,
  }));
  await page.route('http://127.0.0.1:8787/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/calendar') return route.fulfill({ json: sessions });
    if (url.pathname === '/api/minutes') return route.fulfill({ json: [] });
    if (url.pathname === '/api/symbols') return route.fulfill({ json: [] });
    if (url.pathname === '/api/bars') {
      const extended = url.searchParams.get('session') === 'extended',
        bars = [];
      for (const session of sessions.slice(0, 2))
        for (
          let time = extended ? session.extendedOpen : session.open;
          time <
          Math.min(
            extended ? session.extendedClose : session.close,
            Date.parse('2026-09-30T15:00:00Z'),
          );
          time += 300000
        )
          bars.push({ time, open: 600, high: 602, low: 599, close: 601, volume: 1000 });
      return route.fulfill({ json: { bars, nextBefore: bars[0]?.time, hasMore: false } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.routeWebSocket('ws://127.0.0.1:8787/stream', (socket) =>
    socket.onMessage(() => socket.send(JSON.stringify({ type: 'ready' }))),
  );
  await openSimulator(page);
  await page.getByRole('button', { name: 'Feed settings', exact: true }).click();
  await page.getByRole('button', { name: 'Connect stock feed', exact: true }).click();
  await expect(page.getByLabel('Trading session')).toHaveValue('regular');
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.session.store.bars[0]?.time))
    .toBe(sessions[0].open);
  const regularCount = await page.evaluate(() => window.__OMC!.session.store.length);
  await page.getByLabel('Trading session').selectOption('extended');
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.session.store.bars[0]?.time))
    .toBe(sessions[0].extendedOpen);
  expect(await page.evaluate(() => window.__OMC!.session.store.length)).toBeGreaterThan(
    regularCount,
  );
  const future = sessions[2].extendedOpen;
  await expect
    .poll(() =>
      page.evaluate((time) => {
        const adapter = window.__OMC!.renderer.adapter(),
          x = adapter.timeToX(time);
        return x === null ? null : adapter.xToTime(x);
      }, future),
    )
    .toBe(future);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('SPDR S&P 500 ETF');
});
