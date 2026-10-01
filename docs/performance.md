# Performance measurements

The latest advanced-pack reports are [`advanced-node.json`](../benchmarks/advanced-node.json) and [`advanced-browser.json`](../benchmarks/advanced-browser.json). They record the machine, runtime, workloads, memory samples and correctness checks. The original eight-study measurements are retained below for context. These are local observations, not hardware-independent guarantees.

## Advanced pack: all 13 studies

Measured October 1, 2026 UTC on an Apple M5, 10 logical CPUs, 34.36 GB memory, macOS kernel 25.6.0. Node was 26.7.0; browser was headless Chromium 153.0.8010.12 at 1440×1000, device scale 1, against Vite development. Node 24 remains the reference runtime and should receive its own recording before publishing comparisons.

The current harness enables all 13 studies, gives Anchored VWAP a fixed anchor at the first generated candle, and makes the last candle explicitly provisional. It validates intentional gap NaNs rather than treating them as calculation errors. The generated history and network are excluded from ready times. The browser measurement includes worker execution, result ingestion, and two animation frames.

| Workload                                                               | Recorded result |
| ---------------------------------------------------------------------- | --------------: |
| 100,000 bars, all 13, CPU calculation + materialization (median of 3)  |       435.41 ms |
| 500,000 bars, all 13, CPU calculation + materialization (median of 3)  |     2,239.98 ms |
| 100,000 bars, all 13, browser ready (single run)                       |        520.6 ms |
| 500,000 bars, candles + volume only, browser ready                     |        463.0 ms |
| Pan/zoom with 100,000 bars and all 13, p95 frame interval              |         16.8 ms |
| 1,000 trades/sec for 5 seconds, same chart, p95 frame interval         |         16.7 ms |
| 10,000 trades/sec for a 1-second burst, same chart, p95 frame interval |         16.7 ms |

Both wall-clock streams retained every offered unique trade (5,000 and 10,000), conserved final volume exactly, and drained the worker queue. At most one worker request was pending. Streaming worker calculation p95 was 0.4 / 0.7 ms; send-to-callback p95 was 1.4 / 1.6 ms. Chromium Event Timing interaction p95 was 32 ms. Both browser cases preserved the full time-axis mapping, true latest-price label during historical panning, bounded visible price rows, and recursive Heikin-Ashi values, with no page/worker errors.

Twenty time-series outputs at 500,000 bars contain approximately 10 million points and 160 MB of packed numeric pairs. The Node harness retains packed and materialized data together: sampled heap reached 1.04 GB and RSS 1.90 GB. Its 10,000 provisional revisions took 65.8–79.4 ms across trials. Browser main-thread heap samples were 255 MB for 100,000 bars/all studies and 722 MB for 500,000 bars/candles only; these exclude worker/native/GPU allocations and include temporary correctness-check data. Allocation/GC timing makes these samples unsuitable as direct memory comparisons with the baseline.

Initial ingestion and the deliberately expensive full-history correctness checks still produce long tasks; the 17 ms figures describe the interaction/streaming phases, not every frame during loading. Browser performance with 500,000 bars and all studies, very dense full-history zoom, prolonged sessions, and other hardware remains unmeasured.

```sh
npm run benchmark -- --output=benchmarks/advanced-node.json
# With the development server running, other tests and source edits paused:
npm run benchmark:browser -- --output=benchmarks/advanced-browser.json
```

## Reproduce

Default runs write ignored `benchmarks/local-node.json` and `benchmarks/local-browser.json`, preserving the committed reference measurements. Use `--output` to choose a different report path.

```sh
node --expose-gc --import tsx scripts/benchmark.ts
# Optional:
node --expose-gc --import tsx scripts/benchmark.ts --repetitions=5 --output=benchmarks/my-machine.json
```

The current script runs 100,000 and 500,000 generated one-minute candles with seed 42 and all registered indicators. The archived baseline in `baseline-eight-node.json` used eight indicators and eleven output series; the advanced report above uses thirteen and twenty. Volume Profile uses the newest 500 visible bars. Each history case has three measured repetitions by default. Synthetic history generation is measured separately and excluded from calculation timing. `--expose-gc` allows garbage collection between repetitions; the report records whether it was available.

