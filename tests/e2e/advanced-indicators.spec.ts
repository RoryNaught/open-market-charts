import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { Workspace } from '@omc/chart-core';
import type { Bar } from '@omc/provider-sdk';
import { test, expect, openSimulator, chartPoints } from './fixtures';

const advanced = [
  'AnchoredVWAP',
  'Supertrend',
  'SqueezeMomentum',
  'MarketStructure',
  'FairValueGaps',
] as const;
test.use({ timezoneId: 'America/New_York' });

async function exportWorkspace(page: Page): Promise<Workspace> {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export workspace' }).click();
  const file = await (await event).path();
  if (!file) throw new Error('Workspace download missing');
  return JSON.parse(await readFile(file, 'utf8')) as Workspace;
}
async function openIndicators(page: Page) {
  await page.getByRole('button', { name: /^Indicators/ }).click();
  return page.getByRole('dialog', { name: 'indicators' });
}

test('adds all advanced studies, edits parameters, and removes their panes and annotations', async ({
  page,
}) => {
  await openSimulator(page);
  const initialPanes = await page.evaluate(() => window.__OMC!.renderer.getPaneHeights().length);
  const dialog = await openIndicators(page);
  for (const type of advanced)
    await dialog.getByRole('button', { name: type, exact: true }).click();
  await expect(dialog.getByLabel('SqueezeMomentum pane')).toHaveValue('separate');
  await expect(dialog.getByLabel('Supertrend pane')).toHaveValue('price');
  await expect(dialog.getByLabel('MarketStructure pane')).toHaveCount(0);
  await expect(dialog.getByLabel('FairValueGaps pane')).toHaveCount(0);
  for (const [name, value] of [
    ['Supertrend multiplier', '1'],
    ['SqueezeMomentum period', '10'],
    ['MarketStructure leftBars', '2'],
    ['FairValueGaps minGapPercent', '0.1'],
  ]) {
    await dialog.getByLabel(name, { exact: true }).fill(value);
    await expect(dialog.getByLabel(name, { exact: true })).toHaveValue(value);
  }
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.renderer.getPaneHeights().length))
    .toBe(initialPanes + 1);
  for (const type of advanced)
    await expect(page.getByRole('button', { name: `Remove ${type}`, exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.renderer.getIndicatorAnnotations().length))
    .toBeGreaterThan(0);
  const workspace = await exportWorkspace(page);
  expect(workspace.indicators.find((item) => item.type === 'Supertrend')?.params.multiplier).toBe(
    1,
  );
  expect(workspace.indicators.find((item) => item.type === 'SqueezeMomentum')?.params.period).toBe(
    10,
  );
  for (const type of ['MarketStructure', 'FairValueGaps'])
    expect(workspace.indicators.find((item) => item.type === type)?.pane).toBe('price');

  await openIndicators(page);
  await page.getByRole('button', { name: 'Delete SqueezeMomentum', exact: true }).click();
  await page.getByRole('button', { name: 'Delete Supertrend', exact: true }).click();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.renderer.getPaneHeights().length))
    .toBe(initialPanes);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window
            .__OMC!.renderer.getIndicatorAnnotations()
            .filter((item) => item.id.startsWith('supertrend:') || item.id.startsWith('squeeze:'))
            .length,
      ),
    )
    .toBe(0);
  await expect(
    page.getByRole('button', { name: 'Remove AnchoredVWAP', exact: true }),
  ).toBeVisible();
});

