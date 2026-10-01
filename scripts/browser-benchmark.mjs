import { chromium } from '@playwright/test';
import { cpus, platform, release, arch, totalmem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.split('=');
    return [key, value ?? 'true'];
  }),
);
const base = args.get('--url') ?? 'http://127.0.0.1:5173';
const output = resolve(args.get('--output') ?? 'benchmarks/local-browser.json');
const root = resolve('.');
const browser = await chromium.launch({ headless: true });
const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  environment: {
    browser: browser.version(),
    headless: true,
    os: platform(),
    release: release(),
    architecture: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    systemMemoryGB: totalmem() / 1e9,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  },
  methodology:
    'One run per scenario against Vite development server. Real Chromium canvas and bundled module worker. Generated history excluded from ready timing. Streaming is wall-clock paced, with events aggregated before 60 Hz bar coalescing.',
  scenarios: [],
};
try {
  for (const [count, allIndicators] of [
    [100_000, true],
    [500_000, false],
  ].filter(([count]) => !args.has('--bars') || count === Number(args.get('--bars')))) {
    const context = await browser.newContext({
      viewport: report.environment.viewport,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(`${base}/?dev=1`);
    await page.waitForFunction(() => window.__OMC?.session.store.length > 0);
    await page.evaluate(
      async ({ root, count, allIndicators }) => {
        const data = await import(`/@fs${root}/packages/data-engine/src/index.ts`);
        const indicators = await import(`/@fs${root}/packages/indicator-engine/src/index.ts`);
        const runtime = window.__OMC;
        runtime.session.dispose();
        runtime.providers.forEach((provider) => provider.dispose());
        runtime.worker.dispose();
        const bars = data.generateBars(count, { seed: 42 });
        bars[bars.length - 1] = { ...bars[bars.length - 1], closed: false };
        const store = new data.BarStore();
        store.reset(bars);
        const configs = allIndicators
          ? indicators.INDICATOR_TYPES.map((type, i) => {
              const config = indicators.createIndicatorConfig(type, `bench-${i}`);
              if (type === 'AnchoredVWAP') config.params.anchorTime = bars[0].time;
              return config;
            })
          : [];
        const bench = (window.__OMC_BENCH = {
          bars: store.bars,
          store,
          renderer: runtime.renderer,
          phase: 'setup',
          frames: {},
          inputs: [],
          eventTiming: [],
          longTasks: [],
          queue: [],
          workerMetrics: [],
          errors: [],
          maxPendingWorkerRequests: 0,
          pendingSamples: [],
          count,
          configs,
          allIndicators,
          data,
          deliveredUnique: 0,
        });
        let lastFrame;
        const frame = (time) => {
          if (lastFrame !== undefined) (bench.frames[bench.phase] ??= []).push(time - lastFrame);
          lastFrame = time;
          bench.frameId = requestAnimationFrame(frame);
        };
        bench.frameId = requestAnimationFrame(frame);
        const twoFrames = () =>
          new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        bench.twoFrames = twoFrames;
        for (const type of ['pointerdown', 'pointerup', 'pointermove', 'wheel'])
          runtime.renderer.element.addEventListener(
            type,
            (event) => {
              if (bench.phase !== 'interaction') return;
              const start = performance.now();
              void twoFrames().then(() =>
                bench.inputs.push({ type, delayMs: performance.now() - start }),
              );
            },
            { passive: true },
          );
        if (PerformanceObserver.supportedEntryTypes.includes('event')) {
          bench.eventObserver = new PerformanceObserver((list) => {
            for (const event of list.getEntries())
              if (event.interactionId)
                bench.eventTiming.push({
                  name: event.name,
                  durationMs: event.duration,
                  interactionId: event.interactionId,
                });
          });
          bench.eventObserver.observe({ type: 'event', durationThreshold: 16 });
        }
        if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
          bench.longObserver = new PerformanceObserver((list) => {
            for (const event of list.getEntries())
              bench.longTasks.push({ phase: bench.phase, durationMs: event.duration });
          });
          bench.longObserver.observe({ type: 'longtask' });
        }
        let initialResolve, initialReject;
        bench.initial = new Promise((resolve, reject) => {
          initialResolve = resolve;
          initialReject = reject;
        });
        bench.worker = new indicators.IndicatorWorkerClient({
          onMetrics(metrics) {
            const request = bench.queue.shift();
            if (request)
              bench.workerMetrics.push({
                ...metrics,
                requestType: request.type,
                phase: request.phase,
                callbackRoundTripMs: performance.now() - request.time,
              });
          },
          onResults(results, mode) {
            const started = performance.now();
            runtime.renderer.renderIndicators(results, mode);
            bench.lastRenderMs = performance.now() - started;
            if (mode === 'reset' && !bench.initialDone) {
              bench.initialDone = true;
              void twoFrames().then(() => {
                bench.readyMs = performance.now() - bench.loadStarted;
                bench.phase = 'idle';
                initialResolve();
              });
            }
          },
          onError(error) {
            bench.errors.push(error.message);
            initialReject(error);
          },
        });
        bench.enqueue = (type, callback) => {
          bench.queue.push({ type, phase: bench.phase, time: performance.now() });
          bench.maxPendingWorkerRequests = Math.max(
            bench.maxPendingWorkerRequests,
            bench.queue.length,
          );
          callback();
        };
        runtime.renderer.configure(data.SIMULATED_INSTRUMENTS[0], '1m', 'candles', 'linear');
        runtime.renderer.setIndicators(configs);
        await twoFrames();
        bench.phase = 'load';
        bench.loadStarted = performance.now();
        runtime.renderer.setBars(store.bars, 'reset', store.bars);
        runtime.renderer.chart
          .timeScale()
          .setVisibleLogicalRange({ from: count - 500, to: count + 7 });
        bench.candleSetDataMs = performance.now() - bench.loadStarted;
        bench.enqueue('reset', () =>
          bench.worker.reset(store.bars, configs, {
            volumeProfileRange: { from: bars[count - 500].time, to: bars[count - 1].time },
          }),
        );
        await Promise.race([
          bench.initial,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Chart readiness exceeded 90 seconds')), 90_000),
          ),
        ]);
      },
      { root, count, allIndicators },
    );
    console.log(`${count} bars loaded`);

    await page.evaluate(
      async ({ root }) => {
        const b = window.__OMC_BENCH;
        const middle = Math.floor(b.count / 2);
        b.renderer.chart.timeScale().setVisibleLogicalRange({ from: middle, to: middle + 500 });
        await b.twoFrames();
        const scale = b.renderer.chart.timeScale();
        const coordinate = scale.timeToCoordinate(b.bars[middle].time / 1000);
        const logicalCoordinate = scale.logicalToCoordinate(middle);
        const priceRows = b.renderer.main.data();
        const latest = priceRows.at(-1);
        const mappingCorrect =
          coordinate !== null &&
          logicalCoordinate !== null &&
          Math.abs(coordinate - logicalCoordinate) < 0.01;
        const tailCorrect =
          latest.time * 1000 === b.bars.at(-1).time && latest.close === b.bars.at(-1).close;
        const boundedRows = priceRows.length < 3000;
        const transforms = await import(`/@fs${root}/packages/chart-core/src/transforms.ts`);
        b.renderer.configure(b.data.SIMULATED_INSTRUMENTS[0], '1m', 'heikin-ashi', 'linear');
        await b.twoFrames();
        const expected = transforms.heikinAshi(b.bars)[middle];
        const actual = b.renderer.main.dataByIndex(middle);
        const haCorrect =
          actual &&
          Math.abs(actual.open - expected.open) < 1e-8 &&
          Math.abs(actual.close - expected.close) < 1e-8;
        b.renderer.configure(b.data.SIMULATED_INSTRUMENTS[0], '1m', 'candles', 'linear');
        b.renderer.chart
          .timeScale()
          .setVisibleLogicalRange({ from: b.count - 500, to: b.count + 7 });
        await b.twoFrames();
        b.windowChecks = {
          completeTimelineMapping: mappingCorrect,
          historicalViewportHasTrueLatestPrice: tailCorrect,
          boundedPriceRows: boundedRows,
          sampledPriceRows: priceRows.length,
          recursiveHeikinAshiPreserved: !!haCorrect,
        };
        if (!mappingCorrect || !tailCorrect || !boundedRows || !haCorrect)
          throw new Error(`Viewport correctness failure: ${JSON.stringify(b.windowChecks)}`);
      },
      { root },
    );

    await page.evaluate(() => {
      window.__OMC_BENCH.phase = 'interaction';
    });
    const rect = await page.evaluate(() => {
      const r = window.__OMC_BENCH.renderer.element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const x = rect.x + rect.width * 0.6,
      y = rect.y + Math.min(120, rect.height * 0.2);
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 160, y + 10, { steps: 12 });
      await page.mouse.up();
      await page.mouse.wheel(0, i % 2 ? -90 : 90);
    }
    await page.evaluate(() => window.__OMC_BENCH.twoFrames());
    if (args.has('--profile')) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
    }
    const ingestion = [];
    if (allIndicators)
      for (const [rate, seconds] of [
        [1000, 5],
        [10_000, 1],
      ]) {
        ingestion.push(
          await page.evaluate(
            async ({ rate, seconds }) => {
              const b = window.__OMC_BENCH;
              b.phase = `stream-${rate}`;
              const last = { ...b.store.last },
                start = last.time + 10_000;
              const aggregator = new b.data.TradeBarAggregator(
                (time) => Math.floor(time / 60_000) * 60_000,
              );
              aggregator.seed([last]);
              const expectedVolume = last.volume;
              const total = rate * seconds;
              let delivered = 0,
                accepted = 0,
                flushes = 0,
                maxPendingBars = 0;
              const pendingTimes = new Set();
              const batcher = b.data.createBarBatcher((bars) => {
                flushes++;
                pendingTimes.clear();
                for (const bar of bars) b.store.update(bar);
                b.renderer.setBars(b.store.bars, 'update', bars);
                b.enqueue('update', () => b.worker.update(bars));
              });
              const started = performance.now();
              await new Promise((resolve) => {
                const tick = () => {
                  const target = Math.min(
                    total,
                    Math.floor(((performance.now() - started) * rate) / 1000),
                  );
                  while (delivered < target) {
                    const i = delivered++;
                    const trade = {
                      id: `${rate}-${i}`,
                      symbol: 'BENCH',
                      sequence: i,
                      time: start + (i * 1000) / rate,
                      price: last.low + (last.high - last.low) * (0.5 + Math.sin(i / 31) * 0.45),
                      size: 1,
                    };
                    const bar = aggregator.add(trade);
                    if (bar) {
                      accepted++;
                      pendingTimes.add(bar.time);
                      maxPendingBars = Math.max(maxPendingBars, pendingTimes.size);
                      batcher.push(bar);
                    }
                  }
                  if (delivered < total) setTimeout(tick, 4);
                  else resolve();
                };
                tick();
              });
              batcher.flush();
              batcher.dispose();
              const ingestionWallMs = performance.now() - started;
              const drainStart = performance.now();
              while (b.queue.length) {
                if (performance.now() - drainStart > 30_000)
                  throw new Error('Worker did not drain within 30 seconds');
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              await b.twoFrames();
              const final = b.store.last;
              const volumeError = Math.abs(final.volume - expectedVolume - total);
              const result = {
                rate,
                requestedSeconds: seconds,
                offeredTrades: total,
                accepted,
                uniqueEventsLost: total - accepted,
                expectedFinalVolume: expectedVolume + total,
                actualFinalVolume: final.volume,
                volumeError,
                ingestionWallMs,
                totalWallMs: performance.now() - started,
                workerDrainMs: performance.now() - drainStart,
                flushes,
                maxPendingBars,
              };
              if (volumeError > 1e-6 || accepted !== total)
                throw new Error('Streaming event accounting failed');
              b.phase = 'idle';
              return result;
            },
            { rate, seconds },
          ),
        );
      }
    let cpuProfile;
    if (args.has('--profile')) {
      const { profile } = await cdp.send('Profiler.stop');
      const profilePath = resolve(`benchmarks/browser-profile-${count}.json`);
      await writeFile(profilePath, JSON.stringify(profile));
      cpuProfile = {
        path: `benchmarks/browser-profile-${count}.json`,
        topSelfSamples: profile.nodes
          .filter((node) => node.hitCount)
          .sort((a, b) => b.hitCount - a.hitCount)
          .slice(0, 25)
          .map((node) => ({
            function: node.callFrame.functionName,
            url: node.callFrame.url,
            line: node.callFrame.lineNumber + 1,
            hits: node.hitCount,
          })),
      };
    }
    const metrics = await cdp.send('Performance.getMetrics');
    const result = await page.evaluate(() => {
      const b = window.__OMC_BENCH;
      const summarize = (values) => {
        const sorted = [...values].sort((a, b) => a - b);
        return {
          samples: sorted.length,
          p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? null,
          p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null,
          maxMs: sorted.at(-1) ?? null,
        };
      };
      cancelAnimationFrame(b.frameId);
      b.eventObserver?.disconnect();
      b.longObserver?.disconnect();
      b.worker.dispose();
      return {
        bars: b.count,
        windowChecks: b.windowChecks,
        indicators: b.configs.map((c) => c.type),
        panes: b.renderer.chart.panes().length,
        readyDefinition:
          'Synchronous candles+volume ingestion, worker reset, all requested indicator series ingested, then two requestAnimationFrame callbacks. Excludes generated data creation and network.',
        readyMs: b.readyMs,
        candleSetDataMs: b.candleSetDataMs,
        lastIndicatorIngestionMs: b.lastRenderMs,
        targetReadyMs: b.count === 100_000 ? 2000 : 5000,
        readyTargetPassed: b.readyMs <= (b.count === 100_000 ? 2000 : 5000),
        frames: Object.fromEntries(
          Object.entries(b.frames).map(([phase, samples]) => [phase, summarize(samples)]),
        ),
        inputDispatchToTwoFrames: {
          ...summarize(b.inputs.map((e) => e.delayMs)),
          definition:
            'DOM input listener entry through two rAF callbacks; proxy, not a direct compositor presentation timestamp.',
        },
        eventTiming: {
          ...summarize(b.eventTiming.map((e) => e.durationMs)),
          definition:
            'Chromium Event Timing interaction durations; entries below 16ms threshold may be absent.',
          entries: b.eventTiming,
        },
        workers: {
          calculation: summarize(b.workerMetrics.map((m) => m.durationMs)),
          callbackRoundTrip: summarize(b.workerMetrics.map((m) => m.callbackRoundTripMs)),
          byPhase: Object.fromEntries(
            [...new Set(b.workerMetrics.map((m) => m.phase))].map((phase) => [
              phase,
              {
                calculation: summarize(
                  b.workerMetrics.filter((m) => m.phase === phase).map((m) => m.durationMs),
                ),
                callbackRoundTrip: summarize(
                  b.workerMetrics
                    .filter((m) => m.phase === phase)
                    .map((m) => m.callbackRoundTripMs),
                ),
              },
            ]),
          ),
          maxPendingRequests: b.maxPendingWorkerRequests,
          undrainedRequests: b.queue.length,
        },
        longTasks: b.longTasks,
        errors: b.errors,
      };
    });
    const metricValues = Object.fromEntries(
      metrics.metrics.map((metric) => [metric.name, metric.value]),
    );
    result.cdpMemory = {
      jsHeapUsedMB: metricValues.JSHeapUsedSize / 1e6,
      jsHeapTotalMB: metricValues.JSHeapTotalSize / 1e6,
      note: 'Main-thread V8 heap only; excludes worker heaps, canvas/GPU allocations, and native renderer memory.',
    };
    result.streaming = ingestion;
    result.pageErrors = pageErrors;
    if (cpuProfile) result.cpuProfile = cpuProfile;
    report.scenarios.push(result);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(
      JSON.stringify({
        bars: count,
        readyMs: result.readyMs,
        targetPassed: result.readyTargetPassed,
        interactionFrames: result.frames.interaction,
        stream: ingestion.map((s) => ({
          rate: s.rate,
          wallMs: s.totalWallMs,
          lost: s.uniqueEventsLost,
        })),
        workerBacklog: result.workers.maxPendingRequests,
      }),
    );
    await context.close();
  }
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  throw error;
} finally {
  await browser.close();
}
console.log(`Saved ${output}`);
