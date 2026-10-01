# Roadmap

This is a proposed order of work after the v0.1 foundation. Everything below is future work unless explicitly identified as an existing capability. Priorities are not delivery dates; completed work should link to its implementation and verification.

The current release already connects real Coinbase data, supports an optional Alpaca gateway, calculates thirteen studies, edits nine drawing tools, and persists one browser workspace. See the [README](../README.md) for shipped features and [verification](verification.md) for current evidence.

## P0 — make the existing workspace dependable for longer use

### 1. Establish repeatable release and performance gates

Extend the existing correctness suite before expanding the rendering workload. The [CI workflow](../.github/workflows/ci.yml) runs clean installation, correctness checks, production build and browser tests on Node 24. The [current measurements](performance.md) cover 100,000 bars with all thirteen studies and 500,000 bars with candles/volume in the browser; dense zoom and long-running sessions remain unmeasured.

Acceptance:

- Keep the existing Node 24 CI checks passing. Verify the container build and perform an opt-in live Alpaca smoke check with credentials kept outside the repository.
- Measure 500,000 bars with all thirteen studies, including both a narrow viewport and dense full-history zoom. Record readiness, pan/zoom and streaming frame intervals, input latency, worker queue depth, long tasks and main-thread/worker memory where measurable.
- Use the existing targets as gates on named reference hardware: readiness within 2 seconds for 100,000 bars and 5 seconds for 500,000; p95 frame interval at most 33 ms; p95 interaction-to-paint at most 100 ms. Report misses explicitly and address their measured cause before claiming support for the workload.
- Run at least a two-hour paced soak with reconnects, duplicate/out-of-order events, pagination, study edits and symbol switches. Assert exact fixture OHLCV/volume, bounded queues, no obsolete updates, and memory returning to a documented stable range after repeated cycles.
- Keep short deterministic checks in pull-request CI; schedule expensive performance and soak runs separately with retained reports.

### 2. Finish everyday workspace workflows

The existing workspace saves automatically and supports JSON export/import. Add deliberate organization and clearer editing rather than more study types.

Acceptance:

- Create, rename, duplicate, load and delete named local workspace presets. Confirm deletion of a saved preset, preserve the current workspace on failed writes, and migrate existing single-workspace storage without data loss.
- Save reusable study settings and drawing styles with explicit scope. Loading a preset must not move fixed UTC anchors, apply drawings to a different provider's instrument, or retain stale panes and annotations.
- Make symbol search, indicator settings, drawing selection and dialogs usable from the keyboard with visible focus and predictable Escape behavior. Add browser tests for focus restoration, narrow layouts and essential touch interactions.
- Explain incomplete anchors, calendar requirements, provider coverage and current-candle previews where users encounter them. Keep advanced rule details linked from the relevant study.

### 3. Bound market-history storage and memory

Workspace persistence already exists; a durable candle cache and explicit data-residency budget do not. Avoid turning every pagination session into an ever-growing tab.

Acceptance:

- Define cache keys using provider, instrument, timeframe, session policy, adjustment policy and schema version. Store only data the provider permits retaining; tokens and credentials stay outside the cache.
- Add configurable disk and memory budgets, eviction, explicit cache clearing, quota-error handling and validation of partially written or corrupt records. Show when cached data is stale and reconcile it with authoritative revisions after reconnect.
- Preserve recursive indicator state and drawing time anchors when pages leave memory. Eviction must not silently reseed EMA/VWAP or change confirmed historical results. Use proven checkpoints or reload the required prefix; expose incomplete calculations when neither is available.
- Test loading, eviction, reload, historical corrections and schema migration against uncached reference calculations. Record memory behavior and offline availability limits.

## P1 — add capabilities on top of those guarantees

### 4. Local alerts with explicit timing rules

Start with price crossings and confirmed study events in an open browser tab. Reliable background delivery is a separate service decision.

Acceptance:

- Define equality/crossing rules, candle-close versus intrabar evaluation, duplicate suppression, and behavior after a corrected candle or reconnect replay.
- Persist local alert definitions and an inspectable event history. Make browser permission state, paused feeds and suspended-tab limitations visible.
- Replaying the same fixture must produce the same alert IDs without duplicate notifications. Closing the tab must not imply that alerts continue running.

### 5. Add a read-only IBKR adapter

Use the provider boundary already in place. The planned integration needs a local TWS/IB Gateway bridge, an authenticated user session and the user's market-data entitlements; it cannot be a credential-free static-browser connector.

Acceptance:

- Choose and document the supported API/bridge and version. Keep authentication in the local process; expose market-data routes only, with origin restrictions and authentication appropriate to the deployment.
- Resolve instruments unambiguously and report delayed, frozen, unavailable or unentitled data explicitly. Do not assume an account balance establishes every exchange entitlement.
- Implement history cursors, calendars, live bars/trades/quotes, pacing/backoff, reconnect reconciliation and teardown through `MarketDataProvider` without changing chart or drawing engines.
- Pass recorded/synthetic contract fixtures for DST, sessions, corrections and cancellation; complete a separate opt-in live smoke check before calling the adapter verified. Document supported instruments and remaining gaps.

### 6. Establish real order-flow data before adding order-flow charts

Begin with the Coinbase adapter and provider SDK. The current normalized `Trade` lacks aggressor-side metadata, and the SDK has no order-book snapshot/update contract. Current OHLCV studies cannot supply that missing information.

Acceptance:

- Specify source sequence IDs, exchange timestamps, trade-side semantics, book snapshots/deltas, gap events and supported capabilities. Preserve unknown side explicitly; document any mapping from a provider's maker-side field to aggressor side.
- Build replayable adapter fixtures for snapshot/delta ordering, duplicate trades, dropped messages, resynchronization and reconnects. After recovery, the book must match an independent reference reconstruction.
- Enforce bounded depth, retention and queues. Display stale or incomplete book state instead of treating it as current. Do not imply historical depth is available unless an actual retained source supplies it.
- Only then add trade-based delta or depth visualizations with declared exchange coverage and data requirements. Verify signed volume conservation against classified executions; keep unclassified volume visible. Continue labeling OHLCV Volume Profile as an estimate.

### 7. Stabilize extension contracts

The current plugin path imports reviewed TypeScript modules into both the app and worker. Package publication and untrusted runtime installation need additional work.

Acceptance:

- Version provider, indicator, annotation and workspace contracts; document compatibility rules and migrations before publishing separate npm packages.
- Add reusable contract fixtures for plugin warm-up, confirmation, independent snapshots, corrections, removal and deterministic batch/stream equivalence.
- Keep the initial stable plugin path build-time and trusted. Define resource limits, error isolation and dependency/license review for integrations.
- Treat arbitrary downloaded plugins as a separate design requiring a concrete trust/permission model. A Web Worker alone does not prevent network or storage access or make third-party code safe.

## How to pick up work

Open an issue with the user outcome, a bounded vertical slice, acceptance checks and dependencies on earlier items. Prefer one complete workflow over empty interfaces for a future system. Feature proposals outside this order are welcome when they identify a concrete user need.

Cloud accounts, shared workspaces, automated trading, broker order entry and a plugin marketplace are outside the current roadmap. Revisit them only with a separate scope and operating model.
