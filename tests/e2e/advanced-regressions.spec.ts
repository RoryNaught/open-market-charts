import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { Workspace } from '@omc/chart-core';
import type { IndicatorConfig } from '@omc/indicator-engine';
import type { Bar, SessionInterval } from '@omc/provider-sdk';
import { test, expect, openSimulator, drawings } from './fixtures';

const start = Date.UTC(2026, 8, 30, 13, 30);
const candle = (index: number, close: number, high = close + 1, low = close - 1): Bar => ({
  time: start + index * 300_000,
  open: close,
  high,
  low,
  close,
  volume: 10,
  closed: true,
});

async function exportWorkspace(page: Page): Promise<Workspace> {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export workspace', exact: true }).click();
  const file = await (await event).path();
  if (!file) throw new Error('Missing workspace export');
  return JSON.parse(await readFile(file, 'utf8')) as Workspace;
}

async function prepareStudy(
  page: Page,
  type: 'Supertrend' | 'FairValueGaps',
  parameters: Record<string, string>,
  pane: 'price' | 'separate' = 'price',
): Promise<IndicatorConfig[]> {
  await openSimulator(page);
  await page.getByRole('button', { name: 'Remove EMA', exact: true }).click();
  await page.getByRole('button', { name: /^Indicators/ }).click();
  const dialog = page.getByRole('dialog', { name: 'indicators' });
  await dialog.getByRole('button', { name: type, exact: true }).click();
  for (const [key, value] of Object.entries(parameters))
    await dialog.getByLabel(`${type} ${key}`, { exact: true }).fill(value);
  if (type === 'Supertrend') await dialog.getByLabel('Supertrend pane').selectOption(pane);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  return (await exportWorkspace(page)).indicators;
}

async function installHistory(page: Page, bars: Bar[], configs: IndicatorConfig[]) {
  await page.evaluate(
    ({ bars, configs }) => {
      const rt = window.__OMC!;
      rt.session.dispose();
      rt.session.store.reset(bars);
      rt.renderer.setBars(bars, 'reset', bars);
      rt.renderer.chart.timeScale().setVisibleLogicalRange({ from: -1, to: bars.length + 1 });
      rt.worker.reset(bars, configs, { sessions: [] });
    },
    { bars, configs },
  );
}

test('keeps time and price transforms usable for drawing in a down-only Supertrend pane', async ({
  page,
}) => {
  const configs = await prepareStudy(
    page,
    'Supertrend',
    { period: '3', multiplier: '3' },
    'separate',
  );
  const bars = Array.from({ length: 20 }, (_, i) => candle(i, 100 - i));
  await installHistory(page, bars, configs);
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.renderer.getPaneHeights().length))
    .toBe(3);
  // A pane may already exist from the simulator. Wait for this fixture's worker result.
  await expect
    .poll(() =>
      page.evaluate(() =>
        window
          .__OMC!.renderer.chart.panes()
          .at(-1)!
          .getSeries()
          .map(
            (series) =>
              series.data().filter((point) => 'value' in point && Number.isFinite(point.value))
                .length,
          ),
      ),
    )
    .toEqual([0, 18]);
  await expect
    .poll(() =>
      page.evaluate((id) => window.__OMC!.renderer.adapter(id).priceToY(90), configs[0].id),
    )
    .not.toBeNull();
  const location = await page.evaluate(
    ({ id, time }) => {
      const renderer = window.__OMC!.renderer;
      const adapter = renderer.adapter(id);
      const pane = renderer.chart.panes().at(-1)!;
      const rect = pane.getHTMLElement()!.getBoundingClientRect();
      const x = adapter.timeToX(time)!;
      const y = adapter.priceToY(90)!;
      const outputs = pane
        .getSeries()
        .map(
          (series) =>
            series.data().filter((point) => 'value' in point && Number.isFinite(point.value))
              .length,
        );
      return {
        outputs,
        x,
        y,
        restoredTime: adapter.xToTime(x),
        restoredPrice: adapter.yToPrice(y),
        left: rect.left + renderer.chart.priceScale('left', pane.paneIndex()).width(),
        top: rect.top,
        width: adapter.width,
        height: adapter.height,
      };
    },
    { id: configs[0].id, time: bars[10].time },
  );
  expect(location.outputs).toEqual([0, 18]);
  expect(Number.isFinite(location.x)).toBe(true);
  expect(Number.isFinite(location.y)).toBe(true);
  expect(location.restoredTime).toBeCloseTo(bars[10].time, 0);
  expect(location.restoredPrice).toBeCloseTo(90, 6);

  await page.getByRole('button', { name: 'Trend line', exact: true }).click();
  await page.mouse.move(location.left + location.width * 0.3, location.top + location.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(
    location.left + location.width * 0.65,
    location.top + location.height * 0.65,
    {
      steps: 10,
    },
  );
  await page.mouse.up();
  await expect.poll(async () => (await drawings(page)).length).toBe(1);
  const drawing = (await drawings(page))[0];
  expect(drawing.paneId).toBe(configs[0].id);
  expect(drawing.anchors).toHaveLength(2);
  for (const anchor of drawing.anchors) {
    expect(Number.isFinite(anchor.time)).toBe(true);
    expect(Number.isFinite(anchor.value)).toBe(true);
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await drawings(page)).length).toBe(0);
});

