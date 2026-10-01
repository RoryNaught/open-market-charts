# Architecture and correctness decisions

## A complete vertical slice

The app starts a provider stream before historical loading. `MarketSession` buffers complete candle replacements while REST runs, reconciles revisions, and publishes a coherent reset. Symbol/timeframe/session changes advance a generation, abort requests, unsubscribe old sockets and ignore late callbacks. Only one history request runs at a time. History pages prepend without shifting the user's visible candles.

Every trade is aggregated before frame batching. A pending map coalesces complete bars, never raw trades. An older-bar correction triggers a reset so dependent recursive indicators are rebuilt. Provider gaps trigger authoritative backfill and explicit connection status. Bounded recovery failure is visible rather than silently pretending a complete market stream.

Normalized instrument IDs are provider-qualified. OHLCV uses UTC milliseconds; the renderer alone converts to seconds for Lightweight Charts. A session is an actual provider calendar interval. Filtering and aggregation account for holidays, early closes and DST without inventing no-trade candles.

## Rendering and interaction

React owns controls and configuration. Lightweight Charts owns chart canvases, gestures, price scales, axes and pane crosshairs. A public series primitive paints independent drawing geometry, session decoration and Volume Profile. Its lifecycle requests redraws and releases its callback on detachment. There is no dependency on chart internals, screenshots or embedded widgets.

Drawings store canonical time/value anchors. Binary-search interpolation maps timestamps to loaded logical positions; provider calendars extend stock anchors into future sessions. Without calendar coverage, extrapolation is uniform and should not be interpreted as an authoritative future exchange schedule. Logarithmic/percentage transforms come from the actual series coordinate adapter. Panes and series are recreated only when configuration changes; ticks use `update`.

The data store preserves sorted unique timestamps and handles common tail appends/replacements without scanning history. Indicator kernels live in a worker, snapshot the state preceding the forming bar, and emit compact incremental deltas. Full history and recursive corrections require a rebuild. The renderer keeps a full time axis and canonical results, but gives priced series the viewport plus an overscan window. This avoids rebuilding off-screen points on every tick. The latest price stays attached even while viewing earlier history. Rendering also enables Lightweight Charts' public conflation option when bars become narrower than visible pixels. Neither optimization alters the input to calculations.

## Persistence boundary

`WorkspaceRepository` is the storage boundary: `load`, `save` and `close`. A versioned schema validates instrument, chart, indicator and drawing state before replacing anything. IndexedDB commits a previous valid snapshot and the current snapshot in one transaction. A failed browser write leaves JSON export available. Import strips unknown fields such as credentials.

Persisted data includes watchlist, selection, timeframe, session, chart/scales, indicators, drawings and pane dimensions. It excludes provider credentials, gateway access tokens, tick buffers and market-data caches. Undo history belongs to the current editing session; restored drawings start a fresh history.

A future server repository can implement the same storage boundary. Cloud identity, sharing, synchronization/conflict resolution, durable market-history storage, arbitrary downloaded plugins and order execution are deliberate follow-up features, with no empty services standing in for them today.

## Provider choice

Coinbase offers a working no-key public path. Alpaca is optional and keeps brokerage credentials in a local/server process. Both enter through `MarketDataProvider`; the chart and indicators never call broker SDKs. An IBKR adapter would use the same boundary with a TWS/IB Gateway bridge and the user's own data entitlements. No assumption that a funded broker account includes every real-time exchange entitlement is encoded in the app.

## Extension policy

Keep core packages independent of React and chart libraries. Community indicator code is trusted build-time TypeScript/ES modules; registering a plugin in the worker is explicit. Do not evaluate arbitrary URLs or user-entered source. New renderers should implement coordinate mapping and paint adapters around the existing drawing model, rather than moving the model into a chart primitive.
