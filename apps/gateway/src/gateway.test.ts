import { afterEach, describe, expect, it } from 'vitest';
import { readConfig } from './config';
import { createGateway, hostAllowed, originAllowed, tokenMatches } from './server';
import { AlpacaClient } from './alpaca-client';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { AlpacaStreamHub } from './stream';

const config = readConfig({ ALPACA_API_KEY: 'server-key', ALPACA_API_SECRET: 'server-secret' });
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});

async function listen(gateway: ReturnType<typeof createGateway>): Promise<number> {
  closes.push(gateway.close);
  await new Promise<void>((resolve, reject) => {
    gateway.server.once('error', reject);
    gateway.server.listen(0, '127.0.0.1', () => {
      gateway.server.off('error', reject);
      resolve();
    });
  });
  const address = gateway.server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  return address.port;
}

async function websocketUpgrade(port: number, host: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/stream`, {
      headers: { Host: host, ...(origin ? { Origin: origin } : {}) },
    });
    socket.on('error', reject);
    socket.once('open', () => {
      socket.close();
      resolve(101);
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
      // ws leaves rejected handshakes open when unexpected-response is handled.
      socket.terminate();
    });
  });
}

// Node fetch normalizes Host; raw HTTP is necessary to exercise the boundary as sent on the wire.
async function httpStatus(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, headers }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end();
  });
}

describe('read-only gateway boundary', () => {
  it('validates tokenless loopback Host names and the actual bound port', () => {
    for (const host of ['localhost:8787', 'LOCALHOST:8787', '127.0.0.1:8787', '[::1]:8787'])
      expect(hostAllowed(config, host, 8787)).toBe(true);
    for (const host of [
      undefined,
      'hostile.example:8787',
      'localhost.hostile.example:8787',
      'localhost:9999',
      'localhost',
      'user@localhost:8787',
      'localhost:8787/path',
      '[::1]:9999',
    ])
      expect(hostAllowed(config, host, 8787)).toBe(false);
    expect(hostAllowed(config, 'localhost', 80)).toBe(true);
  });
  it('rejects hostile HTTP and WebSocket Hosts without Origin while keeping local quickstart working', async () => {
    const gateway = createGateway({ ...config, port: 0 });
    const port = await listen(gateway);
    expect(await httpStatus(port, '/health', { Host: `hostile.example:${port}` })).toBe(403);
    expect(await httpStatus(port, '/health', { Host: 'localhost:1' })).toBe(403);
    expect(await httpStatus(port, '/health')).toBe(200);
    expect(await httpStatus(port, '/health', { Host: `localhost:${port}` })).toBe(200);
    expect(await websocketUpgrade(port, `hostile.example:${port}`)).toBe(403);
    expect(await websocketUpgrade(port, `localhost:${port}`)).toBe(101);
    expect(await websocketUpgrade(port, `localhost:${port}`, 'https://hostile.example')).toBe(403);
  });
  it('permits the configured authenticated reverse-proxy host without weakening token checks', async () => {
    const token = 'test-proxy-token-'.repeat(3);
    const remote = readConfig({
      ALPACA_API_KEY: 'server-key',
      ALPACA_API_SECRET: 'server-secret',
      OMC_GATEWAY_HOST: '0.0.0.0',
      OMC_GATEWAY_TOKEN: token,
      OMC_ALLOWED_ORIGINS: 'https://charts.example',
    });
    const gateway = createGateway(remote, { fetch: async () => new Response('[]') });
    const port = await listen(gateway);
    const headers = { Host: 'charts.example', Origin: 'https://charts.example' };
    expect(await httpStatus(port, '/api/symbols', headers)).toBe(401);
    expect(
      await httpStatus(port, '/api/symbols', { ...headers, Authorization: `Bearer ${token}` }),
    ).toBe(200);
    expect(await websocketUpgrade(port, 'charts.example', 'https://charts.example')).toBe(101);
    expect(await websocketUpgrade(port, 'charts.example', 'https://hostile.example')).toBe(403);
  });
  it('requires explicit authentication and origins before binding remotely', () => {
    expect(() => readConfig({ OMC_GATEWAY_HOST: '0.0.0.0' })).toThrow('Remote binding');
    expect(() =>
      readConfig({
        OMC_GATEWAY_HOST: '0.0.0.0',
        OMC_GATEWAY_TOKEN: 'x'.repeat(32),
        OMC_ALLOWED_ORIGINS: 'https://charts.example',
      }),
    ).not.toThrow();
    expect(originAllowed(config, 'https://malicious.example')).toBe(false);
    expect(originAllowed(config, 'http://localhost:5173')).toBe(true);
    expect(tokenMatches('secret', 'secret')).toBe(true);
    expect(tokenMatches('secret', 'bad')).toBe(false);
  });
  it('rejects order mutations, missing tokens, unexpected origins, and malformed queries', async () => {
    const gateway = createGateway({ ...config, token: 'test-token' });
    closes.push(gateway.close);
    await new Promise<void>((resolve, reject) => {
      gateway.server.once('error', reject);
      gateway.server.listen(0, '127.0.0.1', () => {
        gateway.server.off('error', reject);
        resolve();
      });
    });
    const address = gateway.server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/orders`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/api/bars`)).status).toBe(401);
    expect(
      (await fetch(`${base}/health`, { headers: { Origin: 'https://malicious.example' } })).status,
    ).toBe(403);
    const invalid = await fetch(`${base}/api/bars?symbol=SPY&timeframe=oops`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('server-secret');
    const health = await (await fetch(`${base}/health`)).json();
    expect(health.readOnly).toBe(true);
    expect(JSON.stringify(health)).not.toContain('server-key');
  });
  it('keeps keys only in upstream headers and uses calendar holidays/early closes', async () => {
    let received: RequestInit | undefined;
    const client = new AlpacaClient(config, async (_url, options) => {
      received = options;
      return new Response(JSON.stringify([{ date: '2024-11-29', open: '09:30', close: '13:00' }]));
    });
    const days = await client.calendar(Date.parse('2024-11-28'), Date.parse('2024-11-30'));
    expect(days).toHaveLength(1);
    expect(days[0].close).toBe(Date.parse('2024-11-29T18:00:00Z'));
    expect(received?.headers).toMatchObject({ 'APCA-API-SECRET-KEY': 'server-secret' });
    expect(JSON.stringify(days)).not.toContain('server-secret');
  });
  it('shares one upstream stream and only declares readiness after subscription acknowledgement', () => {
    class FakeSocket extends EventEmitter {
      readyState = 1;
      bufferedAmount = 0;
      messages: Record<string, unknown>[] = [];
      send(raw: string) {
        this.messages.push(JSON.parse(raw));
      }
      close() {
        this.readyState = 3;
        this.emit('close');
      }
    }
    const upstream = new FakeSocket(),
      first = new FakeSocket(),
      second = new FakeSocket();
    let connections = 0;
    const hub = new AlpacaStreamHub(config, () => {
      connections++;
      return upstream as unknown as WebSocket;
    });
    const removeFirst = hub.add(first as unknown as WebSocket, 'SPY');
    upstream.emit('open');
    expect(upstream.messages[0]).toMatchObject({ action: 'auth', key: 'server-key' });
    upstream.emit('message', JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
    expect(first.messages).toHaveLength(0);
    upstream.emit('message', JSON.stringify([{ T: 'subscription', bars: ['SPY'] }]));
    expect(first.messages).toEqual([{ type: 'ready' }]);
    const removeSecond = hub.add(second as unknown as WebSocket, 'SPY');
    expect(connections).toBe(1);
    expect(second.messages).toEqual([{ type: 'ready' }]);
    upstream.emit(
      'message',
      JSON.stringify([
        { T: 'b', S: 'SPY', t: '2024-01-03T15:00:00Z', o: 10, h: 12, l: 9, c: 11, v: 100 },
      ]),
    );
    expect(first.messages.at(-1)).toMatchObject({ type: 'bar', data: { volume: 100 } });
    expect(JSON.stringify(first.messages)).not.toContain('server-secret');
    removeFirst();
    removeSecond();
    hub.dispose();
  });
});
