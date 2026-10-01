# Indicators and community plugins

`@omc/indicator-engine` calculates indicators from original OHLCV. It has no React, canvas, or chart-library dependency. Displaying Heikin-Ashi does not change its input. All timestamps are UTC milliseconds, including outputs.

## Use the engine

```ts
import { IndicatorEngine, createIndicatorConfig, calculateIndicators } from '@omc/indicator-engine';

const sma = createIndicatorConfig('SMA', 'my-sma');
sma.params.period = 50;
const engine = new IndicatorEngine([sma, createIndicatorConfig('RSI')]);
engine.setData(history);
const initial = engine.getResults();
const changes = engine.update(nextBar);
// engine.lastChange tells the renderer whether changes replace all data or update it.
engine.prepend(olderHistory);
engine.addIndicator(createIndicatorConfig('ATR'));
engine.removeIndicator(sma.id);
```

`calculateIndicators(bars, configs, context?)` provides a stateless batch convenience function. `setData`, `setIndicators`, `prepend`, and `setContext` rebuild against the complete current history. `updateBar` changes state without allocating result points; `update` additionally returns result objects. `getPackedResults` exposes transferable numeric output buffers. The engine keeps its own numeric history, so a provider mutating a previously passed object cannot change calculation state.

`IndicatorConfig` contains `id`, `type`, numeric `params`, `color`, and `pane` (`price` or `separate`). IDs identify instances, allowing several SMA periods simultaneously. Generated IDs use UUIDs so newly added indicators do not collide with restored workspaces. `defaultRegistry.get(type)` exposes the display name, optional category/description, validated parameter rules, and output definitions. Invalid periods and duplicate instance IDs throw descriptive errors. Annotation-only definitions normalize to the price pane.

Results contain `id`, `type`, and outputs with `key`, `kind` (`line` or `histogram`), `color`, and `{time, value, color?}[]`. A point's color overrides the output color. An output declaring `gaps: true` retains `NaN` points as explicit whitespace; the renderer must preserve them to avoid connecting separated segments. Other outputs omit unavailable values. A volume profile instead supplies `profile.bins`, `profile.totalVolume`, and `profile.pointOfControl` (the winning bin midpoint). `status?: {state: 'needs-input' | 'incomplete', message: string}` describes a missing anchor or missing required history/calendar.

## Calculation conventions

