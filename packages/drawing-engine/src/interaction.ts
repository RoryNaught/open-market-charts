import { buildDrawingGeometry, hitTestDrawings } from './geometry';
import { DrawingStore } from './store';
import {
  anchorCount,
  createDrawing,
  matchesScope,
  type Anchor,
  type CoordinateAdapter,
  type Drawing,
  type DrawingScope,
  type DrawingStyle,
  type DrawingTool,
  type Point,
} from './types';

interface Gesture {
  original: Drawing;
  start: Point;
  handleIndex?: number;
  creating: boolean;
  moved: boolean;
  stage?: 'base' | 'channel-width';
}

/** DOM-free pointer controller. The caller owns pointer capture and chart gesture arbitration. */
export class DrawingInteraction {
  private tool: DrawingTool | null = null;
  private gesture: Gesture | null = null;
  private draft: Drawing | null = null;
  private waitingForChannel = false;
  private defaultStyle: Partial<DrawingStyle> = {};
  constructor(
    private readonly store: DrawingStore,
    private readonly getAdapter: () => CoordinateAdapter,
    private readonly getScope: () => DrawingScope,
    private readonly onInvalidate: () => void = () => {},
  ) {}
  get activeTool(): DrawingTool | null {
    return this.tool;
  }
  get active(): boolean {
    return this.gesture !== null || this.waitingForChannel;
  }
  get preview(): Drawing | null {
    return this.draft ? structuredClone(this.draft) : null;
  }
  setStyle(style: Partial<DrawingStyle>): void {
    this.defaultStyle = { ...this.defaultStyle, ...style };
  }
  setTool(tool: DrawingTool | null): void {
    this.cancel();
    this.tool = tool;
    this.onInvalidate();
  }
  getRenderDrawings(): Drawing[] {
    const drawings = this.store.getAll();
    if (!this.draft) return drawings;
    const index = drawings.findIndex((d) => d.id === this.draft!.id);
    if (index < 0) drawings.push(structuredClone(this.draft));
    else drawings[index] = structuredClone(this.draft);
    return drawings;
  }
  private anchor(point: Point, adapter = this.getAdapter()): Anchor | null {
    const time = adapter.xToTime(point.x),
      value = adapter.yToPrice(point.y);
    return time !== null && value !== null && Number.isFinite(time) && Number.isFinite(value)
      ? { time, value }
      : null;
  }
  pointerDown(point: Point, tolerance = 6): boolean {
    const adapter = this.getAdapter();
    if (point.x < 0 || point.y < 0 || point.x > adapter.width || point.y > adapter.height)
      return false;
    if (this.waitingForChannel && this.draft) {
      this.pointerMove(point);
      this.waitingForChannel = false;
      this.gesture = {
        original: structuredClone(this.draft),
        start: point,
        creating: true,
        moved: true,
        stage: 'channel-width',
      };
      return true;
    }
    if (this.tool) {
      const anchor = this.anchor(point, adapter);
      if (!anchor) return false;
      this.draft = createDrawing(
        this.tool,
        Array.from({ length: anchorCount(this.tool) }, () => ({ ...anchor })),
        this.getScope(),
        this.defaultStyle,
      );
      this.gesture = {
        original: structuredClone(this.draft),
        start: point,
        creating: true,
        moved: false,
        stage: 'base',
      };
      this.onInvalidate();
      return true;
    }
    const hit = hitTestDrawings(this.store.getAll(), point, adapter, {
      ...this.getScope(),
      selectedId: this.store.selectedId,
      tolerance,
    });
    if (!hit) {
      this.store.select(null);
      return false;
    }
    this.store.select(hit.id);
    const original = this.store.get(hit.id)!;
    if (original.locked) return true;
    this.gesture = {
      original,
      start: point,
      creating: false,
      moved: false,
      handleIndex: hit.handleIndex,
    };
    this.draft = structuredClone(original);
    this.onInvalidate();
    return true;
  }
  pointerMove(point: Point): boolean {
    if (!this.draft) return false;
    if (!matchesScope(this.draft, this.getScope())) {
      this.cancel();
      return false;
    }
    const adapter = this.getAdapter();
    if (this.waitingForChannel) {
      const anchor = this.anchor(point, adapter);
      if (anchor) {
        this.draft.anchors[2] = anchor;
        this.onInvalidate();
      }
      return true;
    }
    const gesture = this.gesture;
    if (!gesture) return false;
    const dx = point.x - gesture.start.x,
      dy = point.y - gesture.start.y;
    gesture.moved ||= Math.hypot(dx, dy) >= 3;
    if (gesture.creating) {
      const anchor = this.anchor(point, adapter);
      if (!anchor) return true;
      if (gesture.stage === 'channel-width') this.draft.anchors[2] = anchor;
      else this.draft.anchors[this.draft.anchors.length === 1 ? 0 : 1] = anchor;
    } else {
      const original = gesture.original;
      const moveAnchor = (anchor: Anchor, index: number): Anchor => {
        if (gesture.handleIndex !== undefined && index !== gesture.handleIndex)
          return { ...anchor };
        const geometry = buildDrawingGeometry(original, adapter);
        const projected = { x: adapter.timeToX(anchor.time), y: adapter.priceToY(anchor.value) };
        const visual = geometry.handles[index];
        const position =
          gesture.handleIndex !== undefined
            ? { x: point.x, y: point.y }
            : {
                x: (projected.x ?? visual?.x ?? gesture.start.x) + dx,
                y: (projected.y ?? visual?.y ?? gesture.start.y) + dy,
              };
        const next = this.anchor(position, adapter);
        if (!next) return { ...anchor };
        if (original.type === 'horizontal-line') next.time = anchor.time;
        if (original.type === 'vertical-line' || original.type === 'date-range')
          next.value = anchor.value;
        return next;
      };
      this.draft.anchors = original.anchors.map(moveAnchor);
    }
    this.onInvalidate();
    return true;
  }
  pointerUp(point?: Point): boolean {
    if (!this.gesture || !this.draft) return false;
    if (point) this.pointerMove(point);
    const gesture = this.gesture;
    if (
      gesture.creating &&
      this.draft.type === 'parallel-channel' &&
      gesture.stage === 'base' &&
      gesture.moved
    ) {
      this.waitingForChannel = true;
      this.gesture = null;
      this.onInvalidate();
      return true;
    }
    if (gesture.creating && (gesture.moved || anchorCount(this.draft.type) === 1)) {
      this.store.add(this.draft);
      this.tool = null;
    } else if (!gesture.creating && gesture.moved && matchesScope(this.draft, this.getScope())) {
      this.store.update(this.draft.id, { anchors: this.draft.anchors });
    }
    this.gesture = null;
    this.draft = null;
    this.waitingForChannel = false;
    this.onInvalidate();
    return true;
  }
  cancel(): void {
    this.gesture = null;
    this.draft = null;
    this.waitingForChannel = false;
    this.onInvalidate();
  }
}
