import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// Live, public Coinbase data in a fresh browser context. No saved user workspace is changed.
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.OMC_BASE_URL ?? 'http://127.0.0.1:5173');
  await expect(page.locator('.feed-status')).toHaveText('LIVE', { timeout: 45000 });
  await page.getByRole('button', { name: /^Indicators/ }).click();
  const dialog = page.getByRole('dialog', { name: 'indicators' });
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/advanced-catalog.png' });
  for (const type of [
    'AnchoredVWAP',
    'Supertrend',
    'SqueezeMomentum',
    'MarketStructure',
    'FairValueGaps',
  ])
    await dialog.getByRole('button', { name: type, exact: true }).click();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({ path: 'docs/screenshots/advanced-indicators.png' });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    JSON.stringify({
      source: 'Coinbase live',
      capturedAt: new Date().toISOString(),
      screenshots: ['advanced-catalog.png', 'advanced-indicators.png'],
    }),
  );
} finally {
  await browser.close();
}