| Type              | Defaults and conventions                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SMA`             | 20 closing prices; first output after 20 observations.                                                                                                 |
| `EMA`             | 20 closes; first 20 values seed an SMA, then alpha `2/(period+1)`.                                                                                     |
| `VWAP`            | Cumulative typical price `(high+low+close)/3` weighted by volume; resets by session. Zero cumulative volume has no output.                             |
| `RSI`             | 14 close differences with SMA-seeded Wilder smoothing (`1/period`). Flat = 50, only gains = 100, only losses = 0.                                      |
| `MACD`            | EMA12 minus EMA26, with an SMA-seeded EMA9 signal; histogram is MACD minus signal.                                                                     |
| `Bollinger`       | SMA20 and two population standard deviations. Uses removable Welford moments to avoid subtracting large squared sums.                                  |
| `ATR`             | Wilder-smoothed 14-period true range; first bar uses high minus low. Subsequent true ranges include gaps from the previous close.                      |
| `VolumeProfile`   | 50 equal-width price bins across the visible range; volume distributed proportionally over each candle's high–low overlap.                             |
| `AnchoredVWAP`    | Fixed UTC-ms `anchorTime` (0 means unset), HLC3 weighted by volume; population deviation bands at `bands1=1` and `bands2=2`.                           |
| `Supertrend`      | Wilder ATR10, multiplier3, initially down; strict close crossings flip direction. Separate up/down lines retain explicit gaps.                         |
| `SqueezeMomentum` | Period20, Bollinger2 population deviations vs Keltner1.5 times SMA(true range); regression endpoint of detrended close, with four momentum colors.     |
| `MarketStructure` | Strict pivots with 3 left/3 right closed candles; first break MSS, continuation BOS, reversal CHoCH; optional wick sweeps (on), latest100 annotations. |
| `FairValueGaps`   | Strict three-candle wick gaps, minimum gap0%, cross-session allowed; latest100 zones retained with active/touched/filled status.                       |

Warm-up outputs are absent or explicit whitespace, never fabricated zeros. The squeeze state deliberately uses a zero baseline after its own warm-up. Missing market intervals do not create synthetic observations. Indicators do not reset at a trading halt or an ordinary session boundary, except VWAP. Periods count available bars.

`IndicatorContext` accepts `timezone`, provider `sessions`, `vwapAnchor` (`session`, `week`, or `month`), and `volumeProfileRange: {from, to}`. Supply provider session intervals where available; without them, the session anchor uses the exchange timezone's calendar date (UTC by default). Set `vwapAnchor: 'month'` for daily/weekly charts. The week anchor starts Monday. This is an explicit adapter choice, not guessed from gaps between bars.

Volume Profile is **estimated from OHLCV**, not measured volume at individual trade prices or inferred buy/sell activity. A zero-range candle contributes to one bin; an entirely flat market receives a small symmetric price extent. The sum of bin volumes equals selected input volume within floating-point tolerance. The lowest-price bin wins POC ties. Empty/zero-volume input has no POC. `setVisibleRange(from, to)` recomputes only profiles; binary search bounds work to the visible observations.

## Advanced studies and confirmation

Anchored VWAP starts at the first loaded candle whose opening timestamp is at or after the selected fixed timestamp. It never resets at a session boundary. For typical price `p`, positive candle volume `v`, old total weight `W`, and old mean `mu`, the weighted Welford update is `W'=W+v`, `delta=p-mu`, `mu'=mu+delta*v/W'`, and `M2'=M2+v*delta*(p-mu')`. Deviation is `sqrt(max(0,M2')/W')`; the two bands are `mu' ± bandsN*deviation`. Zero volume contributes nothing. This is variance of candle HLC3 weighted by candle volume, not observed intrabar trade-price variance. An anchor older than the loaded history suppresses all output and reports incomplete history; prepending sufficient history resolves it without moving the anchor. Choosing an anchor on an existing candle follows the [manual anchored-VWAP convention](https://www.tradingview.com/support/solutions/43000669764-anchored-vwap-drawing-tool/).

See [advanced trend formulas](advanced-trends.md) for exact Supertrend trailing-band rules, squeeze regression, seeds, and warm-up. The squeeze implementation uses the public Bollinger/Keltner compression and momentum family described in [TTM Squeeze documentation](https://toslc.thinkorswim.com/center/reference/Tech-Indicators/studies-library/T-U/TTM-Squeeze); our precise variant is documented and is not an assertion that proprietary products produce identical values.

Market Structure accepts a pivot only when its high is strictly greater (or low strictly smaller) than all `leftBars+rightBars` neighbors. Equal highs/lows do not qualify. The pivot becomes usable only after all right-hand candles close; it cannot trigger a break on its confirmation candle. A subsequent closed candle strictly beyond the most recent unconsumed swing level emits a break once: initial direction establishes MSS, the same direction emits BOS, and the opposite direction emits CHoCH. An optional sweep requires a wick strictly beyond a known swing, a close strictly back inside, and the preceding close inside or at that level; one sweep is emitted per swing. These are explicit price-pattern conventions inspired by the [public market-structure terminology](https://docs.luxalgo.com/platform/algos/price-action-concepts/market-structures), not measured order-book liquidity. [Price-action study documentation](price-action.md) details both structure and gap conventions, retention, and edge cases.

Fair Value Gaps compare the third candle with the first: bullish if `low[2] > high[0]`, bearish if `high[2] < low[0]`. The middle candle's body direction is unrestricted. The percentage filter divides gap width by the absolute middle close; with a positive threshold, zero middle close cannot qualify. Formation confirms at the third close. Later closed-candle wicks at the near boundary mark touched; reaching the far boundary marks filled and records `endTime`. Original price boundaries remain fixed; the forming candle cannot mitigate its own zone. Optional `withinSession=1` requires all three candles inside the same supplied exchange session; absent calendar data reports needs-input. A gap indicates this three-candle pattern, not proof that no trades occurred at those prices. See the [public imbalance terminology](https://docs.luxalgo.com/platform/algos/price-action-concepts/imbalances).

Annotations are a bounded **full snapshot** on every result, including incremental results; replace the previous annotation list rather than append. Supertrend/Squeeze retain up to 200 events; MarketStructure/FairValueGaps use `maxAnnotations` (default100, maximum500). Their common contract is:

```ts
interface IndicatorAnnotation {
  id: string;
  kind: 'level' | 'zone' | 'marker';
  time: number;
  endTime?: number;
  price: number;
  price2?: number;
  text: string;
  color: string;
  originTime?: number;
  confirmedAt: number;
  status?: 'active' | 'touched' | 'filled';
}
```

`time` and `confirmedAt` identify the confirming candle by its **opening** UTC-ms timestamp. The event becomes available only once that candle closes, not at that timestamp. `originTime` records an earlier swing/formation candle for context; it does not backdate signal availability. Supertrend and squeeze numeric previews can change while a candle forms, but reversal/release annotations wait for confirmation. Structure and gap annotations, including mitigation state, use closed candles only. Expanded history or provider corrections can change historical results; closed-bar confirmation prevents intrabar flicker, not all forms of [recalculation/repainting](https://www.tradingview.com/pine-script-docs/concepts/repainting/).

## Streaming, corrections, and workers

The engine snapshots each kernel immediately before the newest candle. Replacing that candle restores the snapshot before recalculating, so 1,000 revisions do not compound EMA or count VWAP volume 1,000 times. In a historical batch, every candle except the final one is confirmed by the existence of its successor. The final candle confirms only with `closed: true`; an omitted flag is provisional. A later timestamp first restores and replays its predecessor as confirmed, then begins the new candle. Explicit closure is monotonic during same-timestamp corrections. No calculation uses wall-clock time to guess closure.

Rollover deltas can contain **both** the preceding and newest timestamps, since closure may add a signal or value to the preceding candle. `engine.lastChangedFrom` records the earliest changed timestamp; `getPackedResults(false, engine.lastChangedFrom)` retrieves that delta. Older timestamps rebuild the complete calculation, as do prepends, because older history changes recursive seeds. The newest copy of a duplicate timestamp wins during `setData`; during `prepend`, currently loaded values win over overlapping fetched history.

`engine.lastChange` is `update` for an ordinary newest-bar change and `reset` for a historical correction or removal of a previously valid point. Respect it in a renderer: a zero-volume correction can remove a VWAP point. The initial history must be sorted only at ingestion; live updates never sort or recalculate unchanged history. A profile whose price bounds expand or retract rebuilds its bins; otherwise it removes the old candle contribution and adds the replacement.

```ts
import { IndicatorWorkerClient } from '@omc/indicator-engine';

