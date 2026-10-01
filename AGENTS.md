# Project instructions

Use npm from the repository root. Node 24 is the reference environment.

Core engines are framework independent. Only chart-renderer imports lightweight-charts; only the web app imports React. Canonical timestamps are UTC milliseconds. No provider credentials in frontend code, browser persistence, logs, or exported workspaces. Real-data failures must never silently fall back to the simulator.

Read installed lightweight-charts typings before implementing renderer APIs. Use public APIs only. Process trades before coalescing render updates. Drawing anchors are time/value coordinates, never persisted pixels. Indicators use original OHLCV, not Heikin-Ashi display values.

Run npm run typecheck, npm test, npm run build, and relevant Playwright tests. Record benchmark measurements with environment details; do not claim unmet performance targets passed.

Ownership during parallel implementation: coordinator owns manifests, chart-core, chart-renderer, UI, integration; data agent owns data-engine and gateway; indicator agent owns indicator-engine; drawing agent owns drawing-engine. Coordinate contract changes with the coordinator.
