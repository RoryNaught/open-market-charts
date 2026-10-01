import { readFile } from 'node:fs/promises';
import { test, expect, openSimulator, drawings, chartPoints, dragDrawing } from './fixtures';

test('streams simulated candles, loads older history, and keeps the viewport anchored', async ({
  page,
}, testInfo) => {
  await openSimulator(page);
  await expect(page.getByTestId('chart').locator('canvas').first()).toBeVisible();
  const initial = await page.evaluate(() => ({
    revision: window.__OMC!.session.store.last?.revision ?? 0,
    count: window.__OMC!.session.store.length,
    range: window.__OMC!.renderer.chart.timeScale().getVisibleLogicalRange(),
  }));
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.session.store.last?.revision ?? 0))
    .toBeGreaterThan(initial.revision);
  await page.getByRole('button', { name: '← Earlier history', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.session.store.length))
    .toBeGreaterThan(initial.count);
  const after = await page.evaluate(() => ({
    count: window.__OMC!.session.store.length,
    range: window.__OMC!.renderer.chart.timeScale().getVisibleLogicalRange(),
  }));
  expect(after.range!.from - initial.range!.from).toBeCloseTo(after.count - initial.count, 1);
  await testInfo.attach('workspace', { body: await page.screenshot(), contentType: 'image/png' });
});

test('switches every timeframe, chart type, and scale without corrupting source bars', async ({
  page,
}) => {
  await openSimulator(page);
  for (const [label, interval] of [
    ['1m', 60000],
    ['15m', 900000],
    ['1h', 3600000],
    ['1D', 86400000],
    ['1W', 604800000],
    ['5m', 300000],
  ] as const) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const bars = window.__OMC!.session.store.bars;
          return bars.length > 1 ? bars[1].time - bars[0].time : 0;
        }),
      )
      .toBe(interval);
  }
  const original = await page.evaluate(() => window.__OMC!.session.store.bars[0]);
  for (const chartType of ['bars', 'line', 'area', 'heikin-ashi', 'candles']) {
    await page.getByLabel('Chart type').selectOption(chartType);
    await expect(page.getByLabel('Chart type')).toHaveValue(chartType);
    await expect
      .poll(() => page.evaluate(() => window.__OMC!.renderer.getBarCount()))
      .toBeGreaterThanOrEqual(900);
    // Changing series can trigger legitimate earlier-history pagination; compare by timestamp.
    expect(
      await page.evaluate(
        (time) => window.__OMC!.session.store.bars.find((bar) => bar.time === time),
        original.time,
      ),
    ).toEqual(original);
  }
  for (const mode of ['log', 'percentage', 'linear']) {
    await page.getByLabel('Price scale').selectOption(mode);
    const roundtrip = await page.evaluate(() => {
      const rt = window.__OMC!,
        adapter = rt.renderer.adapter(),
        value = rt.session.store.last!.close;
      const y = adapter.priceToY(value);
      return y === null ? null : { value, restored: adapter.yToPrice(y) };
    });
    expect(roundtrip?.restored).toBeCloseTo(roundtrip!.value, 5);
  }
});

test('creates every drawing tool through pointer gestures and supports undo/redo', async ({
  page,
}) => {
  await openSimulator(page);
  for (const [label, type] of [
    ['Trend line', 'trend-line'],
    ['Horizontal line', 'horizontal-line'],
    ['Vertical line', 'vertical-line'],
    ['Ray', 'ray'],
    ['Rectangle', 'rectangle'],
    ['Price range', 'price-range'],
    ['Date range', 'date-range'],
    ['Fibonacci retracement', 'fibonacci'],
    ['Parallel channel', 'parallel-channel'],
  ] as const) {
    await dragDrawing(page, label);
    await expect.poll(async () => (await drawings(page)).length, label).toBe(1);
    expect((await drawings(page))[0].type).toBe(type);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await drawings(page)).length).toBe(0);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect.poll(async () => (await drawings(page)).length).toBe(1);
    await page.getByRole('button', { name: 'Delete drawing', exact: true }).click();
    await expect.poll(async () => (await drawings(page)).length).toBe(0);
  }
});

test('resizes selected anchors, changes styles, cancels edits, and deletes using the keyboard', async ({
  page,
}) => {
  await openSimulator(page);
  await dragDrawing(page);
  const original = (await drawings(page))[0];
  const { bounds } = await chartPoints(page);
  const endpoint = await page.evaluate(() => {
    const rt = window.__OMC!,
      d = rt.drawings.getAll()[0],
      a = rt.renderer.adapter();
    return { x: a.timeToX(d.anchors[1].time)!, y: a.priceToY(d.anchors[1].value)! };
  });
  await page.mouse.move(bounds.x + endpoint.x, bounds.y + endpoint.y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + endpoint.x + 40, bounds.y + endpoint.y + 30, { steps: 10 });
  await page.mouse.up();
  const resized = (await drawings(page))[0];
  expect(resized.anchors[0]).toEqual(original.anchors[0]);
  expect(resized.anchors[1]).not.toEqual(original.anchors[1]);
  await page.getByLabel('Drawing width').selectOption('4');
  expect((await drawings(page))[0].style.lineWidth).toBe(4);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await drawings(page))[0].style.lineWidth).toBe(2);
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  const points = await chartPoints(page);
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await drawings(page)).toHaveLength(1);
  await page.getByRole('button', { name: 'Select / pan', exact: true }).click();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await drawings(page)).length).toBe(0);
});

