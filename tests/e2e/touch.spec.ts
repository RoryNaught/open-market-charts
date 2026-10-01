import { test, expect, openSimulator, drawings, chartPoints } from './fixtures';

test('keeps the narrow layout usable and creates a drawing through touch input', async ({
  page,
}, testInfo) => {
  await openSimulator(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(page.getByTestId('chart')).toBeVisible();
  await expect(page.locator('.watchlist')).toBeHidden();
  await page.getByRole('button', { name: 'Horizontal line', exact: true }).tap();
  const { start } = await chartPoints(page);
  await page.touchscreen.tap(start.x, start.y);
  await expect.poll(async () => (await drawings(page)).length).toBe(1);
  expect((await drawings(page))[0].type).toBe('horizontal-line');
  await page.getByRole('button', { name: 'Undo', exact: true }).tap();
  await expect.poll(async () => (await drawings(page)).length).toBe(0);
  await testInfo.attach('touch-workspace', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
