# Running and deploying

Use Node 24 and npm from the repository root.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. The default Coinbase feed connects directly to public REST/WebSocket endpoints without credentials. For a production static build, use `npm run build`; publish the `dist` directory to an HTTPS static host. `npm run preview` serves that build locally on port 4173.

## Optional local stock gateway

An Alpaca account with API credentials is needed for the IEX stock feed. A paper-account key works for the data connection. Keep both Alpaca values out of frontend environment variables and source control.

```sh
export ALPACA_API_KEY='your-key'
export ALPACA_API_SECRET='your-secret'
npm run gateway
```

The gateway binds to `127.0.0.1:8787`. In the application's data connection settings, enter `http://127.0.0.1:8787`. The application does not purchase or modify subscriptions.

Supported environment variables are documented in `apps/gateway/.env.example`. `npm run gateway` reads an optional `.env` file in the repository root; already exported process variables take precedence. You can also supply an environment file through the container/runtime. Use paper credentials by default; set `ALPACA_PAPER=false` only when the supplied credentials belong to a live Alpaca account. This selects the assets/calendar service; the gateway remains read-only.

The `/health` endpoint returns availability and configuration status without credentials. Missing credentials, invalid authorization, rate limits, and upstream interruptions become visible connection errors. Coinbase remains a separately selectable real provider; errors do not select fake data.

## Remote gateway

For nginx on the same host, keep the gateway bound to loopback and configure a token and the exact public frontend origin:

```sh
export OMC_GATEWAY_HOST=127.0.0.1
export OMC_GATEWAY_TOKEN='a-random-token-at-least-32-characters-long'
export OMC_ALLOWED_ORIGINS='https://charts.example.com'
npm run gateway
```

Place it behind an HTTPS/WSS reverse proxy. Prefer serving `/market-data` from the same public origin as the static app and stripping that prefix before forwarding. Set the application's gateway URL to that HTTPS prefix. If hosting the gateway on a separate origin, enter its exact HTTPS origin in the app and allow the frontend origin with `OMC_ALLOWED_ORIGINS`. Do not expose the unencrypted backend port directly to the Internet. Binding to `0.0.0.0` for a container or a separate private proxy network requires the same token (at least 32 characters) and explicit origin settings; restrict backend access to the proxy.

For nginx, add the `map` inside the `http` context and the locations inside your existing HTTPS `server` block. Configure the server's TLS certificate normally. This example serves the app build and forwards the gateway without exposing its upstream credentials:

```nginx
# http context
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

# inside the existing HTTPS server block for charts.example.com
root /srv/open-market-charts/dist;

location / {
    try_files $uri $uri/ /index.html;
}

location = /market-data {
    return 308 /market-data/;
}

location /market-data/ {
    # Trailing slash strips /market-data/ before forwarding.
    proxy_pass http://127.0.0.1:8787/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Origin $http_origin;
    proxy_read_timeout 90s;
    proxy_buffering off;
}
```

Set the app's gateway URL to `https://charts.example.com/market-data`. HTTP routes become `/market-data/api/...` and WebSockets use `/market-data/stream`. The browser supplies the gateway token; nginx does not inject or publish a shared secret.

The access token authenticates this private gateway. Keep it in runtime browser memory; do not put it in a URL, public frontend build, exported workspace, or logs. The browser sends it as a bearer header for HTTP and in the first WebSocket subscription message. Exact origin allowlists also protect the default local service from cross-origin browser access. Tokenless loopback access additionally requires a `localhost`, `127.0.0.1`, or `[::1]` Host header with the actual listening port, including for WebSocket upgrades; arbitrary DNS hostnames are rejected even when Origin is absent. A private gateway is intended for its account owner, not redistribution of one account's licensed market feed to the public.

The service exposes only these allowlisted routes:

| Route                    | Purpose                                        |
| ------------------------ | ---------------------------------------------- |
| `GET /health`            | Liveness/configuration status                  |
| `GET /api/symbols?q=SPY` | Search available equities                      |
| `GET /api/bars`          | Normalized, session-filtered history           |
| `GET /api/calendar`      | Actual regular exchange sessions               |
| `GET /api/minutes`       | Bounded candle reconciliation                  |
| `WS /stream`             | One symbol subscription per browser connection |

The server rejects mutation methods, unlisted routes, invalid parameters, unexpected browser origins, missing required tokens, oversized WebSocket messages, excess connections, and excessive requests. One upstream stock stream is shared by connected clients. Slow clients are disconnected and reconcile history when they reconnect.

## Container

From the repository root:

```sh
docker build -f apps/gateway/Dockerfile -t open-market-charts-gateway .
docker run --rm --env-file /path/to/private-gateway.env -p 127.0.0.1:8787:8787 open-market-charts-gateway
```

The image uses a non-root user. Its internal bind address is `0.0.0.0`, so the token and explicit origin settings are required even when Docker publishes the port only on loopback. Credentials are supplied at runtime; the Dockerfile copies specific source/manifests and does not copy local environment files.

## Verification and operations

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e`. Run `npm run benchmark` to record the current machine's engine measurements; network latency is a separate factor. Tests use fixtures and can run without account credentials. Live Alpaca connectivity still requires valid user-supplied credentials.

The gateway intentionally has no database or user-account system. It keeps a bounded in-memory request cache, serializes upstream request starts below the Basic request rate, multiplexes WebSocket subscriptions, and reconnects after network interruptions. The browser persists workspaces; market-data subscriptions belong to the configured provider account. Logs contain startup addresses and feed names, not keys, tokens, or upstream payloads.

IBKR can be added through the same provider contract, but an IBKR adapter is not included in this release. It requires an authenticated local or authorized server connection and the user's market-data entitlements; a funded brokerage account alone is not a universal free-data entitlement.
