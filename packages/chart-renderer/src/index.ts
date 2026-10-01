import {
  createChart,
  CandlestickSeries,
  BarSeries,
  LineSeries,
  AreaSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type UTCTimestamp,
  type Logical,
  type ISeriesPrimitive,
  type IPrimitivePaneView,
  type SeriesAttachedParameter,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { Bar, Timeframe, Instrument, SessionInterval, SessionMode } from '@omc/provider-sdk';
import { timeframeMs } from '@omc/provider-sdk';
import {
  heikinAshi,
  heikinAshiBar,
  timeToLogical,
  logicalToTime,
  futureSessionTimes,
  type ChartType,
  type ScaleMode,
} from '@omc/chart-core';
import type {
  IndicatorConfig,
  IndicatorResult,
  IndicatorPoint,
  IndicatorAnnotation,
} from '@omc/indicator-engine';
import { paintDrawings, type Drawing, type CoordinateAdapter } from '@omc/drawing-engine';
import { IndicatorWindowCache, priceWindow } from './indicator-window';
import { annotationGeometry, paintAnnotations } from './annotations';

const up = '#39c6a4',
  down = '#ed7183',
  grid = '#1c2635';
const ts = (time: number) => (time / 1000) as UTCTimestamp;
type Series = ISeriesApi<SeriesType>;
export interface RendererOptions {
  onNeedHistory(): void;
  onCrosshair(bar: Bar | undefined): void;
  onVisibleRange?(from: number, to: number): void;
  onPaneResize?(): void;
}
/** Public series primitive; its model and paint functions have no chart-library dependency. */
class OverlayPrimitive implements ISeriesPrimitive {
  private request?: () => void;
  private views: IPrimitivePaneView[];
  constructor(draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void) {
    this.views = [
      {
        zOrder: () => 'top',
        renderer: () => ({
          draw(target: CanvasRenderingTarget2D) {
            target.useMediaCoordinateSpace((scope) =>
              draw(scope.context, scope.mediaSize.width, scope.mediaSize.height),
            );
          },
        }),
      },
    ];
  }
  attached({ requestUpdate }: SeriesAttachedParameter) {
    this.request = requestUpdate;
  }
  detached() {
    this.request = undefined;
  }
  paneViews() {
    return this.views;
  }
  refresh() {
    this.request?.();
  }
}

export class ChartRenderer {
  readonly chart: IChartApi;
  private main!: Series;
  private volume!: ISeriesApi<'Histogram'>;
  private timeline!: ISeriesApi<'Line'>;
  private indicatorSeries = new Map<string, Series>();
  private indicatorData = new Map<
    string,
    {
      cache: IndicatorWindowCache;
      kind: 'line' | 'histogram';
      gaps?: boolean;
      color: string;
      paneId: string;
    }
  >();
  private indicatorAnnotations = new Map<string, IndicatorAnnotation[]>();
  private indicatorWindow?: { from: number; to: number; timeFrom: number; timeTo: number };
  private refreshingIndicatorWindow = false;
  private panes = new Map<string, { series: Series; primitive: OverlayPrimitive }>();
  private bars: readonly Bar[] = [];
  private times: number[] = [];
  private projectedTimes: number[] = [];
  private sessions: SessionInterval[] = [];
  private sessionMode: SessionMode = 'regular';
  private ha: Bar[] = [];
  private type: ChartType = 'candles';
  private timeframe: Timeframe = '5m';
  private instrument?: Instrument;
  private configs: IndicatorConfig[] = [];
  private drawings: Drawing[] = [];
  private selectedId?: string;
  private profile?: IndicatorResult['profile'];
  private resize: ResizeObserver;
  private disposed = false;
  constructor(
    readonly element: HTMLElement,
    private callbacks: RendererOptions,
  ) {
    this.chart = createChart(element, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#101721' },
        textColor: '#8090a5',
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
        fontSize: 11,
        attributionLogo: true,
        panes: { separatorColor: '#263244', separatorHoverColor: '#4b6381', enableResize: true },
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#566579', labelBackgroundColor: '#344156' },
        horzLine: { color: '#566579', labelBackgroundColor: '#344156' },
      },
      rightPriceScale: {
        borderColor: grid,
        scaleMargins: { top: 0.12, bottom: 0.08 },
        minimumWidth: 80,
      },
      leftPriceScale: { visible: false, borderColor: grid },
      timeScale: {
        borderColor: grid,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        barSpacing: 7,
        minBarSpacing: 0.01,
        enableConflation: true,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      localization: {
        timeFormatter: (time: unknown) =>
          new Date(Number(time) * 1000).toLocaleString('en-US', {
            timeZone: this.instrument?.timezone ?? 'UTC',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
      },
    });
    this.createMain();
    // Whitespace keeps every canonical timestamp on the axis while price series render a window.
    // One hidden value at the right edge supplies a stable real-time base index.
    this.timeline = this.chart.addSeries(
      LineSeries,
      { visible: false, priceLineVisible: false, lastValueVisible: false },
      0,
    );
    this.volume = this.chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });
    this.attachOverlay('volume', this.volume);
    this.chart.panes()[0].setStretchFactor(5);
    this.chart.panes()[1].setStretchFactor(1);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range || !this.bars.length) return;
      this.refreshViewportWindow();
      if (range.from < 70) this.callbacks.onNeedHistory();
      const from = this.bars[Math.max(0, Math.floor(range.from))]?.time;
      const to = this.bars[Math.min(this.bars.length - 1, Math.ceil(range.to))]?.time;
      if (from !== undefined && to !== undefined) this.callbacks.onVisibleRange?.(from, to);
    });
    this.chart.subscribeCrosshairMove((param) => {
      const time = Number(param.time) * 1000;
      const i = timeToLogical(this.times, time, timeframeMs[this.timeframe]);
      this.callbacks.onCrosshair(i === null || !Number.isInteger(i) ? undefined : this.bars[i]);
    });
    this.resize = new ResizeObserver(() => {
      this.refreshOverlays();
      this.callbacks.onPaneResize?.();
    });
    this.resize.observe(element);
  }
  private createMain() {
    const options = { priceLineVisible: true, lastValueVisible: true, priceScaleId: 'right' };
    if (this.type === 'line')
      this.main = this.chart.addSeries(
        LineSeries,
        { ...options, color: '#75a7ff', lineWidth: 2 },
        0,
      );
    else if (this.type === 'area')
      this.main = this.chart.addSeries(
        AreaSeries,
        {
          ...options,
          lineColor: '#75a7ff',
          topColor: '#588dcd55',
          bottomColor: '#588dcd00',
          lineWidth: 2,
        },
        0,
      );
    else if (this.type === 'bars')
      this.main = this.chart.addSeries(BarSeries, { ...options, upColor: up, downColor: down }, 0);
    else
      this.main = this.chart.addSeries(
        CandlestickSeries,
        {
          ...options,
          upColor: up,
          downColor: down,
          wickUpColor: up,
          wickDownColor: down,
          borderVisible: false,
        },
        0,
      );
    this.attachOverlay('price', this.main);
  }
  private attachOverlay(paneId: string, series: Series) {
    const primitive = new OverlayPrimitive((ctx, width, height) =>
      this.paint(ctx, width, height, paneId),
    );
    series.attachPrimitive(primitive);
    this.panes.set(paneId, { series, primitive });
  }
  configure(instrument: Instrument, timeframe: Timeframe, type: ChartType, scale: ScaleMode) {
    this.instrument = instrument;
    this.timeframe = timeframe;
    if (this.type !== type) {
      this.type = type;
      this.chart.panes()[0].setPreserveEmptyPane(true);
      this.chart.removeSeries(this.main);
      this.createMain();
      this.setBars(this.bars, 'reset', this.bars, false);
    }
    this.main.applyOptions({
      priceFormat: {
        type: 'price',
        precision: instrument.pricePrecision,
        minMove: 10 ** -instrument.pricePrecision,
      },
    });
    this.setScale(scale);
  }
  setScale(mode: ScaleMode) {
    this.main.priceScale().applyOptions({
      mode:
        mode === 'log'
          ? PriceScaleMode.Logarithmic
          : mode === 'percentage'
            ? PriceScaleMode.Percentage
            : PriceScaleMode.Normal,
      autoScale: true,
    });
  }
  setBars(
    bars: readonly Bar[],
    change: 'reset' | 'prepend' | 'update',
    changed: readonly Bar[],
    fit = true,
  ) {
    const oldCount = this.times.length,
      oldFirst = this.bars[0]?.time;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    this.bars = bars;
    if (!bars.length) {
      this.indicatorData.clear();
      this.indicatorAnnotations.clear();
      this.profile = undefined;
    }
    const toPoint = (b: Bar) =>
      this.type === 'line' || this.type === 'area'
        ? { time: ts(b.time), value: b.close }
        : { ...b, time: ts(b.time) };
    const vol = (b: Bar) => ({
      time: ts(b.time),
      value: b.volume,
      color: b.close >= b.open ? '#39c6a47a' : '#ed71837a',
    });
    if (change === 'update' && oldCount) {
      for (const b of changed) {
        let display = b;
        if (this.type === 'heikin-ashi') {
          const replace = this.ha.at(-1)?.time === b.time;
          display = heikinAshiBar(b, this.ha[this.ha.length - (replace ? 2 : 1)]);
          if (replace) this.ha[this.ha.length - 1] = display;
          else this.ha.push(display);
        }
        if (this.times.at(-1)! < b.time) {
          this.times.push(b.time);
          this.timeline.update({ time: ts(b.time), value: b.close });
        }
        const window = this.indicatorWindow;
        this.main.update(toPoint(display));
        if (window && b.time >= window.timeFrom && b.time <= window.timeTo) {
          this.volume.update(vol(b));
        }
      }
    } else {
      this.times = bars.map((b) => b.time);
      this.ha = this.type === 'heikin-ashi' ? heikinAshi(bars) : [];
      this.indicatorWindow = undefined;
      // Clear old priced rows before replacing a symbol/timeframe's canonical time axis.
      this.refreshingIndicatorWindow = true;
      this.main.setData([]);
      this.volume.setData([]);
      for (const series of this.indicatorSeries.values()) series.setData([]);
      this.timeline.setData(
        bars.map((bar, index) =>
          index === bars.length - 1
            ? { time: ts(bar.time), value: bar.close }
            : { time: ts(bar.time) },
        ),
      );
      this.refreshingIndicatorWindow = false;
      if (change === 'prepend' && range && oldFirst !== undefined) {
        const offset = timeToLogical(this.times, oldFirst, timeframeMs[this.timeframe]) ?? 0;
        this.chart
          .timeScale()
          .setVisibleLogicalRange({ from: range.from + offset, to: range.to + offset });
      } else if (fit && !oldCount && bars.length)
        this.chart
          .timeScale()
          .setVisibleLogicalRange({ from: Math.max(0, bars.length - 140), to: bars.length + 7 });
    }
    if (change !== 'update' || this.projectedTimes[oldCount - 1] !== this.times.at(-1))
      this.projectTimes();
    this.refreshViewportWindow(change !== 'update');
    this.refreshOverlays();
  }
  setIndicators(configs: IndicatorConfig[]) {
    // Rebuild only when structure/options change, never on a market tick.
    for (const series of this.indicatorSeries.values()) this.chart.removeSeries(series);
    this.indicatorSeries.clear();
    this.indicatorData.clear();
    this.indicatorAnnotations.clear();
    this.indicatorWindow = undefined;
    for (const key of [...this.panes.keys()])
      if (key !== 'price' && key !== 'volume') this.panes.delete(key);
    this.configs = configs;
    this.profile = undefined;
  }
  renderIndicators(results: IndicatorResult[], mode: 'reset' | 'update') {
    for (const result of results) {
      const config = this.configs.find((c) => c.id === result.id);
      if (!config) continue;
      if (result.annotations) this.indicatorAnnotations.set(result.id, result.annotations);
      if (result.profile) {
        this.profile = result.profile;
        continue;
      }
      let pane = this.panes.get(config.id)?.series.getPane().paneIndex();
      if (config.pane === 'price') pane = 0;
      for (const output of result.outputs) {
        const key = `${result.id}:${output.key}`;
        let series = this.indicatorSeries.get(key);
        if (!series) {
          const newPane = pane ?? this.chart.panes().length;
          const priceScaleId = config.pane === 'price' ? 'right' : 'right';
          const opts = {
            color: output.color ?? config.color,
            priceLineVisible: false,
            lastValueVisible: false,
            title:
              config.pane === 'separate'
                ? result.type === 'SqueezeMomentum'
                  ? output.key === 'squeeze'
                    ? 'Compression'
                    : 'Momentum'
                  : `${result.type} ${output.key}`
                : '',
            priceScaleId,
          };
          series =
            output.kind === 'histogram'
              ? this.chart.addSeries(HistogramSeries, opts, newPane)
              : this.chart.addSeries(
                  LineSeries,
                  {
                    ...opts,
                    lineWidth: 1,
                    lineVisible: !output.gaps && output.key !== 'squeeze',
                    pointMarkersVisible: output.key === 'squeeze',
                    pointMarkersRadius: 2,
                  },
                  newPane,
                );
          this.indicatorSeries.set(key, series);
          pane = newPane;
          if (config.pane === 'separate' && !this.panes.has(config.id)) {
            this.attachOverlay(config.id, series);
            this.chart.panes()[pane].setStretchFactor(1.4);
          }
        }
        let data = this.indicatorData.get(key);
        if (!data) {
          data = {
            cache: new IndicatorWindowCache(),
            kind: output.kind,
            gaps: output.gaps,
            color: output.color ?? config.color,
            paneId: config.pane === 'price' ? 'price' : config.id,
          };
          this.indicatorData.set(key, data);
        }
        if (mode === 'reset') data.cache.reset(output.values);
        else {
          data.cache.upsert(output.values);
          const window = this.indicatorWindow;
          if (window)
            for (const point of output.values) {
              if (point.time >= window.timeFrom && point.time <= window.timeTo)
                series.update(this.indicatorPoint(point, output.kind));
            }
        }
      }
    }
    this.refreshViewportWindow(mode === 'reset');
    this.refreshOverlays();
  }
  private indicatorPoint(point: IndicatorPoint, kind: 'line' | 'histogram') {
    if (!Number.isFinite(point.value)) return { time: ts(point.time) };
    return {
      time: ts(point.time),
      value: point.value,
      ...(point.color
        ? { color: point.color }
        : kind === 'histogram'
          ? { color: point.value >= 0 ? '#39c6a4aa' : '#ed7183aa' }
          : {}),
    };
  }
  /** LWC invalidates raw series points on update; bounded windows avoid O(history) market ticks. */
  private refreshViewportWindow(force = false) {
    if (this.refreshingIndicatorWindow || !this.times.length) return;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    if (!range) return;
    const overscan = 1000;
    const previous = this.indicatorWindow;
    if (
      !force &&
      previous &&
      Math.abs(range.from - previous.from) < overscan / 2 &&
      Math.abs(range.to - previous.to) < overscan / 2
    )
      return;
    const fromIndex = Math.max(0, Math.floor(range.from) - overscan);
    const toIndex = Math.min(this.times.length - 1, Math.ceil(range.to) + overscan);
    const timeFrom = this.times[fromIndex] ?? this.times[0];
    const timeTo = toIndex === this.times.length - 1 ? Infinity : this.times[toIndex];
    this.indicatorWindow = { from: range.from, to: range.to, timeFrom, timeTo };
    this.refreshingIndicatorWindow = true;
    try {
      const displayBars = this.type === 'heikin-ashi' ? this.ha : this.bars;
      this.main.setData(
        priceWindow(displayBars, fromIndex, toIndex).map((bar) =>
          this.type === 'line' || this.type === 'area'
            ? { time: ts(bar.time), value: bar.close }
            : { ...bar, time: ts(bar.time) },
        ),
      );
      this.volume.setData(
        this.bars.slice(fromIndex, toIndex + 1).map((bar) => ({
          time: ts(bar.time),
          value: bar.volume,
          color: bar.close >= bar.open ? '#39c6a47a' : '#ed71837a',
        })),
      );
      for (const [key, data] of this.indicatorData)
        this.indicatorSeries
          .get(key)
          ?.setData(
            data.cache
              .slice(timeFrom, timeTo)
              .map((point) => this.indicatorPoint(point, data.kind)),
          );
    } finally {
      this.refreshingIndicatorWindow = false;
    }
  }
  setDrawings(drawings: readonly Drawing[], selectedId?: string) {
    this.drawings = [...drawings];
    this.selectedId = selectedId;
    this.refreshOverlays();
  }
  adapter(paneId = 'price'): CoordinateAdapter {
    let series = this.panes.get(paneId)?.series ?? this.main;
    // A disconnected output can be all whitespace in this window. A sibling on the same
    // scale still supplies the shared pane's numeric coordinate transform.
    if (series.priceToCoordinate(1) === null)
      series =
        series
          .getPane()
          .getSeries()
          .find(
            (candidate) =>
              candidate.options().priceScaleId === series.options().priceScaleId &&
              candidate.priceToCoordinate(1) !== null,
          ) ?? series;
    const pane = series.getPane();
    const size = this.chart.paneSize(pane.paneIndex());
    return {
      width: size.width,
      height: size.height,
      timeToX: (time) => {
        const logical = timeToLogical(this.projectedTimes, time, timeframeMs[this.timeframe]);
        return logical === null
          ? null
          : this.chart.timeScale().logicalToCoordinate(logical as Logical);
      },
      xToTime: (x) => {
        const logical = this.chart.timeScale().coordinateToLogical(x);
        return logical === null
          ? null
          : logicalToTime(this.projectedTimes, logical, timeframeMs[this.timeframe]);
      },
      priceToY: (value) => series.priceToCoordinate(value),
      yToPrice: (y) => series.coordinateToPrice(y),
    };
  }
  locate(
    clientX: number,
    clientY: number,
    lockedPane?: string,
  ): { x: number; y: number; paneId: string } | null {
    for (const [paneId, { series }] of this.panes) {
      if (lockedPane && lockedPane !== paneId) continue;
      const el = series.getPane().getHTMLElement();
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const left = this.chart.priceScale('left', series.getPane().paneIndex()).width();
      const x = clientX - rect.left - left,
        y = clientY - rect.top;
      const size = this.chart.paneSize(series.getPane().paneIndex());
      if (lockedPane || (x >= 0 && x <= size.width && y >= 0 && y <= size.height))
        return { x, y, paneId };
    }
    return null;
  }
  private paint(ctx: CanvasRenderingContext2D, width: number, height: number, paneId: string) {
    const adapter = this.adapter(paneId);
    // LWC whitespace preserves time alignment but connects line segments across missing values.
    // Paint discontinuous outputs with the public primitive, retaining native autoscale/crosshair.
    const from = adapter.xToTime(0),
      to = adapter.xToTime(width);
    if (from !== null && to !== null)
      for (const [key, data] of this.indicatorData) {
        if (!data.gaps || data.kind !== 'line' || data.paneId !== paneId) continue;
        const series = this.indicatorSeries.get(key);
        let previous: { x: number; y: number; color: string } | undefined;
        ctx.save();
        ctx.lineWidth = 1.6;
        for (const point of data.cache.slice(from, to)) {
          const x = adapter.timeToX(point.time),
            y = Number.isFinite(point.value) ? series?.priceToCoordinate(point.value) : null;
          if (x === null || y === null || y === undefined) {
            previous = undefined;
            continue;
          }
          const color = point.color ?? data.color;
          if (previous) {
            ctx.strokeStyle = previous.color;
            ctx.beginPath();
            ctx.moveTo(previous.x, previous.y);
            ctx.lineTo(x, y);
            ctx.stroke();
          } else {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, y, 1.2, 0, Math.PI * 2);
            ctx.fill();
          }
          previous = { x, y, color };
        }
        ctx.restore();
      }
    paintAnnotations(ctx, this.annotationGeometries(paneId));
    if (this.instrument?.session === 'us-equities' && paneId === 'price') {
      ctx.save();
      for (const session of this.sessions) {
        const start = adapter.timeToX(
          this.sessionMode === 'regular' ? session.open : session.extendedOpen,
        );
        const end = adapter.timeToX(
          this.sessionMode === 'regular' ? session.close : session.extendedClose,
        );
        if (start === null || end === null || end < 0 || start > width) continue;
        ctx.strokeStyle = '#7189aa36';
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(start, 0);
        ctx.lineTo(start, height);
        ctx.stroke();
        if (this.sessionMode === 'extended') {
          const open = adapter.timeToX(session.open),
            close = adapter.timeToX(session.close);
          ctx.fillStyle = '#687ac20d';
          if (open !== null) ctx.fillRect(start, 0, open - start, height);
          if (close !== null) ctx.fillRect(close, 0, end - close, height);
        }
      }
      ctx.restore();
    }
    if (paneId === 'price' && this.profile) {
      const max = Math.max(...this.profile.bins.map((b) => b.volume), 1);
      ctx.save();
      for (const bin of this.profile.bins) {
        const y1 = adapter.priceToY(bin.high),
          y2 = adapter.priceToY(bin.low);
        if (y1 === null || y2 === null) continue;
        const w = (bin.volume / max) * Math.min(width * 0.22, 180);
        ctx.fillStyle =
          this.profile.pointOfControl !== null &&
          bin.low <= this.profile.pointOfControl &&
          bin.high >= this.profile.pointOfControl
            ? '#deb76a88'
            : '#8b87c43a';
        ctx.fillRect(width - w, Math.min(y1, y2), w, Math.max(1, Math.abs(y2 - y1) - 1));
      }
      ctx.fillStyle = '#a1aabe';
      ctx.font = '10px sans-serif';
      ctx.fillText('VOLUME PROFILE · OHLCV ESTIMATE', Math.max(8, width - 238), height - 12);
      ctx.restore();
    }
    paintDrawings(
      ctx,
      this.drawings.filter((d) => d.symbolId === this.instrument?.id),
      adapter,
      { selectedId: this.selectedId, paneId },
    );
  }
  refreshOverlays() {
    if (!this.disposed) for (const { primitive } of this.panes.values()) primitive.refresh();
  }
  getIndicatorAnnotations(paneId?: string): IndicatorAnnotation[] {
    return this.configs.flatMap((config) =>
      !paneId || (config.pane === 'price' ? 'price' : config.id) === paneId
        ? (this.indicatorAnnotations.get(config.id) ?? [])
        : [],
    );
  }
  annotationAt(x: number, y: number, paneId: string): IndicatorAnnotation | undefined {
    return this.annotationGeometries(paneId)
      .reverse()
      .find((g) => {
        return (
          g &&
          x >= Math.min(g.x1, g.x2) - 6 &&
          x <= Math.max(g.x1, g.x2) + 80 &&
          y >= Math.min(g.y1, g.y2) - 18 &&
          y <= Math.max(g.y1, g.y2) + 6
        );
      })?.annotation;
  }
  private annotationGeometries(paneId: string) {
    const adapter = this.adapter(paneId);
    return this.configs.flatMap((config) => {
      if ((config.pane === 'price' ? 'price' : config.id) !== paneId) return [];
      const series = [...this.indicatorSeries].find(
        ([key, series]) => key.startsWith(config.id + ':') && series.priceToCoordinate(1) !== null,
      )?.[1];
      const coordinates = series
        ? { ...adapter, priceToY: (value: number) => series.priceToCoordinate(value) }
        : adapter;
      return (this.indicatorAnnotations.get(config.id) ?? []).flatMap((annotation) => {
        const geometry = annotationGeometry(
          annotation,
          coordinates,
          this.times.at(-1) ?? annotation.time,
        );
        return geometry ? [geometry] : [];
      });
    });
  }
  setSessions(sessions: readonly SessionInterval[], mode: SessionMode) {
    this.sessions = [...sessions];
    this.sessionMode = mode;
    this.projectTimes();
    this.refreshOverlays();
  }
  private projectTimes() {
    this.projectedTimes =
      this.sessions.length && this.times.length
        ? [
            ...this.times,
            ...futureSessionTimes(
              this.times.at(-1)!,
              this.timeframe,
              this.sessions,
              this.sessionMode,
            ),
          ]
        : this.times;
  }
  setGestures(enabled: boolean) {
    this.chart.applyOptions({ handleScroll: enabled, handleScale: enabled });
  }
  setVolume(visible: boolean) {
    this.volume.applyOptions({ visible });
    this.volume.getPane().setHeight(visible ? 100 : 30);
  }
  setLeftScale(visible: boolean) {
    // Axis visibility is chart-wide; per-pane scale options can leave sibling axis widgets absent.
    this.chart.applyOptions({ leftPriceScale: { visible } });
    const first = this.configs.find(
      (config) =>
        config.pane === 'price' &&
        [...this.indicatorSeries.keys()].some((key) => key.startsWith(config.id + ':')),
    );
    for (const [key, series] of this.indicatorSeries)
      if (series.getPane().paneIndex() === 0)
        series.applyOptions({
          priceScaleId: visible && first && key.startsWith(first.id + ':') ? 'left' : 'right',
        });
    this.refreshOverlays();
  }
  autoscale() {
    for (const pane of this.chart.panes())
      pane.priceScale('right').applyOptions({ autoScale: true });
  }
  fit() {
    this.chart.timeScale().fitContent();
  }
  latest() {
    this.chart.timeScale().scrollToRealTime();
  }
  getPaneHeights() {
    return this.chart.panes().map((p) => p.getHeight());
  }
  setPaneHeights(heights: number[]) {
    this.chart.panes().forEach((p, i) => {
      if (heights[i]) p.setHeight(heights[i]);
    });
  }
  getBarCount() {
    return this.bars.length;
  }
  dispose() {
    this.disposed = true;
    this.resize.disconnect();
    this.chart.remove();
  }
}
