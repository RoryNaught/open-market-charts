import { cpus, platform, release, arch, totalmem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Bar, Trade } from '@omc/provider-sdk';
import { BarStore, createBarBatcher, generateBars, TradeBarAggregator } from '@omc/data-engine';
import { createIndicatorConfig, IndicatorEngine, INDICATOR_TYPES } from '@omc/indicator-engine';

const options = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, value] = argument.split('=');
    return [key, value ?? 'true'];
  }),
);
const repetitions = Number(options.get('--repetitions') ?? 3);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
  throw new Error('--repetitions must be an integer between 1 and 20');
const output = resolve(options.get('--output') ?? 'benchmarks/local-node.json');
const round = (value: number) => Math.round(value * 100) / 100;
const percentile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * fraction))
  ];
const memory = () => {
  const value = process.memoryUsage();
  return {
    rssMB: round(value.rss / 1e6),
    heapMB: round(value.heapUsed / 1e6),
    arrayBuffersMB: round(value.arrayBuffers / 1e6),
  };
};
const configs = INDICATOR_TYPES.map((type, i) => {
  const config = createIndicatorConfig(type, `benchmark-${i}`);
  if (type === 'AnchoredVWAP') config.params.anchorTime = Date.UTC(2024, 0, 1);
  return config;
});
const now = () => performance.now();

function engineTrial(count: number) {
  global.gc?.();
  const beforeMemory = memory();
  const generationStart = now();
  const bars = generateBars(count, { seed: 42, start: Date.UTC(2024, 0, 1) });
  bars[bars.length - 1] = { ...bars[bars.length - 1], closed: false };
  const generationMs = now() - generationStart;
  const engine = new IndicatorEngine(configs, {
    volumeProfileRange: { from: bars[count - 500].time, to: bars[count - 1].time },
  });
  const buildStart = now();
  engine.setData(bars);
  const buildMs = now() - buildStart;
  const buildMemory = memory();
  const packStart = now();
  const packed = engine.getPackedResults();
  const packMs = now() - packStart;
  const outputBytes = packed.reduce(
    (sum, result) =>
      sum + result.outputs.reduce((total, series) => total + series.values.byteLength, 0),
    0,
  );
  const materializeStart = now();
  const results = engine.getResults();
  const materializeMs = now() - materializeStart;
  const outputPoints = results.reduce(
    (sum, result) =>
      sum + result.outputs.reduce((total, series) => total + series.values.length, 0),
    0,
  );
  const materializedMemory = memory();
  const last = bars[count - 1];
  const revisions = 10_000;
  const updateStart = now();
  for (let i = 0; i < revisions; i++)
    engine.updateBar({
      ...last,
      close: last.low + (last.high - last.low) * (0.5 + Math.sin(i / 13) * 0.49),
      volume: last.volume + i,
    });
  const updateMs = now() - updateStart;
  const visibleProfileVolume =
    results.find((result) => result.profile)?.profile?.totalVolume ?? NaN;
  const expectedProfileVolume = bars.slice(-500).reduce((sum, bar) => sum + bar.volume, 0);
  const validLastValues = packed.every((result) =>
    result.outputs.every(
      (series) =>
        !series.values.length ||
        Number.isFinite(series.values.at(-1)) ||
        (series.gaps === true && Number.isNaN(series.values.at(-1))),
    ),
  );
  const checks = {
    validLastValues,
    profileVolumeConserved: Math.abs(visibleProfileVolume - expectedProfileVolume) < 1e-6,
  };
  if (Object.values(checks).some((value) => !value))
    throw new Error('Engine benchmark correctness check failed');
  return {
    generationMs: round(generationMs),
    buildMs: round(buildMs),
    packMs: round(packMs),
    materializeMs: round(materializeMs),
    // This includes numeric calculation plus object materialization, not browser rendering or worker transit.
    calculationAndMaterializationMs: round(buildMs + materializeMs),
    liveRevisions: revisions,
    liveRevisionTotalMs: round(updateMs),
    liveRevisionsPerSecond: Math.round((revisions * 1000) / updateMs),
    outputPoints,
    outputBufferMB: round(outputBytes / 1e6),
    beforeMemory,
    buildMemory,
    materializedMemory,
    checks,
  };
}