The benchmark separately times history calculation, packing numeric output buffers, materializing renderer-facing point objects, and 10,000 revisions of an unfinished candle. It keeps the full history available throughout. Revisions change close and cumulative volume while remaining inside the same candle's high/low bounds. This tests the common incremental path, not the slower profile rebinning path when a price extent changes.

## Original eight-study CPU result

Measured 2026-10-01 UTC on an Apple M5, 10 logical CPUs, 34.36 GB system memory, macOS kernel 25.6.0, arm64, Node 26.7.0. The project's reference runtime is Node 24; this recording uses the locally installed runtime and should be repeated on Node 24 before publishing a comparison.

| Workload                     | Median calculation plus object materialization | Provisional browser-ready target | Status                                                   |
| ---------------------------- | ---------------------------------------------: | -------------------------------: | -------------------------------------------------------- |
| 100,000 bars, all indicators |                                      141.92 ms |                         2,000 ms | CPU subtotal within target; browser readiness unmeasured |
| 500,000 bars, all indicators |                                      735.23 ms |                         5,000 ms | CPU subtotal within target; browser readiness unmeasured |

At 500,000 bars, the eleven time-series outputs contain 5,499,787 points and use approximately 88 MB as packed time/value Float64 pairs. In this benchmark, materializing all points used about 539 MB of JavaScript heap and sampled process RSS reached 1.11 GB. The harness retains both packed output and materialized objects during sampling; these figures include that duplication and allocator retention from previous trials. Memory values are samples, not instrumented peak allocations or browser tab measurements.

The 10,000 forming-candle revisions took 14.20–57.22 ms across the six recorded trials. The variable timing includes JIT/GC effects and should not be interpreted as a guaranteed market event rate. These calls calculate state; they do not render 10,000 frames.

## Ingestion and batching

The second workload replays deterministic trade events through the actual `TradeBarAggregator`, `createBarBatcher`, and `BarStore`. A virtual clock controls 60 Hz flushes. All unique trades enter aggregation before bar snapshots are coalesced. Extra duplicate IDs check that duplicate volume is rejected. An independent reference accumulator verifies each final OHLCV bar and total volume.

| Virtual workload                        | Unique trades | Measured CPU replay | Lost unique events | Final OHLCV |
| --------------------------------------- | ------------: | ------------------: | -----------------: | ----------- |
| 1,000 trades/sec for 60 virtual seconds |        60,000 |            14.82 ms |                  0 | Exact match |
| 10,000 trades/sec for 5 virtual seconds |        50,000 |             8.66 ms |                  0 | Exact match |

Maximum coalescing queues contained two and one distinct candle timestamps, respectively. All 61 and 51 deliberately duplicated events were rejected. These are **unpaced CPU replays**, not real-time soaks. The measured throughput excludes WebSocket I/O, JSON parsing, worker transit, indicator calculation, chart updates, and browser scheduling. It proves event accounting for these inputs, not end-to-end sustained capacity.

## Browser acceptance and remaining costs

Browser measurements must report browser/version, viewport, device pixel ratio, hardware, bar count, active indicators, and the interaction performed. The CPU report leaves browser metrics as `NOT_MEASURED`; a passing CPU subtotal must not be reported as a passing browser-ready target.

Measure initial candles and all requested indicators ready, p95 animation-frame interval during pan/zoom and streaming, p95 input-to-next-paint, worker calculation/round-trip time, memory, and reconnect/pagination stalls. Initial targets are 2 seconds for 100,000 bars, 5 seconds for 500,000 bars, p95 frame interval at most 33 ms, and p95 interaction-to-paint at most 100 ms. Browser test results and traces should be retained separately from the Node report.

The current design avoids per-trade React renders and indicator recomputation of unchanged history. Live changes use transferable typed buffers and the renderer's update API. Volume Profile searches the visible time bounds before scanning candles. History prepends and parameter changes correctly rebuild recursive indicators; changing a profile's minimum or maximum price correctly rebuilds its bins. Those rebuilds run in a worker, and symbol/timeframe reset terminates obsolete workers.

Full-history point materialization remains a significant cost. The renderer now keeps full-resolution indicator results in its own cache, while supplying visible points plus 1,000 bars of overscan on each side to Lightweight Charts. Price and volume use the same bounded rendering window. An invisible series holds the complete canonical time axis, so logical indexes and drawing anchors continue to refer to all history. The main price series also retains the actual latest candle while viewing history, preserving the native current-price label. Heikin-Ashi is calculated recursively before slicing. Zooming out can expand the window; native conflation then handles dense displays. Calculations always use original full-resolution OHLCV.