test('moves both Supertrend outputs to the left scale and hovers annotations at their native price', async ({
  page,
}) => {
  const configs = await prepareStudy(page, 'Supertrend', { period: '1', multiplier: '1' });
  await installHistory(
    page,
    [
      candle(0, 10, 11, 9),
      candle(1, 12, 12, 10),
      candle(2, 13, 13, 11),
      candle(3, 10, 11, 9),
      candle(4, 9, 10, 8),
    ],
    configs,
  );
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.renderer.getIndicatorAnnotations().length))
    .toBe(2);
  await page.getByRole('button', { name: 'Feed settings', exact: true }).click();
  await page.getByLabel('Show a second price scale for the first overlay indicator').check();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window
          .__OMC!.renderer.chart.panes()[0]
          .getSeries()
          .filter((series) => series.seriesType() === 'Line' && series.options().visible)
          .map((series) => series.options().priceScaleId),
      ),
    )
    .toEqual(['left', 'left']);
  // Replacing the simulator's long history and adding axis width can shift logical range.
  await page.evaluate(() =>
    window.__OMC!.renderer.chart.timeScale().setVisibleLogicalRange({ from: -1, to: 6 }),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const r = window.__OMC!.renderer;
        const series = r.chart
          .panes()[0]
          .getSeries()
          .find((s) => s.options().priceScaleId === 'left')!;
        const y = series.priceToCoordinate(10);
        return y !== null && y >= 0 && y <= r.adapter().height;
      }),
    )
    .toBe(true);
  const hover = await page.evaluate(() => {
    const renderer = window.__OMC!.renderer;
    const pane = renderer.chart.panes()[0];
    const rect = pane.getHTMLElement()!.getBoundingClientRect();
    const annotation = renderer
      .getIndicatorAnnotations()
      .find((item) => item.text === 'Supertrend up')!;
    const series = pane.getSeries().find((item) => item.options().priceScaleId === 'left')!;
    const x = renderer.adapter().timeToX(annotation.time)!;
    const y = series.priceToCoordinate(annotation.price)!;
    return {
      text: annotation.text,
      hit: renderer.annotationAt(x, y, 'price')?.text,
      rightY: renderer.adapter().priceToY(annotation.price),
      y,
      clientX: rect.left + renderer.chart.priceScale('left').width() + x,
      clientY: rect.top + y,
    };
  });
  expect(hover.hit).toBe(hover.text);
  expect(Math.abs(hover.y - hover.rightY!)).toBeGreaterThan(5);
  await page.mouse.move(hover.clientX, hover.clientY);
  await expect(page.getByTestId('chart')).toHaveAttribute(
    'title',
    /Supertrend up\nConfirmed at close of/,
  );
});

test('recalculates session-filtered gaps when a late calendar arrives and clears the missing-calendar status', async ({
  page,
}) => {
  const configs = await prepareStudy(page, 'FairValueGaps', { withinSession: '1' });
  const bars = [candle(0, 99, 100, 98), candle(1, 103, 104, 99), candle(2, 105, 106, 103)];
  await installHistory(page, bars, configs);
  await page.getByRole('button', { name: /^Indicators/ }).click();
  await expect(
    page.getByText('Within-session gaps require an exchange session calendar.', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__OMC!.renderer.getIndicatorAnnotations())).toEqual([]);
  const sessions: SessionInterval[] = [
    {
      date: '2026-09-30',
      open: start,
      close: Date.UTC(2026, 8, 30, 20),
      extendedOpen: Date.UTC(2026, 8, 30, 8),
      extendedClose: Date.UTC(2026, 9, 1, 0),
    },
  ];
  await page.evaluate((sessions) => window.__OMC!.refreshSessions(sessions), sessions);
  await expect(
    page.getByText('Within-session gaps require an exchange session calendar.', { exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.renderer.getIndicatorAnnotations().length))
    .toBe(1);
  expect(
    await page.evaluate(() => window.__OMC!.renderer.getIndicatorAnnotations()[0]),
  ).toMatchObject({
    kind: 'zone',
    text: 'Bullish FVG',
    price: 100,
    price2: 103,
    time: bars[2].time,
    confirmedAt: bars[2].time,
    status: 'active',
  });
  // Delivering an unchanged calendar must preserve the existing confirmed result.
  await page.evaluate((sessions) => window.__OMC!.refreshSessions(sessions), sessions);
  expect(await page.evaluate(() => window.__OMC!.renderer.getIndicatorAnnotations().length)).toBe(
    1,
  );
});