function ingestionTrial(rate: number, virtualSeconds: number) {
  const count = rate * virtualSeconds;
  const start = Date.UTC(2026, 0, 5, 12, 0, 30);
  const bucket = (time: number) => Math.floor(time / 60_000) * 60_000;
  const aggregator = new TradeBarAggregator(bucket, Math.max(100_000, count + 1));
  const store = new BarStore();
  const expected = new Map<number, Bar>();
  let pending: (() => void) | undefined;
  let maxPendingBars = 0,
    accepted = 0,
    duplicatesRejected = 0,
    flushes = 0;
  const pendingTimes = new Set<number>();
  const flushDurations: number[] = [];
  const batcher = createBarBatcher(
    (bars) => {
      const started = now();
      for (const bar of bars) store.update(bar);
      pendingTimes.clear();
      flushes++;
      flushDurations.push(now() - started);
    },
    (callback) => {
      pending = callback;
    },
  );
  let nextFrame = start + 1000 / 60;
  const started = now();
  for (let i = 0; i < count; i++) {
    const trade: Trade = {
      id: String(i),
      sequence: i,
      symbol: 'BENCH',
      time: start + (i * 1000) / rate,
      price: 100 + Math.sin(i / 47) * 2,
      size: 1 + (i % 5),
    };
    while (trade.time >= nextFrame) {
      const flush = pending;
      pending = undefined;
      flush?.();
      nextFrame += 1000 / 60;
    }
    const bar = aggregator.add(trade);
    if (bar) {
      accepted++;
      pendingTimes.add(bar.time);
      maxPendingBars = Math.max(maxPendingBars, pendingTimes.size);
      batcher.push(bar);
    }
    if (i % 997 === 0 && !aggregator.add(trade)) duplicatesRejected++;
    const time = bucket(trade.time),
      reference = expected.get(time);
    if (reference) {
      reference.high = Math.max(reference.high, trade.price);
      reference.low = Math.min(reference.low, trade.price);
      reference.close = trade.price;
      reference.volume += trade.size;
    } else
      expected.set(time, {
        time,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.size,
      });
  }
  pending?.();
  batcher.dispose();
  const durationMs = now() - started;
  const expectedVolume = [...expected.values()].reduce((sum, bar) => sum + bar.volume, 0);
  const actualVolume = store.bars.reduce((sum, bar) => sum + bar.volume, 0);
  const correctBars =
    store.length === expected.size &&
    store.bars.every((bar) => {
      const reference = expected.get(bar.time)!;
      return ['open', 'high', 'low', 'close', 'volume'].every(
        (key) =>
          Math.abs((bar[key as keyof Bar] as number) - (reference[key as keyof Bar] as number)) <
          1e-9,
      );
    });
  const eventLoss = count - accepted;
  if (eventLoss !== 0 || actualVolume !== expectedVolume || !correctBars)
    throw new Error('Ingestion lost events or changed OHLCV');
  return {
    tradesPerVirtualSecond: rate,
    virtualSeconds,
    uniqueTrades: count,
    replayMode:
      'Unpaced virtual clock; 60 Hz coalescing. Measures CPU capacity, not a wall-clock soak.',
    durationMs: round(durationMs),
    processedTradesPerCpuSecond: Math.round((count * 1000) / durationMs),
    accepted,
    eventLoss,
    duplicatesRejected,
    expectedDuplicates: Math.ceil(count / 997),
    expectedVolume,
    actualVolume,
    exactOHLCV: correctBars,
    emittedBars: store.length,
    flushes,
    maxPendingBars,
    flushP50Ms: round(percentile(flushDurations, 0.5)),
    flushP95Ms: round(percentile(flushDurations, 0.95)),
  };
}

const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: platform(),
    release: release(),
    architecture: arch(),
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    systemMemoryGB: round(totalmem() / 1e9),
    explicitGcAvailable: typeof global.gc === 'function',
  },
  methodology: {
    repetitions,
    seed: 42,
    indicators: INDICATOR_TYPES,
    profileVisibleBars: 500,
    generatorExcludedFromCalculation: true,
    networkAndBrowserExcluded: true,
  },
  history: [100_000, 500_000].map((count) => {
    const trials = Array.from({ length: repetitions }, () => engineTrial(count));
    const medianCpuReadyMs = percentile(
      trials.map((trial) => trial.calculationAndMaterializationMs),
      0.5,
    );
    const provisionalReadyTargetMs = count === 100_000 ? 2000 : 5000;
    console.log(
      `${count.toLocaleString()} bars: median calculate + materialize ${medianCpuReadyMs} ms; target ${provisionalReadyTargetMs} ms applies to browser readiness, not this CPU-only measurement.`,
    );
    return {
      bars: count,
      trials,
      medianCpuReadyMs,
      provisionalReadyTargetMs,
      cpuSubtotalWithinTarget: medianCpuReadyMs <= provisionalReadyTargetMs,
      browserReadyTargetStatus: 'NOT_MEASURED',
    };
  }),
  ingestion: [ingestionTrial(1000, 60), ingestionTrial(10_000, 5)],
  browser: {
    frameIntervalP95Ms: null,
    inputToPaintP95Ms: null,
    workerRoundTripP95Ms: null,
    status: 'NOT_MEASURED: run browser benchmark separately',
  },
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(`Saved ${output}`);
console.log(
  `Ingestion: ${report.ingestion.map((result) => `${result.tradesPerVirtualSecond}/s virtual, ${result.eventLoss} lost, ${result.processedTradesPerCpuSecond.toLocaleString()}/s CPU throughput`).join('; ')}`,
);
