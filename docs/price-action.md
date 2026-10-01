# Price-action studies

Market Structure and Fair Value Gaps are original, deterministic OHLCV studies. Their formulas and lifecycle rules are documented here. They do not reproduce proprietary indicator code, detect actual stop orders, or imply that a chart pattern predicts a profitable trade.

## Confirmation and timestamps

These studies advance only on confirmed candles. Forming-bar updates do not create, move, touch, or fill their annotations. The engine preserves `Bar.closed` through worker transport and confirms the preceding candle when a newer candle arrives. Historical bars preceding the newest bar are confirmed; the final bar requires an explicit closed flag or subsequent rollover.

`time` and `confirmedAt` are the UTC-millisecond **opening timestamp of the candle whose close confirmed an event**. The event is not available at that opening instant. `originTime` identifies its source pivot or first pattern candle. An optional dashed reference line can extend back to the source, but the event label stays on its confirmation candle. These distinctions matter when reviewing historical charts or integrating a future alert system.

Confirmed events are stable when additional closed candles are appended to the same history. Historical feed corrections and loading additional warmup history can change the calculated structure; the engine replays amended history. “Confirmed” therefore does not mean “immune to corrected source data.”

## Market Structure

The default pivot has three candles on each side. A candidate high must be strictly higher than every other high in its `leftBars + rightBars + 1` window. A low must be strictly lower. Equal-high and equal-low plateaus are excluded. A pivot becomes usable only after all right-side candles close.

The study tracks the latest confirmed swing high and low. Each can trigger one close break. A newer confirmed pivot replaces the older reference of the same kind.

- A close strictly above an unconsumed swing high is an upward break. A close strictly below an unconsumed swing low is a downward break. Equality does not count.
- The first break initializes direction and is labeled **MSS** (market structure shift).
- A subsequent break in the established direction is **BOS** (break of structure).
- A break in the opposite direction is **CHoCH** (change of character), and establishes the new direction.

The optional `sweeps` setting enables price-based swing-level rejections. A high sweep requires a wick above a known swing high, a close strictly below it, and the preceding close at or below it. A low sweep uses the inverse comparisons. Each swing can produce only one sweep; a later genuine close break remains possible. An outside candle can sweep both sides, and the study makes no claim about which side traded first.

Sweeps are OHLC price patterns. They do not measure resting liquidity, hidden orders, participant intent, or whether another trader's stop was triggered. The implementation does not include later failed-breakout/retest variants or equal-high liquidity clustering.

| Parameter        | Default | Range          |
| ---------------- | ------- | -------------- |
| `leftBars`       | 3       | 1–50 integer   |
| `rightBars`      | 3       | 1–50 integer   |
| `sweeps`         | 1       | 0 off, 1 on    |
| `maxAnnotations` | 100     | 10–500 integer |

## Fair Value Gaps

Use three consecutive confirmed input candles, indexed `t−2`, `t−1`, and `t`:

- Bullish: `low[t] > high[t−2]`. The zone is `[high[t−2], low[t]]`.
- Bearish: `high[t] < low[t−2]`. The zone is `[high[t], low[t−2]]`.

Equality is not a gap. No candle-body direction or displacement filter is implied. An optional minimum size compares `100 × zone width / abs(close[t−1])` with `minGapPercent`. A zero middle close cannot satisfy a positive percentage threshold.

The original price bounds never shrink. The zone begins visibly on the third candle, when it becomes known. Existing zones update before new zones are created, so a formation candle cannot mitigate its own zone.

| State   | Bullish zone                                     | Bearish zone                                      |
| ------- | ------------------------------------------------ | ------------------------------------------------- |
| Active  | Formation confirmed                              | Formation confirmed                               |
| Touched | A later low reaches the upper boundary           | A later high reaches the lower boundary           |
| Filled  | A later low reaches or passes the lower boundary | A later high reaches or passes the upper boundary |

A zone can move directly from active to filled. Once filled, its state and `endTime` are fixed unless source data is corrected. Filled zones remain in the retained annotation history. A gap over a boundary qualifies under these OHLC comparisons; “filled” does not assert that every intervening price traded.

`withinSession = 1` requires all three candles to fall inside the same supplied exchange session, including that session's extended-hours interval. A missing calendar produces a `needs-input` status and no new zones. A timestamp outside the supplied calendar is ineligible. A 24/7 feed normally leaves this option off. The engine treats consecutive supplied bars as consecutive candles; it does not fabricate bars for empty intervals.

| Parameter        | Default | Range          |
| ---------------- | ------- | -------------- |
| `minGapPercent`  | 0       | 0–10           |
| `withinSession`  | 0       | 0 off, 1 on    |
| `maxAnnotations` | 100     | 10–500 integer |

## Engine and renderer boundary

Both definitions are advanced, price-pane studies with no numeric line output. `priceActionDefinitions` exports `MarketStructure` and `FairValueGaps`. They use the shared `IndicatorKernel` interface and return bounded full annotation snapshots.

Structure breaks return `level` annotations with a source-pivot `originTime`; sweeps return `marker` annotations at the wick extreme, with the reference level in `price2`. FVGs return `zone` annotations with `price` as the lower bound, `price2` as the upper bound, `status`, and `endTime` only after filling.

Annotation IDs derive from feature type and market timestamps rather than array indices. Retention removes the oldest annotation when the configured count is exceeded, even if an old FVG remains active. This is a display/history bound, not a claim that the old zone stopped being relevant.

Kernel state uses frozen, immutable structures. Snapshots capture and restore a reference in constant time; newer calculations never mutate older snapshots. The rolling candle window and retained annotations are bounded by parameters. Forming-bar calls return immediately. Exported annotation arrays are copied so renderer mutation cannot corrupt calculation state.

## Validation

`price-action.test.ts` tests pivot delay and strict ties, MSS/BOS/CHoCH direction, consumed levels, single and double sweeps, gap bounds and lifecycle, formation-bar exclusion, unconfirmed-bar revisions, session filtering, bounded retention, immutable rollback, historical corrections, packed worker confirmation flags, and batch/stream equivalence.

Concept references: [market structure terminology](https://docs.luxalgo.com/platform/algos/price-action-concepts/market-structures), [three-candle imbalances and mitigation variants](https://docs.luxalgo.com/platform/algos/price-action-concepts/imbalances), [sweep variants](https://www.luxalgo.com/library/indicator/liquidity-sweeps/), and [confirmation/repainting pitfalls](https://www.tradingview.com/pine-script-docs/concepts/repainting/). The exact rules above are this project's published conventions, not claims of equivalence to a vendor's implementation.