const worker = new IndicatorWorkerClient({
  onResults(results, mode) {
    renderer.renderIndicators(results, mode);
  },
  onError(error) {
    reportIndicatorError(error.message);
  },
  onMetrics({ durationMs, mode }) {
    recordCalculationTime(durationMs, mode);
  },
});
worker.reset(history, configs, { timezone: 'America/New_York' });
worker.update(changedBars); // A single Bar or an array; retains all new bar timestamps.
worker.setVisibleRange(visibleStart, visibleEnd);
worker.setIndicators(updatedConfigs);
worker.dispose();
```

The bundled module worker transports bars as eight Float64 values: time, open, high, low, close, volume, closed flag (`-1` unknown, `0` provisional, `1` closed), and provider revision (`NaN` absent). `PACKED_BAR_STRIDE` exposes this width. Output points use transferable time/value pairs plus an optional aligned color array; intentional NaN gaps survive transport. Annotations/status are structured metadata. History and output buffers grow geometrically. Resets terminate obsolete workers; generation and request checks also reject stale queued responses. The worker reports calculation errors explicitly. Dispose it when replacing a controller. Rendering and React state updates remain the host's responsibility; batch market events before sending them to the worker.

## Write a plugin

`src/example-plugin.ts` contains a complete candle-range histogram. A definition provides a stable `type`, `name`, integer `version`, placement, numeric parameter rules, output metadata, and `create(params, context)`. Each factory call must create independent state. Its kernel implements:

```ts
interface IndicatorKernel {
  step(
    bar: Readonly<Bar>,
    index: number,
    context?: { isConfirmed: boolean },
  ): Record<string, number | undefined>;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
  colors?(): Record<string, string | undefined>;
  annotations?(): IndicatorAnnotation[];
  status?(): { state: 'needs-input' | 'incomplete'; message: string } | undefined;
}
```

Return `undefined` during warm-up. Use finite numbers after warm-up; declaring `gaps: true` turns unavailable values into retained whitespace. `colors()` provides per-output colors for the current step. Use `context.isConfirmed` for committed events; when calling a kernel directly without context, built-ins conservatively require `bar.closed === true` to emit events. Snapshots must be independent copies of mutable state, or safely share deeply immutable data; `restore` must not mutate the stored snapshot. Include colors, annotations, and warm-up state in snapshots. Bound retained annotations. Avoid any renderer access, network calls, or nondeterministic values. The same bars and parameters must produce the same values through batch and streaming paths.

```ts
import { defaultRegistry, candleRangePlugin } from '@omc/indicator-engine';
const unregister = defaultRegistry.register(candleRangePlugin);
// Create a config with type: 'CommunityCandleRange'.
// Call unregister() once no instances need this definition.
```

Registration is local to a JavaScript realm. To run a community plugin in the worker, import and register its module in `src/worker.ts` before installing the message handler, as well as in the application for configuration metadata. v1 supports compiled local plugins; it does not fetch arbitrary scripts or provide a marketplace. Plugin code is application code and must be reviewed by its integrator.

## Verification

Run `npx vitest run --root . packages/indicator-engine`. Tests cover known numerical examples, warm-up/flat/zero-volume behavior, session anchors, historical gaps, stable variance, dynamic instances, batch/incremental equivalence, repeated unfinished-bar revisions, overlapping prepends, corrections, profile volume conservation, plugin registration, typed transport, and stale worker responses. End-to-end worker execution and viewport integration belong to the application's browser tests. Record actual timings on named hardware before claiming any performance target has passed.
