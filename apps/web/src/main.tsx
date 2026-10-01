import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowUpRight,
  ArrowLeftRight,
  BarChart3,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Crosshair,
  Download,
  Layers,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  Radio,
  Redo2,
  Search,
  Settings2,
  Square,
  Trash2,
  Undo2,
  Upload,
  X,
  PanelRightClose,
  PanelRightOpen,
  MoveHorizontal,
  MoveVertical,
  GitBranch,
  Waypoints,
} from 'lucide-react';
import {
  TIMEFRAMES,
  type Instrument,
  type MarketDataProvider,
  type Bar,
  type SessionInterval,
} from '@omc/provider-sdk';
import {
  CoinbaseProvider,
  AlpacaProvider,
  SimulatedProvider,
  COINBASE_INSTRUMENTS,
  ALPACA_INSTRUMENTS,
  SIMULATED_INSTRUMENTS,
} from '@omc/data-engine';
import {
  MarketSession,
  WorkspaceRepository,
  parseWorkspace,
  type Workspace,
  type SessionState,
} from '@omc/chart-core';
import { ChartRenderer } from '@omc/chart-renderer';
import {
  IndicatorWorkerClient,
  createIndicatorConfig,
  INDICATOR_TYPES,
  defaultRegistry,
  type IndicatorStatus,
} from '@omc/indicator-engine';
import {
  DrawingStore,
  DrawingInteraction,
  DRAWING_TOOLS,
  type DrawingTool,
} from '@omc/drawing-engine';
import './style.css';

const developerMode = new URLSearchParams(location.search).get('dev') === '1';
const repository = new WorkspaceRepository();
const defaultWorkspace: Workspace = {
  version: 1,
  name: 'My workspace',
  instrument: (developerMode ? SIMULATED_INSTRUMENTS : COINBASE_INSTRUMENTS)[0],
  timeframe: '5m',
  session: 'regular',
  chartType: 'candles',
  scale: 'linear',
  indicators: [createIndicatorConfig('EMA', 'ema-default')],
  drawings: { schemaVersion: 1, drawings: [] },
  watchlist: COINBASE_INSTRUMENTS,
  paneHeights: [],
  showWatchlist: true,
  volume: true,
};
const toolNames: Record<DrawingTool, string> = {
  'trend-line': 'Trend line',
  'horizontal-line': 'Horizontal line',
  'vertical-line': 'Vertical line',
  ray: 'Ray',
  rectangle: 'Rectangle',
  'price-range': 'Price range',
  'date-range': 'Date range',
  fibonacci: 'Fibonacci retracement',
  'parallel-channel': 'Parallel channel',
};
const toolIcons: Record<DrawingTool, React.ElementType> = {
  'trend-line': ArrowUpRight,
  'horizontal-line': Minus,
  'vertical-line': MoveVertical,
  ray: Waypoints,
  rectangle: Square,
  'price-range': ArrowLeftRight,
  'date-range': MoveHorizontal,
  fibonacci: Layers,
  'parallel-channel': GitBranch,
};
const number = (v: number, d = 2) =>
  v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const parameterNames: Record<string, string> = {
  leftBars: 'Left bars',
  rightBars: 'Confirm bars',
  maxAnnotations: 'Keep events',
  sweeps: 'Swing sweeps',
  withinSession: 'Same session only',
  minGapPercent: 'Min gap %',
  bands1: 'Inner σ',
  bands2: 'Outer σ',
  bbMultiplier: 'BB width',
  kcMultiplier: 'KC width',
};
const studyLabels: Record<string, string> = {
  AnchoredVWAP: 'Anchored VWAP',
  SqueezeMomentum: 'Squeeze momentum',
  MarketStructure: 'Structure',
  FairValueGaps: 'Fair value gaps',
};
interface Runtime {
  renderer: ChartRenderer;
  session: MarketSession;
  worker: IndicatorWorkerClient;
  drawings: DrawingStore;
  interaction: DrawingInteraction;
  providers: Map<string, MarketDataProvider>;
  paneId: string;
  refreshSessions(sessions: readonly SessionInterval[]): void;
}

