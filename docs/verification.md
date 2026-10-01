# Implementation verification

Recorded September 30, 2026, America/New_York.

Publication checks used Node 24.21.0: a clean `npm ci`, all 169 unit/integration tests, TypeScript checking and the production build passed. The dependency audit reported no known vulnerabilities. Earlier browser and benchmark results below retain their documented environments.

| Check                           | Result                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript and production build | Passed; separate React/chart bundles and indicator worker emitted                                                                                                                   |
| Unit/integration tests          | 169 passed across calculations, confirmation/rollback, buffering/recovery, session boundaries, drawing geometry/history, viewport caches, workspace validation and gateway behavior |
| Complete browser suite          | 67 passed across Chromium, Firefox, WebKit and a touch Chromium viewport                                                                                                            |
| Production-build browser smoke  | 7 Chromium cases passed for advanced-study controls/persistence/worker/colors, real adapter fixtures, feed errors, and stock sessions                                               |
| Source formatting               | Passed                                                                                                                                                                              |
| Public Coinbase live smoke      | 20 historical candles and 46 streaming updates observed in a 12-second provider check; two detected gaps recovered                                                                  |
| Live application visual check   | Real Coinbase data, 900 historical bars, streaming candles, volume, EMA and all five advanced studies displayed in Chrome; screenshots saved                                        |
| Performance                     | Measured results and workload boundaries in [performance.md](performance.md)                                                                                                        |

Browser coverage also checks that switching to an unavailable provider closes the old stream and removes both candle and indicator pixels. Indicator calculations, candle aggregation and drawing transformations have deterministic known-answer tests. Browser tests use fixture transports or the explicitly labeled simulator, independently of the separate public-network checks.

The advanced suite verifies fixed UTC anchor selection/editing/persistence under an America/New_York browser timezone, unique IDs after reload, forming-candle confirmation through the real worker, annotation removal, and momentum colors in the rendered canvas. Additional regressions cover drawing in a down-only Supertrend pane, moving both trend outputs to the left scale while preserving annotation coordinates, and recomputation when a late session calendar arrives. Native minute closure and aggregate closure at intraday, half-day, extended-session and weekly boundaries have independent provider fixtures. Live Alpaca verification remains outstanding.

Live screenshots: [advanced chart](screenshots/advanced-indicators.png), [study catalogue](screenshots/advanced-catalog.png). Reproduce with `node scripts/capture-advanced.mjs` against the local development server; this uses public Coinbase data in a fresh test context without changing a saved user workspace.

Live Alpaca account connectivity was not tested because no credentials were supplied. Its adapter and gateway were tested with fixtures, including real local HTTP serving. Gateway regressions verify tokenless loopback Host checks for HTTP and WebSocket requests, plus authenticated reverse-proxy access. The optional Docker image was not built because the local Docker daemon was stopped. No hosted deployment or account-specific market entitlement was validated.

The development server is a convenience for local use. Re-run the documented checks after changes; these results describe this implementation and test environment, not a certification of every browser, exchange condition or operating environment.
