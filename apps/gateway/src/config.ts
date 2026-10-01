export interface GatewayConfig {
  host: string;
  port: number;
  token?: string;
  allowedOrigins: string[];
  key?: string;
  secret?: string;
  tradingUrl: string;
  dataUrl: string;
  websocketUrl: string;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const host = env.OMC_GATEWAY_HOST ?? '127.0.0.1';
  const port = Number(env.OMC_GATEWAY_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('OMC_GATEWAY_PORT must be a valid port');
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const token = env.OMC_GATEWAY_TOKEN;
  const allowedOrigins = env.OMC_ALLOWED_ORIGINS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? [
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://127.0.0.1:4173',
    'http://localhost:4173',
  ];
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
      throw new Error('Allowed origins must be exact HTTP(S) origins');
  }
  if (!local && (!token || token.length < 32 || !env.OMC_ALLOWED_ORIGINS))
    throw new Error(
      'Remote binding requires a token of at least 32 characters and explicit OMC_ALLOWED_ORIGINS',
    );
  return {
    host,
    port,
    token,
    allowedOrigins,
    key: env.ALPACA_API_KEY,
    secret: env.ALPACA_API_SECRET,
    tradingUrl:
      env.ALPACA_PAPER === 'false'
        ? 'https://api.alpaca.markets'
        : 'https://paper-api.alpaca.markets',
    dataUrl: 'https://data.alpaca.markets',
    websocketUrl: 'wss://stream.data.alpaca.markets/v2/iex',
  };
}