test('adds/removes separate indicator panes and edits calculation parameters', async ({ page }) => {
  await openSimulator(page);
  const initial = await page.evaluate(() => window.__OMC!.renderer.getPaneHeights().length);
  await page.getByRole('button', { name: /^Indicators/ }).click();
  const dialog = page.getByRole('dialog', { name: 'indicators' });
  await dialog.getByRole('button', { name: 'RSI', exact: true }).click();
  await page.getByLabel('RSI period').fill('21');
  await expect(page.getByLabel('RSI period')).toHaveValue('21');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.renderer.getPaneHeights().length))
    .toBe(initial + 1);
  await page.getByRole('button', { name: 'Remove RSI', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__OMC!.renderer.getPaneHeights().length))
    .toBe(initial);
});

test('persists the workspace across reload and round-trips exported JSON', async ({ page }) => {
  await openSimulator(page);
  await dragDrawing(page, 'Rectangle');
  await page.getByLabel('Chart type').selectOption('area');
  await page.getByRole('button', { name: 'Feed settings', exact: true }).click();
  await page.getByLabel('Workspace name').fill('Browser persistence test');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  const original = await drawings(page);
  await page.reload();
  await expect.poll(async () => (await drawings(page)).length).toBe(1);
  await expect(page.getByLabel('Chart type')).toHaveValue('area');
  await expect(page.locator('.workspace-label')).toHaveText('Browser persistence test');
  expect(await drawings(page)).toEqual(original);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export workspace' }).click();
  const download = await downloadEvent,
    path = await download.path();
  if (!path) throw new Error('Workspace download missing');
  const payload = await readFile(path, 'utf8');
  expect(JSON.parse(payload).name).toBe('Browser persistence test');
  expect(payload).not.toContain('ALPACA_SECRET');
  await page.getByRole('button', { name: 'Select / pan', exact: true }).click();
  const object = original[0];
  const point = await page.evaluate((id) => {
    const rt = window.__OMC!,
      d = rt.drawings.getAll().find((d) => d.id === id)!,
      a = rt.renderer.adapter();
    return { x: a.timeToX(d.anchors[0].time)!, y: a.priceToY(d.anchors[0].value)! };
  }, object.id);
  const { bounds } = await chartPoints(page);
  await page.mouse.click(bounds.x + point.x, bounds.y + point.y);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await drawings(page)).length).toBe(0);
  await page.locator('input[type=file]').setInputFiles({
    name: 'workspace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(payload),
  });
  await expect(page.getByRole('status')).toContainText('Workspace restored.');
  expect(await drawings(page)).toEqual(original);
});

test('rejects invalid imports without changing committed drawings', async ({ page }) => {
  await openSimulator(page);
  await dragDrawing(page);
  const before = await drawings(page);
  await page.locator('input[type=file]').setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"version":999}'),
  });
  await expect(page.getByRole('status')).toContainText('Import failed:');
  expect(await drawings(page)).toEqual(before);
});

test('preserves raw drawing anchors across scale changes and resizes on the logarithmic scale', async ({
  page,
}) => {
  await openSimulator(page);
  await dragDrawing(page);
  const original = (await drawings(page))[0];
  for (const mode of ['log', 'percentage', 'linear', 'log']) {
    await page.getByLabel('Price scale').selectOption(mode);
    expect((await drawings(page))[0].anchors).toEqual(original.anchors);
  }
  const { bounds } = await chartPoints(page);
  const endpoint = await page.evaluate(() => {
    const rt = window.__OMC!,
      d = rt.drawings.getAll()[0],
      a = rt.renderer.adapter();
    return { x: a.timeToX(d.anchors[1].time)!, y: a.priceToY(d.anchors[1].value)! };
  });
  await page.mouse.move(bounds.x + endpoint.x, bounds.y + endpoint.y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + endpoint.x + 30, bounds.y + endpoint.y - 25, { steps: 8 });
  await page.mouse.up();
  const updated = (await drawings(page))[0];
  expect(updated.anchors[0]).toEqual(original.anchors[0]);
  expect(updated.anchors[1].value).toBeGreaterThan(original.anchors[1].value);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await drawings(page))[0].anchors).toEqual(original.anchors);
});