function App({ initial }: { initial: Workspace }) {
  const [workspace, setWorkspace] = useState(initial);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [state, setState] = useState<SessionState>({
    status: 'connecting',
    message: '',
    loading: true,
    paginating: false,
    hasMore: false,
    count: 0,
  });
  const [panel, setPanel] = useState<'symbols' | 'indicators' | 'settings' | 'help' | null>(null);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Instrument[]>([]);
  const [tool, setTool] = useState<DrawingTool | null>(null);
  const [anchorTarget, setAnchorTarget] = useState<string | null>(null);
  const anchorTargetRef = useRef(anchorTarget);
  anchorTargetRef.current = anchorTarget;
  const [indicatorStatuses, setIndicatorStatuses] = useState<Record<string, IndicatorStatus>>({});
  const indicatorStatusesRef = useRef<Record<string, IndicatorStatus>>({});
  const [drawingVersion, setDrawingVersion] = useState(0);
  const [notice, setNotice] = useState('');
  const [saveStatus, setSaveStatus] = useState('Saved locally');
  const [gatewayUrl, setGatewayUrl] = useState(
    import.meta.env.VITE_GATEWAY_URL ?? 'http://127.0.0.1:8787',
  );
  const [gatewayToken, setGatewayToken] = useState('');
  const [stockConnected, setStockConnected] = useState(0);
  const host = useRef<HTMLDivElement>(null),
    ohlc = useRef<HTMLDivElement>(null),
    price = useRef<HTMLSpanElement>(null),
    runtime = useRef<Runtime | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const pendingLayout = useRef<number[] | null>(initial.paneHeights);
  const patch = (change: Partial<Workspace>) => setWorkspace((w) => ({ ...w, ...change }));
  const updateLegend = (bar?: Bar) => {
    if (!bar) {
      if (price.current) price.current.textContent = '—';
      if (ohlc.current) ohlc.current.textContent = 'Waiting for market data';
      return;
    }
    if (price.current) {
      price.current.textContent = number(bar.close, workspaceRef.current.instrument.pricePrecision);
      price.current.className = bar.close >= bar.open ? 'positive' : 'negative';
    }
    if (ohlc.current) {
      ohlc.current.replaceChildren();
      for (const [label, value] of [
        ['O', bar.open],
        ['H', bar.high],
        ['L', bar.low],
        ['C', bar.close],
        ['V', bar.volume],
      ] as const) {
        const span = document.createElement('span');
        const labelNode = document.createElement('b');
        labelNode.textContent = label + ' ';
        span.append(
          labelNode,
          document.createTextNode(
            number(value, label === 'V' ? 2 : workspaceRef.current.instrument.pricePrecision),
          ),
        );
        ohlc.current.append(span);
      }
    }
  };
  useEffect(() => {
    let active = true;
    let visibleTimer: ReturnType<typeof setTimeout> | undefined;
    const drawings = new DrawingStore([], 200);
    try {
      drawings.restore(initial.drawings);
    } catch {
      setNotice('Saved drawing data could not be restored.');
    }
    let session: MarketSession, worker: IndicatorWorkerClient;
    let workerCalendar = '';
    const resetIndicators = (bars: readonly Bar[], sessions: readonly SessionInterval[]) => {
      const w = workspaceRef.current;
      workerCalendar = JSON.stringify(sessions);
      worker.reset(bars, w.indicators, {
        timezone: w.instrument.timezone,
        sessions,
        vwapAnchor: ['1D', '1W'].includes(w.timeframe) ? 'month' : 'session',
      });
    };
    const renderer = new ChartRenderer(host.current!, {
      onNeedHistory: () => void session?.loadOlder(),
      onCrosshair: (bar) => updateLegend(bar ?? session?.store.last),
      onVisibleRange: (from, to) => {
        clearTimeout(visibleTimer);
        visibleTimer = setTimeout(() => worker?.setVisibleRange(from, to), 100);
      },
    });
    worker = new IndicatorWorkerClient({
      onResults: (results, mode) => {
        if (active) {
          renderer.renderIndicators(results, mode);
          const statuses = { ...indicatorStatusesRef.current };
          for (const result of results) {
            if (result.status) statuses[result.id] = result.status;
            else delete statuses[result.id];
          }
          if (JSON.stringify(statuses) !== JSON.stringify(indicatorStatusesRef.current)) {
            indicatorStatusesRef.current = statuses;
            setIndicatorStatuses(statuses);
          }
          if (pendingLayout.current && session.store.length) {
            renderer.setPaneHeights(pendingLayout.current);
            pendingLayout.current = null;
          }
          if (mode === 'reset') renderer.setLeftScale(!!workspaceRef.current.leftScale);
        }
      },
      onError: (error) => setNotice(String(error)),
    });
    session = new MarketSession({
      onState: (s) => {
        if (active) setState({ ...s });
      },
      onData: (bars, change, changed) => {
        renderer.setBars(bars, change, changed);
        updateLegend(bars.at(-1));
        const w = workspaceRef.current;
        const provider = runtime.current?.providers.get(w.instrument.provider);
        const sessions = provider?.getCachedSessions?.() ?? [];
        renderer.setSessions(sessions, w.session);
        if (change === 'update' && JSON.stringify(sessions) === workerCalendar)
          worker.update([...changed]);
        else resetIndicators(bars, sessions);
      },
    });
    const providers = new Map<string, MarketDataProvider>();
    const coinbase = new CoinbaseProvider();
    providers.set(coinbase.id, coinbase);
    if (developerMode) {
      const simulated = new SimulatedProvider();
      providers.set(simulated.id, simulated);
    }
    const rt = { renderer, session, worker, drawings, providers, paneId: 'price' } as Runtime;
    const interaction = new DrawingInteraction(
      drawings,
      () => renderer.adapter(rt.paneId),
      () => ({ symbolId: workspaceRef.current.instrument.id, paneId: rt.paneId, scaleId: 'right' }),
      () => renderer.setDrawings(interaction.getRenderDrawings(), drawings.getSelected()?.id),
    );
    rt.interaction = interaction;
    runtime.current = rt;
    rt.refreshSessions = (sessions) => {
      renderer.setSessions(sessions, workspaceRef.current.session);
      if (JSON.stringify(sessions) !== workerCalendar)
        resetIndicators(session.store.bars, sessions);
    };
    const unsubscribe = drawings.subscribe(() => {
      renderer.setDrawings(drawings.getAll(), drawings.getSelected()?.id);
      setDrawingVersion((v) => v + 1);
    });
    renderer.setDrawings(drawings.getAll(), drawings.getSelected()?.id);
    const el = host.current!;
    let captured = false;
    const point = (e: PointerEvent) => {
      const p = renderer.locate(e.clientX, e.clientY, captured ? rt.paneId : undefined);
      if (!p) return null;
      if (!captured) rt.paneId = p.paneId;
      return p;
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const p = point(e);
      if (!p) return;
      if (anchorTargetRef.current) {
        if (p.paneId !== 'price') return;
        const time = renderer.adapter('price').xToTime(p.x);
        const bars = session.store.bars;
        if (time !== null && bars.length) {
          // Anchor to the closest actual candle, never to pixels or a moving bar index.
          let low = 0,
            high = bars.length;
          while (low < high) {
            const mid = (low + high) >>> 1;
            if (bars[mid].time < time) low = mid + 1;
            else high = mid;
          }
          const next = bars[Math.min(low, bars.length - 1)],
            previous = bars[Math.max(0, low - 1)];
          const anchorTime =
            Math.abs(next.time - time) < Math.abs(previous.time - time) ? next.time : previous.time;
          const target = anchorTargetRef.current;
          setWorkspace((w) => ({
            ...w,
            indicators: w.indicators.map((c) =>
              c.id === target ? { ...c, params: { ...c.params, anchorTime } } : c,
            ),
          }));
          setAnchorTarget(null);
          setNotice(
            `VWAP anchored to ${new Date(anchorTime).toISOString().replace('T', ' ').slice(0, 19)} UTC`,
          );
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      const owned = interaction.pointerDown(p, e.pointerType === 'touch' ? 12 : 6);
      if (owned) {
        captured = true;
        renderer.setGestures(false);
        el.setPointerCapture(e.pointerId);
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const move = (e: PointerEvent) => {
      const p = point(e);
      if (!p) return;
      const annotation = renderer.annotationAt(p.x, p.y, p.paneId);
      el.title = annotation
        ? `${annotation.text}${annotation.status ? ' · ' + annotation.status : ''}\nConfirmed at close of ${new Date(annotation.confirmedAt).toISOString()} candle`
        : '';
      interaction.pointerMove(p);
      if (captured) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const release = (e: PointerEvent) => {
      if (!captured) {
        setDrawingVersion((v) => v + 1);
        return;
      }
      const p = point(e);
      if (p) interaction.pointerUp(p);
      else interaction.cancel();
      if (!interaction.activeTool) setTool(null);
      captured = false;
      renderer.setGestures(true);
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      e.stopImmediatePropagation();
    };
    const cancel = () => {
      interaction.cancel();
      captured = false;
      renderer.setGestures(true);
    };
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches('input,select,textarea')) return;
      if (e.key === 'Escape') {
        cancel();
        setTool(null);
        setAnchorTarget(null);
        setPanel(null);
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const selected = drawings.getSelected();
        if (selected) drawings.remove(selected.id);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) drawings.redo();
        else drawings.undo();
      }
    };
    el.addEventListener('pointerdown', down, true);
    el.addEventListener('pointermove', move, true);
    el.addEventListener('pointerup', release, true);
    el.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key);
    if (developerMode) (window as unknown as { __OMC: Runtime }).__OMC = rt;
    return () => {
      active = false;
      clearTimeout(visibleTimer);
      session.dispose();
      worker.dispose();
      unsubscribe();
      providers.forEach((p) => p.dispose());
      el.removeEventListener('pointerdown', down, true);
      el.removeEventListener('pointermove', move, true);
      el.removeEventListener('pointerup', release, true);
      el.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key);
      renderer.dispose();
      runtime.current = null;
    };
  }, []);
  useEffect(() => {
    const rt = runtime.current;
    if (!rt) return;
    const provider = rt.providers.get(workspace.instrument.provider);
    const calendarAbort = new AbortController();
    rt.interaction.cancel();
    rt.drawings.select(null);
    setTool(null);
    rt.renderer.configure(
      workspace.instrument,
      workspace.timeframe,
      workspace.chartType,
      workspace.scale,
    );
    if (provider) {
      void rt.session.open(provider, {
        instrument: workspace.instrument,
        timeframe: workspace.timeframe,
        session: workspace.session,
      });
      if (provider.getSessions)
        void provider
          .getSessions(Date.now(), Date.now() + 90 * 86400000, calendarAbort.signal)
          .then((sessions) => {
            if (!calendarAbort.signal.aborted)
              rt.refreshSessions(provider.getCachedSessions?.() ?? sessions);
          })
          .catch((error) => {
            if (!calendarAbort.signal.aborted) setNotice(`Future session calendar: ${error}`);
          });
    } else {
      rt.session.stop();
      rt.session.store.reset([]);
      rt.renderer.setBars([], 'reset', []);
      rt.worker.reset([], workspace.indicators);
      updateLegend();
      setState((s) => ({
        ...s,
        status: 'offline',
        loading: false,
        count: 0,
        hasMore: false,
        message: 'Connect the stock gateway in Feed settings to load this instrument.',
      }));
    }
    return () => calendarAbort.abort();
  }, [workspace.instrument.id, workspace.timeframe, workspace.session, stockConnected]);
  useEffect(() => {
    runtime.current?.renderer.configure(
      workspace.instrument,
      workspace.timeframe,
      workspace.chartType,
      workspace.scale,
    );
  }, [workspace.chartType, workspace.scale]);
  useEffect(() => {
    const rt = runtime.current;
    if (!rt) return;
    rt.renderer.setIndicators(workspace.indicators);
    rt.worker.setIndicators(workspace.indicators);
    if (
      anchorTargetRef.current &&
      !workspace.indicators.some((c) => c.id === anchorTargetRef.current)
    )
      setAnchorTarget(null);
  }, [workspace.indicators]);
  useEffect(() => {
    runtime.current?.interaction.setTool(tool);
  }, [tool]);
  useEffect(() => {
    runtime.current?.renderer.setVolume(workspace.volume);
  }, [workspace.volume]);
  useEffect(() => {
    runtime.current?.renderer.setLeftScale(!!workspace.leftScale);
  }, [workspace.leftScale]);
  useEffect(() => {
    setSaveStatus('Saving…');
    const timer = setTimeout(() => {
      const rt = runtime.current;
      const snapshot = {
        ...workspace,
        drawings: rt?.drawings.serialize() ?? workspace.drawings,
        paneHeights: rt?.renderer.getPaneHeights() ?? [],
      };
      void repository
        .save(snapshot)
        .then(() => setSaveStatus('Saved locally'))
        .catch(() => setSaveStatus('Storage unavailable — export to save'));
    }, 500);
    return () => clearTimeout(timer);
  }, [workspace, drawingVersion]);
  useEffect(() => {
    if (panel !== 'symbols') return;
    let active = true;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      const rt = runtime.current;
      if (!rt) return;
      const all = await Promise.allSettled(
        [...rt.providers.values()].map((p) => p.searchSymbols(query, abort.signal)),
      );
      if (active) setSearchResults(all.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, panel, stockConnected]);
  const choose = (instrument: Instrument) => {
    setAnchorTarget(null);
    patch({ instrument });
    setPanel(null);
    setQuery('');
  };
  const addIndicator = (type: string) => {
    if (workspace.indicators.length >= 30) {
      setNotice('A workspace supports up to 30 indicators.');
      return;
    }
    const config = createIndicatorConfig(type);
    if (type === 'AnchoredVWAP') {
      const rt = runtime.current,
        bars = rt?.session.store.bars ?? [];
      const range = rt?.renderer.chart.timeScale().getVisibleLogicalRange();
      config.params.anchorTime =
        bars[Math.max(0, Math.min(bars.length - 1, Math.ceil(range?.from ?? 0)))]?.time ?? 0;
    }
    patch({ indicators: [...workspace.indicators, config] });
  };
  const exportWorkspace = () => {
    const rt = runtime.current;
    const data = {
      ...workspace,
      drawings: rt?.drawings.serialize() ?? workspace.drawings,
      paneHeights: rt?.renderer.getPaneHeights() ?? [],
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'open-market-workspace.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importWorkspace = async (file?: File) => {
    if (!file) return;
    try {
      const next = parseWorkspace(await file.text());
      pendingLayout.current = next.paneHeights;
      runtime.current?.drawings.restore(next.drawings);
      setWorkspace(next);
      setNotice('Workspace restored.');
    } catch (error) {
      setNotice(`Import failed: ${error instanceof Error ? error.message : error}`);
    }
    if (importInput.current) importInput.current.value = '';
  };
  const connectStocks = () => {
    try {
      const provider = new AlpacaProvider({
        baseUrl: gatewayUrl,
        token: gatewayToken || undefined,
      });
      runtime.current?.providers.get(provider.id)?.dispose();
      runtime.current?.providers.set(provider.id, provider);
      setStockConnected((value) => value + 1);
      patch({
        instrument: ALPACA_INSTRUMENTS[0],
        watchlist: [...COINBASE_INSTRUMENTS, ...ALPACA_INSTRUMENTS],
      });
      setPanel(null);
    } catch (error) {
      setNotice(String(error));
    }
  };
  const selected = runtime.current?.drawings.getSelected();
  const statusLabel =
    developerMode && workspace.instrument.provider === 'simulated'
      ? 'SIMULATED'
      : state.status.toUpperCase();
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Open Market Charts">
          <span className="brandmark">
            <Activity size={21} />
          </span>
          <span>
            open<span className="brandlight">market</span>
            <small>CHARTS</small>
          </span>
        </a>
        <div className="topdivider" />
        <button
          className="symbol-control"
          onClick={() => setPanel(panel === 'symbols' ? null : 'symbols')}
        >
          <Search size={15} />
          <strong>{workspace.instrument.symbol}</strong>
          <ChevronDown size={13} />
        </button>
        <div className="timeframes">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              className={workspace.timeframe === tf ? 'active' : ''}
              onClick={() => patch({ timeframe: tf })}
            >
              {tf}
            </button>
          ))}
        </div>
        <div className="topdivider" />
        <label className="chart-select">
          <BarChart3 size={16} />
          <select
            aria-label="Chart type"
            value={workspace.chartType}
            onChange={(e) => patch({ chartType: e.target.value as Workspace['chartType'] })}
          >
            <option value="candles">Candles</option>
            <option value="bars">Bars</option>
            <option value="line">Line</option>
            <option value="area">Area</option>
            <option value="heikin-ashi">Heikin-Ashi</option>
          </select>
        </label>
        <button
          className={panel === 'indicators' ? 'topbutton active' : 'topbutton'}
          onClick={() => setPanel(panel === 'indicators' ? null : 'indicators')}
        >
          <Activity size={16} />
          Indicators<span className="count">{workspace.indicators.length}</span>
        </button>
        <div className="topspacer" />
        <span className="workspace-label">
          <span className="save-dot" />
          {workspace.name}
        </span>
        <button
          className="icon"
          title="Feed settings"
          aria-label="Feed settings"
          onClick={() => setPanel('settings')}
        >
          <Settings2 size={17} />
        </button>
        <button
          className="icon"
          title="Toggle watchlist"
          aria-label="Toggle watchlist"
          onClick={() => patch({ showWatchlist: !workspace.showWatchlist })}
        >
          {workspace.showWatchlist ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
        </button>
      </header>
      <div className="workarea">
        <nav className="drawing-toolbar" aria-label="Drawing tools">
          <button
            title="Select / pan (Esc)"
            aria-label="Select / pan"
            className={tool === null ? 'active' : ''}
            onClick={() => setTool(null)}
          >
            <MousePointer2 size={19} />
          </button>
          <div className="tool-separator" />
          {DRAWING_TOOLS.map((t) => {
            const Icon = toolIcons[t];
            return (
              <button
                key={t}
                title={toolNames[t]}
                aria-label={toolNames[t]}
                className={tool === t ? 'active' : ''}
                onClick={() => setTool(tool === t ? null : t)}
              >
                <Icon size={19} />
              </button>
            );
          })}
          <div className="tool-separator" />
          <button
            title="Undo (⌘Z)"
            aria-label="Undo"
            onClick={() => runtime.current?.drawings.undo()}
          >
            <Undo2 size={18} />
          </button>
          <button
            title="Redo (⌘⇧Z)"
            aria-label="Redo"
            onClick={() => runtime.current?.drawings.redo()}
          >
            <Redo2 size={18} />
          </button>
          <button
            title="Delete selected drawing"
            aria-label="Delete drawing"
            disabled={!selected}
            onClick={() => selected && runtime.current?.drawings.remove(selected.id)}
          >
            <Trash2 size={17} />
          </button>
          <div className="toolspacer" />
          <button title="Help" aria-label="Help" onClick={() => setPanel('help')}>
            <CircleHelp size={18} />
          </button>
        </nav>
        <main className="chart-column">
          <div className="instrument-header">
            <div className="instrument-name">
              <span className="asset-icon">
                {workspace.instrument.assetClass === 'crypto' ? '₿' : 'S'}
              </span>
              <h1>
                {workspace.instrument.name}
                <span>
                  {workspace.instrument.symbol} · {workspace.timeframe} ·{' '}
                  {workspace.instrument.provider.toUpperCase()}
                </span>
              </h1>
            </div>
            <div className="current-price">
              <span ref={price}>—</span>
              <small>{workspace.instrument.currency}</small>
            </div>
            <span className={`feed-status ${state.status}`}>
              <i />
              {statusLabel}
            </span>
          </div>
          <div className="chart-legend">
            <div ref={ohlc} className="ohlc">
              <span>Waiting for market data</span>
            </div>
            <div className="chart-actions">
              <button
                title="Autoscale"
                aria-label="Autoscale"
                onClick={() => runtime.current?.renderer.autoscale()}
              >
                <Crosshair size={14} />
              </button>
              <button
                title="Fit all history"
                aria-label="Fit all history"
                onClick={() => runtime.current?.renderer.fit()}
              >
                <Maximize2 size={14} />
              </button>
            </div>
          </div>
          <div className="indicator-chips">
            {workspace.indicators.map((c) => (
              <span className="indicator-chip" key={c.id}>
                <i style={{ background: c.color }} />
                <button onClick={() => setPanel('indicators')}>
                  {studyLabels[c.type] ?? c.type}
                  {c.params.period ? ` ${c.params.period}` : ''}
                </button>
                {indicatorStatuses[c.id] && (
                  <span className="indicator-warning" title={indicatorStatuses[c.id].message}>
                    !
                  </span>
                )}
                <button
                  title={`Remove ${c.type}`}
                  aria-label={`Remove ${c.type}`}
                  onClick={() =>
                    patch({ indicators: workspace.indicators.filter((i) => i.id !== c.id) })
                  }
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            {!workspace.indicators.length && <span className="muted">Price chart</span>}
          </div>
          <div className="canvas-wrap">
            <div
              ref={host}
              className={`chart-host ${anchorTarget ? 'picking-anchor' : ''}`}
              data-testid="chart"
            />
            {anchorTarget && (
              <div className="anchor-hint" role="status">
                Click a candle to anchor VWAP{' '}
                <button onClick={() => setAnchorTarget(null)}>Cancel</button>
              </div>
            )}
            {state.loading && (
              <div className="chart-message">
                <div className="spinner" />
                <strong>Connecting to {workspace.instrument.provider}</strong>
                <span>Loading market history</span>
              </div>
            )}
            {!state.loading && state.status === 'error' && state.count === 0 && (
              <div className="chart-message error">
                <Radio size={25} />
                <strong>Market data unavailable</strong>
                <span>{state.message}</span>
                <button
                  onClick={() => {
                    const rt = runtime.current,
                      p = rt?.providers.get(workspace.instrument.provider);
                    if (p)
                      void rt?.session.open(p, {
                        instrument: workspace.instrument,
                        timeframe: workspace.timeframe,
                        session: workspace.session,
                      });
                  }}
                >
                  Retry connection
                </button>
              </div>
            )}
            {state.paginating && <div className="history-loading">Loading earlier history…</div>}
            {tool && (
              <div className="drawing-hint">
                {toolNames[tool]} · drag to draw
                {tool === 'parallel-channel' ? ' · then set channel width' : ''} · Esc to cancel
              </div>
            )}
            {selected && (
              <div className="drawing-properties">
                <span>{toolNames[selected.type]}</span>
                <input
                  aria-label="Drawing color"
                  type="color"
                  value={selected.style.color}
                  onChange={(e) =>
                    runtime.current?.drawings.update(selected.id, {
                      style: { ...selected.style, color: e.target.value },
                    })
                  }
                />
                <select
                  aria-label="Drawing width"
                  value={selected.style.lineWidth}
                  onChange={(e) =>
                    runtime.current?.drawings.update(selected.id, {
                      style: { ...selected.style, lineWidth: Number(e.target.value) },
                    })
                  }
                >
                  {[1, 2, 3, 4].map((w) => (
                    <option value={w} key={w}>
                      {w}px
                    </option>
                  ))}
                </select>
                <button
                  aria-label="Delete selected"
                  onClick={() => runtime.current?.drawings.remove(selected.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </div>
          <div className="chart-bottom">
            <button
              onClick={() => runtime.current?.session.loadOlder()}
              disabled={state.paginating || !state.hasMore}
            >
              ← Earlier history
            </button>
            <span className="muted">{workspace.instrument.timezone}</span>
            <div className="topspacer" />
            <label>
              <input
                type="checkbox"
                checked={workspace.volume}
                onChange={(e) => patch({ volume: e.target.checked })}
              />
              Volume
            </label>
            {workspace.instrument.session === 'us-equities' && (
              <select
                aria-label="Trading session"
                value={workspace.session}
                onChange={(e) => patch({ session: e.target.value as Workspace['session'] })}
              >
                <option value="regular">Regular session</option>
                <option value="extended">Extended hours</option>
              </select>
            )}
            <select
              aria-label="Price scale"
              value={workspace.scale}
              onChange={(e) => patch({ scale: e.target.value as Workspace['scale'] })}
            >
              <option value="linear">Linear</option>
              <option value="log">Logarithmic</option>
              <option value="percentage">Percentage</option>
            </select>
            <button onClick={() => runtime.current?.renderer.latest()}>
              Latest
              <ChevronRight size={13} />
            </button>
          </div>
        </main>
        {workspace.showWatchlist && (
          <aside className="watchlist">
            <div className="aside-heading">
              <h2>Watchlist</h2>
              <button aria-label="Add symbol" onClick={() => setPanel('symbols')}>
                <Plus size={16} />
              </button>
            </div>
            <div className="watchlist-columns">
              <span>SYMBOL</span>
              <span>MARKET</span>
            </div>
            {workspace.watchlist.map((i) => (
              <button
                key={i.id}
                className={`watch-row ${workspace.instrument.id === i.id ? 'selected' : ''}`}
                onClick={() => choose(i)}
              >
                <span className="watch-asset">{i.assetClass === 'crypto' ? '◈' : '◉'}</span>
                <span>
                  <strong>{i.symbol}</strong>
                  <small>{i.name}</small>
                </span>
                <span className="market-tag">{i.assetClass === 'crypto' ? 'CRYPTO' : 'US'}</span>
              </button>
            ))}
            <button className="add-symbol" onClick={() => setPanel('symbols')}>
              <Plus size={14} />
              Add symbol
            </button>
            <div className="market-details">
              <div className="eyebrow">INSTRUMENT DETAILS</div>
              <h3>{workspace.instrument.name}</h3>
              <p>{workspace.instrument.symbol}</p>
              <dl>
                <dt>Exchange / feed</dt>
                <dd>{workspace.instrument.provider}</dd>
                <dt>Currency</dt>
                <dd>{workspace.instrument.currency}</dd>
                <dt>Volume unit</dt>
                <dd>{workspace.instrument.volumeUnit}</dd>
                <dt>Session</dt>
                <dd>
                  {workspace.instrument.session === '24x7' ? '24 hours · 7 days' : 'US equities'}
                </dd>
                <dt>Loaded bars</dt>
                <dd>{state.count.toLocaleString()}</dd>
              </dl>
              <div className="feed-note">
                <Radio size={15} />
                <span>
                  {workspace.instrument.provider === 'coinbase'
                    ? 'Live trades from Coinbase Exchange.'
                    : workspace.instrument.provider === 'alpaca'
                      ? 'Alpaca IEX feed. Exchange coverage is not consolidated.'
                      : 'Explicit developer simulation.'}
                </span>
              </div>
            </div>
            <div className="aside-bottom">
              <span>YOUR DATA. YOUR WORKSPACE.</span>
              <p>
                Open source charting.
                <br />
                Built to make room for your ideas.
              </p>
              <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
                Charts powered by TradingView ↗
              </a>
            </div>
          </aside>
        )}
      </div>
      <footer>
        <span className={`connection-dot ${state.status}`} />
        <span>{state.status === 'live' ? 'Connected' : state.status}</span>
        <span className="footer-divider" />
        {state.message && (
          <span className="footer-message" title={state.message}>
            {state.message}
          </span>
        )}
        <span>{state.count.toLocaleString()} bars</span>
        <div className="topspacer" />
        <span>{saveStatus}</span>
        <button onClick={exportWorkspace} title="Export workspace" aria-label="Export workspace">
          <Download size={13} />
          Export
        </button>
        <button
          onClick={() => importInput.current?.click()}
          title="Import workspace"
          aria-label="Import workspace"
        >
          <Upload size={13} />
          Import
        </button>
        <input
          hidden
          type="file"
          accept="application/json,.json"
          ref={importInput}
          onChange={(e) => void importWorkspace(e.target.files?.[0])}
        />
      </footer>
      {panel && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPanel(null);
          }}
        >
          <section
            className={`modal ${panel === 'indicators' ? 'wide' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-label={panel}
          >
            <div className="modal-header">
              <h2>
                {panel === 'symbols'
                  ? 'Find a market'
                  : panel === 'indicators'
                    ? 'Indicators'
                    : panel === 'settings'
                      ? 'Data connections'
                      : 'Your chart workspace'}
              </h2>
              <button aria-label="Close dialog" onClick={() => setPanel(null)}>
                <X size={18} />
              </button>
            </div>
            {panel === 'symbols' && (
              <>
                <label className="search-input">
                  <Search size={18} />
                  <input
                    autoFocus
                    placeholder="Search symbol or name…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <div className="search-tags">
                  <span>Coinbase · crypto</span>
                  {stockConnected ? (
                    <span>Alpaca · IEX</span>
                  ) : (
                    <button onClick={() => setPanel('settings')}>Connect stocks ↗</button>
                  )}
                </div>
                <div className="symbol-results">
                  {searchResults.map((i) => (
                    <div className="symbol-result" key={i.id}>
                      <button onClick={() => choose(i)}>
                        <strong>{i.symbol}</strong>
                        <span>{i.name}</span>
                        <small>{i.provider}</small>
                      </button>
                      <button
                        title={`Watch ${i.symbol}`}
                        aria-label={`Watch ${i.symbol}`}
                        onClick={() => {
                          if (!workspace.watchlist.some((w) => w.id === i.id))
                            patch({ watchlist: [...workspace.watchlist, i] });
                        }}
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                  ))}
                  {searchResults.length === 0 && <p className="empty">No matching instruments.</p>}
                </div>
              </>
            )}
            {panel === 'indicators' && (
              <>
                <p className="modal-intro">
                  Add a study, then tune it to your market. Structure and gap signals confirm at
                  candle close.
                </p>
                {(['advanced', 'standard'] as const).map((category) => (
                  <div key={category}>
                    <div className="catalog-heading">
                      <span className="eyebrow">
                        {category === 'advanced' ? 'ADVANCED STUDIES' : 'ESSENTIALS'}
                      </span>
                      {category === 'advanced' && (
                        <span className="catalog-badge">Open source · 5 studies</span>
                      )}
                    </div>
                    <div className={`indicator-catalog ${category}`}>
                      {INDICATOR_TYPES.filter(
                        (type) => (defaultRegistry.get(type).category ?? 'standard') === category,
                      ).map((type) => (
                        <button
                          key={type}
                          aria-label={type}
                          title={`Add ${defaultRegistry.get(type).name}`}
                          onClick={() => addIndicator(type)}
                        >
                          <Activity size={16} />
                          <span>
                            <strong>{defaultRegistry.get(type).name}</strong>
                            {category === 'advanced' && (
                              <small>{defaultRegistry.get(type).description}</small>
                            )}
                          </span>
                          <Plus size={15} />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="eyebrow">ON THIS CHART</div>
                <div className="indicator-settings">
                  {workspace.indicators.map((c) => (
                    <div className="indicator-setting" key={c.id}>
                      <strong>{defaultRegistry.get(c.type).name}</strong>
                      {defaultRegistry.get(c.type).outputs.length > 0 &&
                        !['Supertrend', 'SqueezeMomentum'].includes(c.type) && (
                          <input
                            type="color"
                            aria-label={`${c.type} color`}
                            value={c.color}
                            onChange={(e) =>
                              patch({
                                indicators: workspace.indicators.map((i) =>
                                  i.id === c.id ? { ...i, color: e.target.value } : i,
                                ),
                              })
                            }
                          />
                        )}
                      {c.type === 'AnchoredVWAP' && (
                        <div className="anchor-control">
                          <label>
                            Anchor · UTC
                            <input
                              aria-label="AnchoredVWAP anchor UTC"
                              type="datetime-local"
                              step="1"
                              value={
                                c.params.anchorTime
                                  ? new Date(c.params.anchorTime).toISOString().slice(0, 19)
                                  : ''
                              }
                              onChange={(e) => {
                                const anchorTime = Date.parse(e.target.value + 'Z');
                                if (Number.isFinite(anchorTime) && anchorTime > 0)
                                  patch({
                                    indicators: workspace.indicators.map((i) =>
                                      i.id === c.id
                                        ? { ...i, params: { ...i.params, anchorTime } }
                                        : i,
                                    ),
                                  });
                              }}
                            />
                          </label>
                          <button
                            aria-label="Pick VWAP anchor"
                            onClick={() => {
                              runtime.current?.interaction.cancel();
                              setTool(null);
                              setAnchorTarget(c.id);
                              setPanel(null);
                            }}
                          >
                            Pick candle ↗
                          </button>
                        </div>
                      )}
                      {Object.entries(c.params)
                        .filter(([key]) => key !== 'anchorTime')
                        .map(([key, value]) => (
                          <label key={key}>
                            {parameterNames[key] ?? key}
                            <input
                              aria-label={`${c.type} ${key}`}
                              type="number"
                              value={value}
                              min={defaultRegistry.get(c.type).parameters[key]?.min ?? 1}
                              max={defaultRegistry.get(c.type).parameters[key]?.max ?? 500}
                              step={
                                defaultRegistry.get(c.type).parameters[key]?.integer ? 1 : 'any'
                              }
                              onChange={(e) => {
                                const value = Number(e.target.value);
                                try {
                                  const changed = defaultRegistry.normalize({
                                    ...c,
                                    params: { ...c.params, [key]: value },
                                  });
                                  patch({
                                    indicators: workspace.indicators.map((i) =>
                                      i.id === c.id ? changed : i,
                                    ),
                                  });
                                } catch (error) {
                                  setNotice(String(error));
                                }
                              }}
                            />
                          </label>
                        ))}
                      {c.type !== 'VolumeProfile' &&
                        defaultRegistry.get(c.type).outputs.length > 0 && (
                          <select
                            aria-label={`${c.type} pane`}
                            value={c.pane}
                            onChange={(e) =>
                              patch({
                                indicators: workspace.indicators.map((i) =>
                                  i.id === c.id
                                    ? { ...i, pane: e.target.value as 'price' | 'separate' }
                                    : i,
                                ),
                              })
                            }
                          >
                            <option value="price">On price</option>
                            <option value="separate">Own pane</option>
                          </select>
                        )}
                      <button
                        aria-label={`Delete ${c.type}`}
                        onClick={() =>
                          patch({ indicators: workspace.indicators.filter((i) => i.id !== c.id) })
                        }
                      >
                        <X size={15} />
                      </button>
                      {indicatorStatuses[c.id] && (
                        <p className="indicator-status" role="status">
                          {indicatorStatuses[c.id].message}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
                <p className="fineprint">
                  Structure: MSS = initial break, BOS = continuation, CHoCH = reversal. Dashed
                  levels reference a swing; labels mark the confirmation candle. FVG zones show
                  three-candle gaps and fade when filled. These are price patterns. Volume Profile
                  estimates volume by price from OHLCV.
                </p>
              </>
            )}
            {panel === 'settings' && (
              <>
                <div className="connection-card">
                  <span className="connection-badge">
                    <Radio size={18} />
                  </span>
                  <div>
                    <strong>Coinbase Exchange</strong>
                    <p>Public crypto history and live trades. No API key.</p>
                  </div>
                  <span className="connected-label">Available</span>
                </div>
                <div className="connection-card">
                  <span className="connection-badge">
                    <BarChart3 size={18} />
                  </span>
                  <div>
                    <strong>Alpaca stocks & ETFs</strong>
                    <p>Connect your local data gateway. Free IEX coverage.</p>
                  </div>
                </div>
                <label className="field">
                  Gateway URL
                  <input
                    value={gatewayUrl}
                    onChange={(e) => setGatewayUrl(e.target.value)}
                    placeholder="http://127.0.0.1:8787"
                  />
                </label>
                <label className="field">
                  Gateway access token <small>only if configured · held in memory</small>
                  <input
                    type="password"
                    autoComplete="off"
                    value={gatewayToken}
                    onChange={(e) => setGatewayToken(e.target.value)}
                  />
                </label>
                <button className="primary" onClick={connectStocks}>
                  Connect stock feed
                  <ArrowUpRight size={16} />
                </button>
                <p className="fineprint">
                  Set ALPACA_API_KEY and ALPACA_API_SECRET on the gateway. Brokerage credentials
                  never enter this app. See docs/deployment.md for setup.
                </p>
                <hr />
                <label className="field">
                  Workspace name
                  <input value={workspace.name} onChange={(e) => patch({ name: e.target.value })} />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!workspace.leftScale}
                    onChange={(e) => patch({ leftScale: e.target.checked })}
                  />
                  Show a second price scale for the first overlay indicator
                </label>
              </>
            )}
            {panel === 'help' && (
              <>
                <p className="modal-intro">A personal market workspace, saved in this browser.</p>
                <dl className="help-list">
                  <dt>Navigate</dt>
                  <dd>Drag to pan. Scroll or pinch to zoom. Drag the price axis to scale.</dd>
                  <dt>Draw</dt>
                  <dd>
                    Select a tool, then drag across a pane. Select a drawing to edit its anchors,
                    color, or width.
                  </dd>
                  <dt>Undo / redo</dt>
                  <dd>⌘/Ctrl Z · ⌘/Ctrl Shift Z</dd>
                  <dt>Cancel / delete</dt>
                  <dd>Escape · Delete or Backspace</dd>
                  <dt>History</dt>
                  <dd>Scroll left to load older bars. Latest returns to live candles.</dd>
                  <dt>Save</dt>
                  <dd>
                    Changes save locally. Export JSON to move your workspace between browsers or
                    hosts.
                  </dd>
                </dl>
                <p className="fineprint">
                  Each source has its own coverage and market-data terms. No order execution is
                  connected.
                </p>
              </>
            )}
          </section>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button aria-label="Dismiss notification" onClick={() => setNotice('')}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

repository
  .load()
  .then((saved) => {
    createRoot(document.getElementById('root')!).render(
      <App
        initial={
          developerMode
            ? saved?.instrument.provider === 'simulated'
              ? saved
              : defaultWorkspace
            : saved?.instrument.provider === 'simulated'
              ? defaultWorkspace
              : (saved ?? defaultWorkspace)
        }
      />,
    );
  })
  .catch(() =>
    createRoot(document.getElementById('root')!).render(<App initial={defaultWorkspace} />),
  );
