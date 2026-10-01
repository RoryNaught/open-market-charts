/** All engine timestamps are UTC milliseconds. Convert only at adapter boundaries. */
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '1D' | '1W';
export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '1D', '1W'];
export const timeframeMs: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '1D': 86_400_000,
  '1W': 604_800_000,
};
export type SessionMode = 'regular' | 'extended';
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  revision?: number;
  closed?: boolean;
}
export interface Trade {
  id: string;
  symbol: string;
  time: number;
  price: number;
  size: number;
  sequence?: number;
}
export interface Quote {
  symbol: string;
  time: number;
  bid: number;
  ask: number;
  bidSize?: number;
  askSize?: number;
}
export interface Instrument {
  id: string;
  symbol: string;
  name: string;
  provider: string;
  assetClass: 'crypto' | 'stock' | 'etf' | 'index';
  currency: string;
  timezone: string;
  pricePrecision: number;
  volumeUnit: string;
  session: '24x7' | 'us-equities';
}
export interface SessionInterval {
  open: number;
  close: number;
  extendedOpen: number;
  extendedClose: number;
  date: string;
}
export interface ProviderCapabilities {
  timeframes: Timeframe[];
  realtime: boolean;
  trades: boolean;
  quotes: boolean;
  extendedHours: boolean;
  label: string;
  delayMinutes: number;
}
export interface HistoryRequest {
  instrument: Instrument;
  timeframe: Timeframe;
  session: SessionMode;
  before?: number;
  limit: number;
  signal?: AbortSignal;
}
export interface HistoryPage {
  bars: Bar[];
  nextBefore?: number;
  hasMore: boolean;
}
export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'error';
export interface SubscriptionRequest {
  instrument: Instrument;
  timeframe: Timeframe;
  session: SessionMode;
  lastBar?: Bar;
}
export interface StreamCallbacks {
  onBar(bar: Bar): void;
  onQuote?(quote: Quote): void;
  onStatus(status: ConnectionStatus, message?: string): void;
  onGap?(): void;
  onTrade?(trade: Trade): void;
}
export interface HistoricalBarsProvider {
  getHistory(request: HistoryRequest): Promise<HistoryPage>;
}
export interface RealtimeTradesProvider {
  subscribeTrades(instrument: Instrument, onTrade: (trade: Trade) => void): () => void;
}
export interface RealtimeQuotesProvider {
  subscribeQuotes(instrument: Instrument, onQuote: (quote: Quote) => void): () => void;
}
export interface MarketDataProvider extends HistoricalBarsProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  searchSymbols(query: string, signal?: AbortSignal): Promise<Instrument[]>;
  subscribe(request: SubscriptionRequest, callbacks: StreamCallbacks): () => void;
  getSessions?(from: number, to: number, signal?: AbortSignal): Promise<SessionInterval[]>;
  /** Calendar intervals already loaded with history; optional, with no provider-specific UI dependency. */
  getCachedSessions?(): readonly SessionInterval[];
  dispose(): void;
}
export function isValidBar(b: Bar): boolean {
  return (
    [b.time, b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) &&
    b.volume >= 0 &&
    b.high >= Math.max(b.open, b.close, b.low) &&
    b.low <= Math.min(b.open, b.close, b.high)
  );
}
