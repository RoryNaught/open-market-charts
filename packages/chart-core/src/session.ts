import {
  isValidBar,
  type Bar,
  type ConnectionStatus,
  type Instrument,
  type MarketDataProvider,
  type Quote,
  type SessionMode,
  type Timeframe,
} from '@omc/provider-sdk';
import { BarStore } from '@omc/data-engine';

export interface Selection {
  instrument: Instrument;
  timeframe: Timeframe;
  session: SessionMode;
}
export interface SessionState {
  status: ConnectionStatus;
  message: string;
  loading: boolean;
  paginating: boolean;
  hasMore: boolean;
  count: number;
  quote?: Quote;
}
export interface SessionCallbacks {
  onData(
    bars: readonly Bar[],
    change: 'reset' | 'prepend' | 'update',
    changed: readonly Bar[],
  ): void;
  onState(state: SessionState): void;
}
/** Owns request lifetimes. React receives connection state, never market ticks. */
export class MarketSession {
  readonly store = new BarStore();
  private generation = 0;
  private abort?: AbortController;
  private unsubscribe?: () => void;
  private provider?: MarketDataProvider;
  private selection?: Selection;
  private nextBefore?: number;
  private pending = new Map<number, Bar>();
  private frame = 0;
  private recovering = false;
  private lastStateAt = 0;
  state: SessionState = {
    status: 'offline',
    message: '',
    loading: false,
    paginating: false,
    hasMore: false,
    count: 0,
  };
  constructor(private callbacks: SessionCallbacks) {}
  private setState(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    this.callbacks.onState(this.state);
  }
  async open(provider: MarketDataProvider, selection: Selection) {
    this.stop();
    const generation = this.generation;
    this.provider = provider;
    this.selection = selection;
    this.abort = new AbortController();
    this.store.reset([]);
    this.setState({
      status: 'connecting',
      message: 'Loading market history',
      loading: true,
      paginating: false,
      hasMore: false,
      count: 0,
      quote: undefined,
    });
    this.callbacks.onData([], 'reset', []);
    // Start collecting live bars before REST. Per-bar revisions prevent stale history from winning.
    this.unsubscribe = provider.subscribe(selection, {
      onBar: (bar) => {
        if (generation !== this.generation || !isValidBar(bar)) return;
        const pending = this.pending.get(bar.time);
        if (pending && (pending.revision ?? 0) > (bar.revision ?? 0)) return;
        this.pending.set(bar.time, { ...bar });
        if (!this.state.loading) this.scheduleFlush();
      },
      onStatus: (status, message) => {
        if (generation === this.generation) this.setState({ status, message: message ?? '' });
      },
      onQuote: (quote) => {
        if (generation === this.generation) this.state.quote = quote;
      },
      onGap: () => {
        if (generation === this.generation) void this.recover(generation);
      },
    });
    try {
      const page = await provider.getHistory({
        ...selection,
        limit: 900,
        signal: this.abort.signal,
      });
      if (generation !== this.generation) return;
      this.store.reset(page.bars);
      this.store.merge([...this.pending.values()]);
      this.pending.clear();
      this.nextBefore = page.nextBefore;
      this.callbacks.onData(this.store.bars, 'reset', this.store.bars);
      this.setState({
        loading: false,
        count: this.store.length,
        hasMore: page.hasMore,
        message: this.state.status === 'live' ? '' : this.state.message,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.setState({
        loading: false,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private scheduleFlush() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
  }
  private flush() {
    this.frame = 0;
    if (!this.pending.size) return;
    const pending = [...this.pending.values()].sort((a, b) => a.time - b.time);
    this.pending.clear();
    const oldLast = this.store.last?.time ?? -Infinity;
    const changes = pending.filter((bar) => this.store.update(bar));
    if (!changes.length) return;
    this.callbacks.onData(
      this.store.bars,
      changes.some((b) => b.time < oldLast) ? 'reset' : 'update',
      changes,
    );
    if (performance.now() - this.lastStateAt > 1000) {
      this.lastStateAt = performance.now();
      this.setState({ count: this.store.length });
    }
  }
  async loadOlder() {
    if (
      !this.provider ||
      !this.selection ||
      this.state.loading ||
      this.state.paginating ||
      !this.state.hasMore
    )
      return;
    const generation = this.generation;
    this.setState({ paginating: true });
    try {
      const page = await this.provider.getHistory({
        ...this.selection,
        before: this.nextBefore ?? this.store.first?.time,
        limit: 600,
        signal: this.abort?.signal,
      });
      if (generation !== this.generation) return;
      this.store.merge(page.bars);
      this.nextBefore = page.nextBefore;
      this.callbacks.onData(this.store.bars, 'prepend', page.bars);
      this.setState({ hasMore: page.hasMore, count: this.store.length, paginating: false });
    } catch (error) {
      if (generation === this.generation)
        this.setState({
          paginating: false,
          message: `History: ${error instanceof Error ? error.message : error}`,
        });
    }
  }
  private async recover(generation: number) {
    if (this.recovering || this.state.loading || !this.provider || !this.selection) return;
    this.recovering = true;
    const recoveryStarted = Date.now();
    const overlap = this.store.last?.time;
    try {
      const recovered: Bar[] = [];
      let before: number | undefined;
      for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
        const page = await this.provider.getHistory({
          ...this.selection,
          before,
          limit: 300,
          signal: this.abort?.signal,
        });
        if (generation !== this.generation) return;
        recovered.push(...page.bars);
        if (overlap === undefined || page.bars.some((bar) => bar.time <= overlap) || !page.hasMore)
          break;
        const next = page.nextBefore ?? page.bars[0]?.time;
        if (next === undefined || (before !== undefined && next >= before) || pageIndex === 49)
          throw new Error('Recovery history limit reached. Reload this market to resynchronize.');
        before = next;
      }
      // REST is authoritative after a gap; buffered live events still take precedence.
      this.store.merge(recovered.map((b) => ({ ...b, revision: recoveryStarted })));
      this.store.merge([...this.pending.values()]);
      this.pending.clear();
      this.callbacks.onData(this.store.bars, 'reset', this.store.bars);
      this.setState({ count: this.store.length });
    } catch (error) {
      if (generation === this.generation)
        this.setState({
          message: `Backfill failed: ${error instanceof Error ? error.message : error}`,
        });
    } finally {
      if (generation === this.generation) this.recovering = false;
    }
  }
  stop() {
    this.generation++;
    this.recovering = false;
    this.abort?.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pending.clear();
  }
  dispose() {
    this.stop();
  }
}
