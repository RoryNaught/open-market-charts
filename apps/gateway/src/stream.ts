import WebSocket from 'ws';
import type { GatewayConfig } from './config';
import { normalizeBar } from './alpaca-client';

/** One upstream connection multiplexed across local viewers, respecting free-plan connection limits. */
export class AlpacaStreamHub {
  private clients = new Map<WebSocket, string>();
  private upstream?: WebSocket;
  private authenticated = false;
  private subscribed = new Set<string>();
  private confirmed = new Set<string>();
  private readyClients = new Set<WebSocket>();
  private timer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  constructor(
    private config: GatewayConfig,
    private makeSocket = (url: string) => new WebSocket(url),
  ) {}
  private send(client: WebSocket, message: unknown): void {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > 2_000_000) {
      client.close(1013, 'Client too slow; reconnect to repair');
      return;
    }
    client.send(JSON.stringify(message));
  }
  add(client: WebSocket, symbol: string): () => void {
    this.clients.set(client, symbol);
    if (this.authenticated) {
      this.reconcile();
      if (this.confirmed.has(symbol)) {
        this.readyClients.add(client);
        this.send(client, { type: 'ready' });
      }
    } else this.connect();
    return () => {
      this.clients.delete(client);
      this.readyClients.delete(client);
      this.reconcile();
      if (!this.clients.size) {
        if (this.timer) clearTimeout(this.timer);
        this.upstream?.close();
      }
    };
  }
  private reconcile(): void {
    if (!this.authenticated || this.upstream?.readyState !== WebSocket.OPEN) return;
    const desired = new Set(this.clients.values());
    const added = [...desired].filter((s) => !this.subscribed.has(s)),
      removed = [...this.subscribed].filter((s) => !desired.has(s));
    if (removed.length)
      this.upstream.send(
        JSON.stringify({
          action: 'unsubscribe',
          bars: removed,
          updatedBars: removed,
          trades: removed,
          quotes: removed,
        }),
      );
    if (added.length)
      this.upstream.send(
        JSON.stringify({
          action: 'subscribe',
          bars: added,
          updatedBars: added,
          trades: added,
          quotes: added,
        }),
      );
    this.subscribed = desired;
  }
  private connect(): void {
    if (!this.clients.size || (this.upstream && this.upstream.readyState !== WebSocket.CLOSED))
      return;
    if (!this.config.key || !this.config.secret) {
      for (const client of this.clients.keys())
        this.send(client, {
          type: 'error',
          message: 'Alpaca credentials are not configured on the gateway.',
        });
      return;
    }
    this.upstream = this.makeSocket(this.config.websocketUrl);
    this.upstream.on('open', () =>
      this.upstream?.send(
        JSON.stringify({ action: 'auth', key: this.config.key, secret: this.config.secret }),
      ),
    );
    this.upstream.on('message', (raw) => {
      let messages: Record<string, unknown>[];
      try {
        messages = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!Array.isArray(messages)) return;
      for (const message of messages) {
        if (message.T === 'success' && message.msg === 'authenticated') {
          this.authenticated = true;
          this.attempts = 0;
          this.subscribed.clear();
          this.reconcile();
          continue;
        }
        if (message.T === 'subscription') {
          this.confirmed = new Set(Array.isArray(message.bars) ? (message.bars as string[]) : []);
          for (const [client, symbol] of this.clients)
            if (this.confirmed.has(symbol) && !this.readyClients.has(client)) {
              this.readyClients.add(client);
              this.send(client, { type: 'ready' });
            }
          continue;
        }
        if (message.T === 'error') {
          for (const client of this.clients.keys())
            this.send(client, {
              type: 'error',
              message: `Alpaca stream rejected the request (code ${Number(message.code) || 'unknown'}). Check the IEX entitlement and credentials.`,
            });
          continue;
        }
        for (const [client, symbol] of this.clients) {
          if (message.S !== symbol) continue;
          if (message.T === 'b' || message.T === 'u')
            this.send(client, {
              type: 'bar',
              data: normalizeBar(message as unknown as Parameters<typeof normalizeBar>[0]),
            });
          else if (message.T === 't')
            this.send(client, {
              type: 'trade',
              data: {
                id: `${String(message.x)}:${String(message.i)}`,
                symbol,
                time: Date.parse(String(message.t)),
                price: Number(message.p),
                size: Number(message.s),
              },
            });
          else if (message.T === 'q')
            this.send(client, {
              type: 'quote',
              data: {
                symbol,
                time: Date.parse(String(message.t)),
                bid: Number(message.bp),
                ask: Number(message.ap),
              },
            });
          else if (message.T === 'c' || message.T === 'x') this.send(client, { type: 'gap' });
        }
      }
    });
    this.upstream.on('error', () => {
      for (const client of this.clients.keys())
        this.send(client, { type: 'error', message: 'Alpaca upstream connection failed.' });
    });
    this.upstream.on('close', () => {
      this.authenticated = false;
      this.subscribed.clear();
      this.confirmed.clear();
      this.readyClients.clear();
      this.upstream = undefined;
      if (this.clients.size) {
        for (const client of this.clients.keys())
          this.send(client, { type: 'offline', message: 'Reconnecting to Alpaca' });
        this.timer = setTimeout(
          () => this.connect(),
          Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)),
        );
      }
    });
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.clients.clear();
    this.upstream?.close();
  }
}
