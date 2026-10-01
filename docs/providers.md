# Market-data providers

The application opens with real Coinbase Exchange data. Alpaca IEX stocks are available through the optional local gateway. The simulator is an explicit developer/test provider; connection failures never select it automatically.

## Provider contract

`packages/provider-sdk` contains framework-independent TypeScript interfaces. Implement `MarketDataProvider`, then register the instance with the chart application's provider map. Core chart, indicator, and drawing packages do not depend on any provider's transport.

```ts
interface MarketDataProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  searchSymbols(query: string, signal?: AbortSignal): Promise<Instrument[]>;
  getHistory(request: HistoryRequest): Promise<HistoryPage>;
  subscribe(request: SubscriptionRequest, callbacks: StreamCallbacks): () => void;
  getSessions?(from: number, to: number, signal?: AbortSignal): Promise<SessionInterval[]>;
  dispose(): void;
}
```

Instrument IDs include the provider, such as `coinbase:BTC-USD` and `alpaca:SPY`. The instrument's separate `symbol` field is the exchange/API symbol. This keeps drawings and saved workspaces for different feeds distinct.

All canonical timestamps are UTC **milliseconds**. Candle time is its opening boundary. OHLCV values must be finite; volume is nonnegative. Instrument metadata supplies price precision, volume unit, currency, exchange timezone, and session type. Do not substitute quote volume for base-asset volume.

History pages are ascending and unique by opening timestamp. `before` is exclusive. `nextBefore` is the next request's time cursor, and must advance even across intervals with no trades. `hasMore` indicates whether further pages may exist, not that every requested interval contains candles. Page sizes are an upper bound: providers can return fewer bars because of upstream limits or sparse trading.

`subscribe()` returns an idempotent teardown function. Use `onBar` for full candle replacements, `onTrade` for normalized individual executions, `onQuote` for bid/ask updates, `onStatus` for connection state, and `onGap` when authoritative history should be reloaded. Abort pending work and tear down transport in `dispose()`. Stale results from prior symbol/timeframe selections are rejected by the chart controller's generation guard.

Optional candle `revision` values must be comparable within an adapter. These adapters use local request-start/processing timestamps because the external historical APIs do not provide a shared candle revision sequence. They are reconciliation hints, not exchange transaction IDs. Reconnect recovery fetches fresh authoritative history, while events newer than the snapshot request retain precedence.

## Coinbase Exchange

- `new CoinbaseProvider()` requires no account, API key, or gateway. Symbol search uses the live product catalog.
- REST candles supply historical OHLCV. Requests are split into ranges smaller than the 300-candle upstream limit, normalized, deduplicated, and sorted. Weekly candles are aggregated from daily candles with Monday UTC boundaries.
- Streaming uses `matches`, `heartbeat`, and `ticker`. Every match is aggregated before the controller batches rendering. Ticker messages provide quotes; their batched trade sizes are never summed into candle volume.
- On connection, the current target candle is reconstructed from disjoint, completed lower-timeframe candles plus all recovered trades from the current minute. Buffered WebSocket trades are deduplicated against REST by trade ID. This avoids adding live volume onto a snapshot that already contains the same trades.
- Heartbeat/trade-ID gaps trigger a rebuild. A disconnected connection reconnects with bounded exponential backoff. Recovery queues and REST trade-page counts are bounded; exceeding a bound surfaces an error and retries the connection.
- Historical data can omit intervals with no trades. Missing periods remain gaps rather than invented flat candles. The adapter stops requesting before January 2015; individual product listings can begin later. Large history is loaded on demand.

The feed represents Coinbase's market, not a consolidated cryptocurrency price. Public API access can be subject to provider availability and rate limits. HTTP errors remain visible in the chart.

## Alpaca IEX stocks

```ts
const provider = new AlpacaProvider({
  baseUrl: 'http://127.0.0.1:8787',
  // Optional gateway access token. This is NOT an Alpaca API secret.
  token: gatewayAccessToken,
});
```

Alpaca's free Basic stock feed is IEX, a single exchange. It does not represent consolidated US volume or the national best bid/offer. The adapter explicitly requests `feed=iex` and uses the IEX WebSocket stream. It never silently upgrades to a paid feed.

Alpaca credentials exist only in the gateway process environment. The browser receives normalized public market data. No account, order, position, or trading endpoints are exposed.

Stocks use authoritative minute bars and `updatedBars` messages. Candle updates therefore arrive at minute cadence; trade and quote events stream between those updates. This is deliberate: stock trade conditions apply different rules to OHLC and volume. The adapter does not claim that naïvely summing all trades reproduces exchange candles. Higher-timeframe candles are derived from the same minute bars, preserving consistent session filtering. Late corrected minute bars replace earlier minutes and update their containing candle.

Completed minute bars retain their `closed` flag. An aggregate is closed only after all included minutes are complete and its actual calendar boundary has passed; a completed minute alone cannot close a daily or weekly candle. Intraday endings are clipped to the session close, including shortened final hourly buckets. Weekly completion requires calendar coverage through the entire week and uses its last trading session's close. History requests fetch sufficient future calendar dates to establish that boundary. A closed candle can still receive an authoritative late correction.

History uses raw, unadjusted minute bars. Daily and weekly bars are **session-filtered aggregations of minute bars**, so their rules can differ from Alpaca's native daily aggregates. Split adjustments are not currently applied. The gateway bounds each request to a useful date window, follows upstream page tokens, and returns a cursor for earlier history.

The provider's actual calendar supplies regular opens, closes, holidays, and shortened days. New York offsets are resolved per date through `Intl`, including daylight-saving transitions. Extended mode includes available IEX data from 04:00 to 20:00 New York time on calendar trading dates; this is a display/filter window, not a promise that IEX supplies trades throughout that window. No overnight data is synthesized. Intraday buckets begin at the selected session opening. Day/week labels use the first regular opening in that day/week.

`getCachedSessions()` exposes previously fetched calendar intervals for shading and projection. `getSessions()` also populates this cache and chunks requests exceeding one year.

## Simulator and testing

`new SimulatedProvider({ seed: 42 })` is explicit opt-in. `generateBars(count, {seed, start, timeframe, basePrice})` creates reproducible fixtures: the same interval produces identical bars regardless of pagination. The UI labels this feed as synthetic. Use it for deterministic browser tests and benchmarks, not as evidence of live-provider performance.

Tests cover event ordering, duplicate trades, snapshot/live overlap, gaps, history boundaries, DST, holidays, early closes, and gateway authorization. Production credentials are not required for these tests.

## Sources

- [Coinbase historical candle limits](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles)
- [Coinbase stream channels and gap recovery](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels)
- [Alpaca data plans and authentication](https://docs.alpaca.markets/us/docs/about-market-data-api)
- [Alpaca historical bars](https://docs.alpaca.markets/us/reference/stockbars)
- [Alpaca real-time bars and corrections](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data)
- [Alpaca aggregation rules](https://docs.alpaca.markets/us/docs/market-data-faq)