## Original eight-study browser result

The original browser recording is [`benchmarks/baseline-eight-browser.json`](../benchmarks/baseline-eight-browser.json). The same harness now includes the advanced studies; run it against a development server:

```sh
npm run dev
# In another terminal, with source edits and other browser workloads paused:
node scripts/browser-benchmark.mjs
```

Optional flags are `--url=http://127.0.0.1:5173`, `--bars=100000`, `--profile`, and `--output=benchmarks/my-browser.json`. The harness uses the explicit `?dev=1` testing surface, disposes the simulator, then drives the real renderer and bundled indicator worker. It does not contact a market provider. Raw CPU profiles are ignored by Git; the numeric report includes the top sampled functions when profiling is enabled.

Measured on the same Apple M5 machine in headless Chromium 153.0.8010.12, viewport 1440×1000, device pixel ratio 1, against Vite's development server. These are single runs, not cross-machine guarantees. Readiness means candle/volume data and requested indicator series have been ingested, followed by two animation-frame callbacks; generated history creation and network loading are excluded.

| Browser workload                   | Measured ready time |   Target | Result |
| ---------------------------------- | ------------------: | -------: | ------ |
| 100,000 bars, all eight indicators |            217.3 ms | 2,000 ms | Passed |
| 500,000 bars, candles and volume   |            471.2 ms | 5,000 ms | Passed |

The 500,000-bar browser scenario intentionally has no indicators. All eight indicators at that size were measured in the CPU benchmark, but not in the browser benchmark.

| Interaction / stream                                         | p95 frame interval | Target | Unique events lost |
| ------------------------------------------------------------ | -----------------: | -----: | -----------------: |
| Pan/zoom, 100,000 bars and all indicators                    |            16.7 ms | ≤33 ms |                  — |
| 1,000 trades/sec, 5 seconds, 100,000 bars and all indicators |            16.8 ms | ≤33 ms |         0 of 5,000 |
| 10,000 trades/sec, 1-second burst, same chart                |            16.7 ms | ≤33 ms |        0 of 10,000 |
| Pan/zoom, 500,000 bars, candles and volume                   |            16.7 ms | ≤33 ms |                  — |

Unlike the Node replays, these stream tests are wall-clock paced. Every offered unique trade is aggregated before bar coalescing; final volume exactly matched the expected total. They completed in 5,031.8 and 1,032.0 ms, including worker draining and two subsequent animation frames. Worker p95 calculation time was 0.1 ms for both; p95 send-to-callback time was 1.3 and 1.2 ms. At most two requests were pending, and the queue drained completely.

Chromium Event Timing reported p95 interaction durations of 32 ms for the 100,000-bar chart and 24 ms for 500,000 bars, below the 100 ms target. These measurements cover pan/zoom interactions before the streaming phases. A separate input-dispatch-to-two-animation-frames proxy measured 30.6 and 31.1 ms; it is not a direct compositor presentation timestamp. Event Timing excludes entries below its 16 ms reporting threshold.

The browser harness verifies that hidden timeline coordinates match full-history logical indexes, historical windows still expose the true latest price, only 2,502 price rows are supplied for a sampled 500-bar historical viewport, and Heikin-Ashi values match the full recursive calculation. Both cases completed without page or worker errors. Main-thread heap samples were approximately 403 MB and 416 MB; these exclude worker, canvas, GPU, and native allocations and include temporary correctness-check data.

## Bottleneck found and fixed

The initial full-series rendering approach loaded quickly but rebuilt all chart-library raw points on each update. CPU samples were dominated by raw-point/color construction and garbage collection; indicator worker calculations remained around 0.1 ms. The profiled baseline in [`browser-before-optimization.json`](../benchmarks/browser-before-optimization.json) recorded 200 ms p95 stream frame intervals and a roughly 1.05 GB main-thread heap. Profiling adds overhead, so that recording is diagnostic rather than a controlled timing comparison.

Rendering bounded price, volume, and indicator windows removed those full-history redraw allocations. The final unprofiled run met the loading, stream frame, and interaction targets above while retaining full data and correct coordinates. Network reconnect performance, prolonged live sessions, mobile performance, other hardware, and 500,000 bars with all indicators still need separate performance recordings.
