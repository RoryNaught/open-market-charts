# Contributing

Open Market Charts is an early source release. Start with the [README](README.md), [architecture](docs/architecture.md) and [roadmap](docs/roadmap.md). For a substantial feature or contract change, open an issue describing the user workflow and proposed scope before building it. Small fixes can go straight to a pull request.

## Set up

Use Node.js 24, the reference runtime, and npm from the repository root:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173/?dev=1` for the explicitly labeled simulator. Tests and offline development do not require provider credentials. The URL without `?dev=1` uses real data.

## Keep the boundaries clear

- React belongs in `apps/web`; Lightweight Charts belongs in `packages/chart-renderer`. Use public chart APIs and keep calculation and drawing models independent of the renderer.
- Provider transports belong in `packages/data-engine` and the optional gateway. Use provider-qualified instrument IDs and UTC milliseconds at engine boundaries.
- Aggregate every trade before batching rendered candle snapshots. Preserve revisions, duplicate handling, confirmation flags and cancellation when changing ingestion.
- Indicators calculate from original OHLCV, including when Heikin-Ashi is displayed. Document seeds, warm-up, missing values, confirmation timing and correction behavior.
- Persist drawing anchors as time/value coordinates. Keep serialization, pane ownership, coordinate conversion and undo/redo consistent.
- Keep keys, access tokens and local environment files out of frontend bundles, browser persistence, exports, fixtures and logs. A failed live connection must stay visible rather than selecting simulated data.

The [provider guide](docs/providers.md), [indicator guide](docs/indicators.md) and [drawing guide](docs/drawings.md) describe the extension contracts. Indicator plugins are trusted, compiled application code; a Web Worker is not a security sandbox for untrusted modules.

## Test the behavior you change

Run the shared checks before opening a pull request:

```sh
npm run format:check
npm run typecheck
npm test
npm run build
```

For rendering or interaction changes, install browsers once and run the relevant cases:

```sh
npx playwright install chromium firefox webkit
npx playwright test tests/e2e/advanced-regressions.spec.ts
# Run the full suite for changes spanning chart, worker or workspace behavior:
npm run test:e2e
```

CI runs the shared checks and complete browser suite on Node 24. Use an isolated `--output` directory if running Playwright concurrently with another session. Format only files you changed with `npx prettier --write <paths>`.

Use known-answer fixtures for numerical changes and lifecycle regressions for asynchronous changes. Check batch/stream equivalence, repeated forming-bar revisions, historical corrections and stale responses when relevant. For drawings, test coordinate round trips and actual pointer interactions. Avoid tests that only restate an implementation.

Performance changes need a named workload and before/after measurements. Follow [the performance guide](docs/performance.md), use a separate report filename, and record browser/runtime versions, hardware, history size, active studies, memory and correctness checks. Pause other tests and source edits while measuring. A fast calculation benchmark does not establish smooth browser interaction.

## Submit a useful report or pull request

For bugs, include reproduction steps, expected and actual behavior, browser/runtime, provider, symbol, timeframe and session mode. A small synthetic fixture or sanitized workspace export is useful. Remove private drawings or symbols you do not intend to share; never include credentials, access tokens or authenticated network captures.

A pull request should explain the concrete behavior changed, why it helps, and how it was verified. Note known limits and link the relevant issue. Keep unrelated cleanup separate, update affected documentation, and preserve third-party attribution and license notices.

Use original implementations or compatible open-source dependencies. Do not contribute proprietary chart components, copied private indicator scripts or provider data that cannot be redistributed. Review dependency license and browser-bundle impact when adding a package.