test('picks a real candle for anchored VWAP and persists UTC parameters with unique new instance IDs', async ({
  page,
}) => {
  await openSimulator(page);
  const dialog = await openIndicators(page);
  await dialog.getByRole('button', { name: 'AnchoredVWAP', exact: true }).click();
  await dialog.getByRole('button', { name: 'Supertrend', exact: true }).click();
  await dialog.getByLabel('Supertrend multiplier', { exact: true }).fill('2.5');
  await dialog.getByRole('button', { name: 'Pick VWAP anchor', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const points = await chartPoints(page, { x: 0.43, y: 0.45 });
  const expectedAnchor = await page.evaluate((x) => {
    const rt = window.__OMC!;
    const rawTime = rt.renderer.adapter('price').xToTime(x)!;
    return rt.session.store.bars.reduce((nearest, bar) =>
      Math.abs(bar.time - rawTime) < Math.abs(nearest.time - rawTime) ? bar : nearest,
    ).time;
  }, points.start.x - points.bounds.x);
  await page.mouse.click(points.start.x, points.start.y);
  await expect(page.getByText(/^VWAP anchored to /)).toBeVisible();
  await openIndicators(page);
  const anchorInput = page.getByLabel('AnchoredVWAP anchor UTC', { exact: true });
  // Datetime inputs normalize trailing :00 seconds; compare the represented UTC instant.
  await expect
    .poll(async () => Date.parse((await anchorInput.inputValue()) + 'Z'))
    .toBe(expectedAnchor);
  // Editing the UTC datetime must not reinterpret it in the browser's local timezone.
  const editedAnchor = expectedAnchor - 3 * 300_000 + 17_000;
  const editedUTC = new Date(editedAnchor).toISOString().slice(0, 19);
  await anchorInput.fill(editedUTC);
  await expect
    .poll(async () => Date.parse((await anchorInput.inputValue()) + 'Z'))
    .toBe(editedAnchor);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  const before = await exportWorkspace(page);
  expect(before.indicators.find((item) => item.type === 'AnchoredVWAP')!.params.anchorTime).toBe(
    editedAnchor,
  );
  await page.reload();
  await expect(page.locator('.feed-status')).toHaveText('SIMULATED');
  await openIndicators(page);
  await expect
    .poll(async () =>
      Date.parse(
        (await page.getByLabel('AnchoredVWAP anchor UTC', { exact: true }).inputValue()) + 'Z',
      ),
    )
    .toBe(editedAnchor);
  await expect(page.getByLabel('Supertrend multiplier', { exact: true })).toHaveValue('2.5');
  await page
    .getByRole('dialog', { name: 'indicators' })
    .getByRole('button', { name: 'Supertrend', exact: true })
    .click();
  await expect(page.getByLabel('Supertrend multiplier', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  const after = await exportWorkspace(page);
  expect(new Set(after.indicators.map((item) => item.id)).size).toBe(after.indicators.length);
  expect(
    after.indicators
      .filter((item) => item.type === 'Supertrend')
      .map((item) => item.params.multiplier)
      .sort(),
  ).toEqual([2.5, 3]);
  expect(after.indicators.find((item) => item.type === 'AnchoredVWAP')).toEqual(
    before.indicators.find((item) => item.type === 'AnchoredVWAP'),
  );
});

test('worker and renderer withhold unfinished-candle gaps, show confirmed zones, and clear deleted annotations', async ({
  page,
}) => {
  await openSimulator(page);
  const dialog = await openIndicators(page);
  await dialog.getByRole('button', { name: 'FairValueGaps', exact: true }).click();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  const workspace = await exportWorkspace(page);
  const start = Date.UTC(2026, 8, 30, 12);
  const input: Bar[] = [
    { time: start, open: 99, high: 100, low: 98, close: 99, volume: 10, closed: true },
    { time: start + 300_000, open: 100, high: 104, low: 99, close: 103, volume: 10, closed: true },
    {
      time: start + 600_000,
      open: 104,
      high: 106,
      low: 103,
      close: 105,
      volume: 10,
      closed: false,
    },
  ];
  await page.evaluate(
    ({ bars, configs }) => {
      const rt = window.__OMC!;
      // Stop the explicit simulator to make the worker/renderer confirmation fixture deterministic.
      rt.session.dispose();
      rt.renderer.setBars(bars, 'reset', bars);
      rt.renderer.chart.timeScale().setVisibleLogicalRange({ from: -1, to: 6 });
      rt.worker.reset(bars, configs);
    },
    { bars: input, configs: workspace.indicators },
  );
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.renderer.getIndicatorAnnotations().length))
    .toBe(0);
  // Appending a new forming candle confirms its predecessor even without an explicit closed event.
  const next: Bar = {
    time: start + 900_000,
    open: 105,
    high: 108,
    low: 104,
    close: 107,
    volume: 12,
    closed: false,
  };
  await page.evaluate(
    ({ bars, next }) => {
      const rt = window.__OMC!;
      rt.renderer.setBars([...bars, next], 'update', [next]);
      rt.worker.update(next);
    },
    { bars: input, next },
  );
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.renderer.getIndicatorAnnotations().length))
    .toBe(1);
  const annotations = await page.evaluate(() =>
    window.__OMC!.renderer.getIndicatorAnnotations('price'),
  );
  expect(annotations[0]).toMatchObject({
    kind: 'zone',
    text: 'Bullish FVG',
    price: 100,
    price2: 103,
    time: input[2].time,
    confirmedAt: input[2].time,
    originTime: input[0].time,
    status: 'active',
  });
  expect(annotations.every((item) => item.confirmedAt < next.time)).toBe(true);
  const point = await page.evaluate((annotation) => {
    const adapter = window.__OMC!.renderer.adapter('price');
    return { x: adapter.timeToX(annotation.time)!, y: adapter.priceToY(annotation.price)! };
  }, annotations[0]);
  const bounds = await page.getByTestId('chart').boundingBox();
  if (!bounds) throw new Error('Chart bounds missing');
  await page.mouse.move(bounds.x + point.x + 2, bounds.y + point.y);
  await expect(page.getByTestId('chart')).toHaveAttribute('title', /Bullish FVG.*active/);
  await page.getByRole('button', { name: 'Remove FairValueGaps', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.renderer.getIndicatorAnnotations().length))
    .toBe(0);
});

test('draws the squeeze histogram with per-point positive and negative momentum colors', async ({
  page,
}) => {
  await openSimulator(page);
  const dialog = await openIndicators(page);
  await dialog.getByRole('button', { name: 'SqueezeMomentum', exact: true }).click();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.renderer.getPaneHeights().length))
    .toBe(3);
  await expect
    .poll(() =>
      page.getByTestId('chart').evaluate((host) => {
        const counts = { positive: 0, negative: 0 };
        for (const canvas of host.querySelectorAll('canvas')) {
          const ctx = canvas.getContext('2d');
          if (!ctx || !canvas.width || !canvas.height) continue;
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let i = 0; i < pixels.length; i += 4) {
            if (
              (pixels[i] === 45 && pixels[i + 1] === 212 && pixels[i + 2] === 191) ||
              (pixels[i] === 19 && pixels[i + 1] === 124 && pixels[i + 2] === 114)
            )
              counts.positive++;
            if (
              (pixels[i] === 240 && pixels[i + 1] === 108 && pixels[i + 2] === 128) ||
              (pixels[i] === 140 && pixels[i + 1] === 70 && pixels[i + 2] === 86)
            )
              counts.negative++;
          }
        }
        return counts.positive > 10 && counts.negative > 10;
      }),
    )
    .toBe(true);
});
