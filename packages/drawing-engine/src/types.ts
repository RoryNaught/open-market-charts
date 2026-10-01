/** Canonical drawing anchors use UTC milliseconds and untransformed series values. */
export interface Anchor {
  time: number;
  value: number;
}
export interface Point {
  x: number;
  y: number;
}
export const DRAWING_TOOLS = [
  'trend-line',
  'horizontal-line',
  'vertical-line',
  'ray',
  'rectangle',
  'price-range',
  'date-range',
  'fibonacci',
  'parallel-channel',
] as const;
export type DrawingTool = (typeof DRAWING_TOOLS)[number];
export interface DrawingStyle {
  color: string;
  lineWidth: number;
  lineDash: number[];
  fillColor: string;
  fontSize: number;
}
export interface DrawingScope {
  symbolId: string;
  paneId: string;
  scaleId: string;
}
export interface Drawing extends DrawingScope {
  id: string;
  type: DrawingTool;
  anchors: Anchor[];
  style: DrawingStyle;
  visible: boolean;
  locked: boolean;
  levels?: number[];
}
/** Coordinates are pane-local CSS pixels, independent of the device pixel ratio. */
export interface CoordinateAdapter {
  width: number;
  height: number;
  timeToX(time: number): number | null;
  xToTime(x: number): number | null;
  priceToY(value: number): number | null;
  yToPrice(y: number): number | null;
}
export interface DrawingFilter {
  symbolId?: string;
  paneId?: string;
  scaleId?: string;
}
export interface Segment {
  from: Point;
  to: Point;
}
export interface GeometryLabel {
  point: Point;
  text: string;
}
export interface DrawingGeometry {
  segments: Segment[];
  fills: Point[][];
  labels: GeometryLabel[];
  handles: Point[];
}
export interface DrawingHit {
  id: string;
  handleIndex?: number;
  distance: number;
}
export const DEFAULT_DRAWING_STYLE: DrawingStyle = {
  color: '#64a5ff',
  lineWidth: 2,
  lineDash: [],
  fillColor: '#64a5ff18',
  fontSize: 11,
};
export const DEFAULT_FIBONACCI_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
export function anchorCount(type: DrawingTool): number {
  return type === 'parallel-channel'
    ? 3
    : type === 'horizontal-line' || type === 'vertical-line'
      ? 1
      : 2;
}
export function matchesScope(drawing: Drawing, filter: DrawingFilter): boolean {
  return (
    (filter.symbolId === undefined || filter.symbolId === drawing.symbolId) &&
    (filter.paneId === undefined || filter.paneId === drawing.paneId) &&
    (filter.scaleId === undefined || filter.scaleId === drawing.scaleId)
  );
}
let nextId = 0;
export function createDrawing(
  type: DrawingTool,
  anchors: Anchor[],
  scope: Partial<DrawingScope> = {},
  style: Partial<DrawingStyle> = {},
): Drawing {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `drawing-${Date.now()}-${++nextId}`,
    type,
    anchors: anchors.map((a) => ({ ...a })),
    symbolId: scope.symbolId ?? '',
    paneId: scope.paneId ?? 'price',
    scaleId: scope.scaleId ?? 'right',
    style: {
      ...DEFAULT_DRAWING_STYLE,
      ...style,
      lineDash: [...(style.lineDash ?? DEFAULT_DRAWING_STYLE.lineDash)],
    },
    visible: true,
    locked: false,
    ...(type === 'fibonacci' ? { levels: [...DEFAULT_FIBONACCI_LEVELS] } : {}),
  };
}
