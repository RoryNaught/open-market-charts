# Advanced trend indicators

These indicators use original OHLCV, including when the displayed chart is Heikin-Ashi. They measure price patterns and volatility; they do not infer actual buyer/seller volume or order-book liquidity. Values can change on the unfinished candle. Reversal and release annotations appear only after confirmation. An annotation's `confirmedAt` is the confirming candle's **open timestamp**, matching the chart's time coordinate; the event becomes available when that candle closes. Historical corrections can change past results.

## Supertrend

Defaults: ATR period **10**, multiplier **3**. True range is `max(high-low, abs(high-previousClose), abs(low-previousClose))`; the first candle uses `high-low`. Seed ATR with the arithmetic mean of the first `period` true ranges, then use Wilder smoothing: `ATR += (TR-ATR)/period`. No line is defined before that seed completes.

For each subsequent candle, let `middle=(high+low)/2`, `basicUpper=middle+multiplier*ATR`, and `basicLower=middle-multiplier*ATR`. Initialize the final bands with those basic bands. Thereafter:

- Replace the final upper band with the basic upper band if it is lower than the previous final upper band, or the previous close exceeded the previous final upper band. Otherwise carry the previous band forward.
- Replace the final lower band with the basic lower band if it is higher than the previous final lower band, or the previous close fell below the previous final lower band. Otherwise carry the previous band forward.

Initialize direction **down** when ATR first becomes available. A downtrend changes up only when the current close strictly exceeds the current final upper band. An uptrend changes down only when the current close strictly falls below the current final lower band. Equality preserves direction. The active value is the lower band in an uptrend and the upper band in a downtrend. `up` and `down` are separate line outputs; explicit whitespace on the inactive side prevents lines connecting across trend changes. Only confirmed reversals create markers; initialization does not.

This follows the [publicly documented Supertrend calculation](https://www.tradingview.com/support/solutions/43000634738-supertrend/), implemented locally without proprietary charting code.

## Squeeze momentum

Defaults: period **20**, Bollinger multiplier **2**, Keltner multiplier **1.5**. Both envelopes use `SMA(close, period)` as their center. Bollinger width is the multiplier times the **population** standard deviation of closes. Keltner width is the multiplier times `SMA(trueRange, period)`—not EMA or Wilder ATR. True range includes price gaps and uses high minus low on the first candle.

A squeeze means Bollinger Bands are **strictly inside** the Keltner Channel. Since both centers are identical, this is equivalent to `BollingerWidth < KeltnerWidth`. Equal widths count as outside. A release is a transition from inside to outside; a confirmed release produces one annotation even if subsequent bars remain outside. The `squeeze` output is a zero baseline colored amber during compression and muted gray otherwise. It first appears after `period` candles.

For each candle with a complete period window, calculate:

```text
detrended = close - (((highestHigh + lowestLow)/2 + SMA(close))/2)
```

Fit ordinary least squares to the most recent `period` detrended values at x coordinates `0..period-1`. The `momentum` histogram is the fitted value at `x=period-1`, not the slope. Its first value requires **2\*period-1 candles**, so the default period 20 needs 39 candles. Rolling regression sums periodically rebase to limit rounding drift during long streams.

Histogram colors distinguish nonnegative momentum increasing (bright teal) or not increasing (dark teal), and negative momentum decreasing (bright red) or not decreasing (dark red). Compare the first defined momentum with zero. A release before momentum warm-up finishes is marked at zero. This is a documented Bollinger/Keltner and linear-regression variant, not a promise of matching any proprietary indicator's implementation or signals.

## Streaming and verification

Both kernels support independent snapshots and restoration. The engine restores the checkpoint before applying a correction to the unfinished candle, so repeated revisions cannot accumulate duplicate state or markers. When the next candle arrives, the engine first confirms its predecessor. Each instance retains at most the latest **200** annotations. Obtaining or restoring annotations does not share mutable annotation objects with saved state.

Run `npx vitest run --root . packages/indicator-engine/src/advanced-trend.test.ts`. Tests compare separate full-window reference calculations, check strict crossing and containment equality, verify warm-up and zero-volume/flat-market behavior, cover all four momentum colors, and exercise repeated provisional revision and checkpoint restoration. Supertrend uses constant work per step. Squeeze uses rolling moments, monotonic extrema queues, and rolling regression rather than scanning the whole price window on every tick; rollback snapshots copy the bounded window state.
