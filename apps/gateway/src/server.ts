import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { AlpacaClient, UpstreamError } from './alpaca-client';
import { AlpacaStreamHub } from './stream';
import { readConfig, type GatewayConfig } from './config';

const symbolSchema = z.string().regex(/^[A-Z0-9][A-Z0-9.\-/]{0,19}$/);
const timeframeSchema = z.enum(['1m', '5m', '15m', '1h', '1D', '1W']);
const sessionSchema = z.enum(['regular', 'extended']);
const timestamp = z.coerce
  .number()
  .finite()
  .min(Date.UTC(1970, 0, 1))
  .max(Date.UTC(2100, 0, 1));
export function tokenMatches(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected) return true;
  if (!actual) return false;
  const a = Buffer.from(expected),
    b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function originAllowed(config: GatewayConfig, origin: string | undefined): boolean {
  return !origin || config.allowedOrigins.includes(origin);
}

/** Tokenless loopback access must not trust a hostname that can be rebound to localhost. */
export function hostAllowed(
  config: GatewayConfig,
  host: string | undefined,
  boundPort: number,
): boolean {
  if (config.token || !['127.0.0.1', 'localhost', '::1'].includes(config.host)) return true;
  if (!host) return false;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]+))?$/i.exec(host);
  return !!match && Number(match[2] ?? 80) === boundPort;
}

export function createGateway(
  config: GatewayConfig = readConfig(),
  dependencies: { fetch?: typeof fetch } = {},
) {
  const client = new AlpacaClient(config, dependencies.fetch);
  const hub = new AlpacaStreamHub(config);
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: false,
  });
  const rates = new Map<string, { count: number; until: number }>();
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = request.headers.origin;
    if (!requestAllowed(request)) {
      response.writeHead(403).end();
      return;
    }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    if (request.method !== 'GET') {
      send(405, { error: 'This gateway is read-only.' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://gateway.local');
    if (url.pathname === '/health') {
      send(200, {
        ok: true,
        provider: 'alpaca',
        configured: client.configured,
        feed: 'iex',
        readOnly: true,
      });
      return;
    }
    if (!tokenMatches(config.token, request.headers.authorization?.replace(/^Bearer /, ''))) {
      send(401, { error: 'Gateway authorization required.' });
      return;
    }
    const address = request.socket.remoteAddress ?? 'unknown',
      rate = rates.get(address);
    if (!rate || rate.until < Date.now())
      rates.set(address, { count: 1, until: Date.now() + 60_000 });
    else if (++rate.count > 120) {
      response.setHeader('Retry-After', '60');
      send(429, { error: 'Too many requests.' });
      return;
    }
    if (rates.size > 1000)
      for (const [key, value] of rates) if (value.until < Date.now()) rates.delete(key);
    try {
      const params = Object.fromEntries(url.searchParams);
      if (url.pathname === '/api/symbols') {
        const q = z
          .string()
          .max(80)
          .parse(params.q ?? '');
        send(200, await client.symbols(q));
      } else if (url.pathname === '/api/calendar') {
        const from = timestamp.parse(params.from),
          to = timestamp.parse(params.to);
        if (to < from || to - from > 370 * 86400_000)
          throw new UpstreamError(400, 'Calendar range must be at most one year.');
        send(200, await client.calendar(from, to));
      } else if (url.pathname === '/api/bars') {
        const symbol = symbolSchema.parse(params.symbol),
          timeframe = timeframeSchema.parse(params.timeframe),
          session = sessionSchema.parse(params.session ?? 'regular');
        const before = params.before === undefined ? undefined : timestamp.parse(params.before),
          limit = z.coerce
            .number()
            .int()
            .min(1)
            .max(2000)
            .parse(params.limit ?? 300);
        send(200, await client.history(symbol, timeframe, session, before, limit));
      } else if (url.pathname === '/api/minutes') {
        const symbol = symbolSchema.parse(params.symbol),
          from = timestamp.parse(params.from),
          to = timestamp.parse(params.to),
          session = sessionSchema.parse(params.session ?? 'regular');
        if (to < from || to - from > 8 * 86400_000)
          throw new UpstreamError(400, 'Minute recovery range must be at most eight days.');
        send(200, await client.minutes(symbol, from, to, session));
      } else send(404, { error: 'Unknown read-only endpoint.' });
    } catch (error) {
      if (error instanceof z.ZodError) send(400, { error: 'Invalid request parameters.' });
      else if (error instanceof UpstreamError) send(error.status, { error: error.message });
      else send(502, { error: 'Market-data service unavailable. Retry shortly.' });
    }
  });
  function requestAllowed(request: IncomingMessage): boolean {
    const address = server.address();
    const boundPort = address && typeof address !== 'string' ? address.port : config.port;
    return (
      originAllowed(config, request.headers.origin) &&
      hostAllowed(config, request.headers.host, boundPort)
    );
  }
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/stream' || !requestAllowed(request) || wsServer.clients.size >= 8) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (ws) => wsServer.emit('connection', ws, request));
  });
  wsServer.on('connection', (ws: WebSocket, _request: IncomingMessage) => {
    let authenticated = false;
    let remove: (() => void) | undefined;
    const deadline = setTimeout(() => ws.close(1008, 'Authenticate within five seconds'), 5000);
    ws.on('message', (raw) => {
      if (authenticated) {
        ws.close(1008, 'One subscription per connection');
        return;
      }
      try {
        const message = z
          .object({
            type: z.literal('subscribe'),
            symbol: symbolSchema,
            token: z.string().optional(),
          })
          .strict()
          .parse(JSON.parse(String(raw)));
        if (!tokenMatches(config.token, message.token)) {
          ws.close(1008, 'Invalid gateway token');
          return;
        }
        authenticated = true;
        clearTimeout(deadline);
        remove = hub.add(ws, message.symbol);
      } catch {
        ws.close(1008, 'Invalid subscription');
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(deadline);
      remove?.();
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wsServer.clients)
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat' }));
  }, 15_000);
  const close = async () => {
    clearInterval(heartbeat);
    hub.dispose();
    for (const ws of wsServer.clients) ws.terminate();
    wsServer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { server, close, config };
}
