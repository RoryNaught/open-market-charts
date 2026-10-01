export type FetchLike = typeof fetch;
export type WebSocketFactory = (url: string) => WebSocket;
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function fetchJson<T>(
  url: string,
  options: RequestInit = {},
  fetcher: FetchLike = fetch,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(20_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await fetcher(url, { ...options, signal });
    if (response.ok) return response.json() as Promise<T>;
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const retry = Number(response.headers.get('retry-after'));
      await wait(
        Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 30_000) : 500 * 2 ** attempt,
        options.signal ?? undefined,
      );
      continue;
    }
    throw new ProviderError(
      response.status === 401 || response.status === 403
        ? 'Market data authorization failed. Check the provider connection and entitlements.'
        : `Market data request failed (${response.status}).`,
      response.status,
    );
  }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Market data request failed';
}
