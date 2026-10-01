import {
  type CoordinateAdapter,
  type Drawing,
  type DrawingFilter,
  type DrawingGeometry,
  type DrawingHit,
  type Point,
  type Segment,
  DEFAULT_FIBONACCI_LEVELS,
  matchesScope,
} from './types';

export function distanceToSegment(point: Point, segment: Segment): number {
  const dx = segment.to.x - segment.from.x,
    dy = segment.to.y - segment.from.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point.x - segment.from.x) * dx + (point.y - segment.from.y) * dy) / lengthSq,
          ),
        );
  return Math.hypot(point.x - segment.from.x - t * dx, point.y - segment.from.y - t * dy);
}

/** Liang-Barsky clipping also handles vertical and horizontal rays without dividing by zero. */
export function clipLine(
  from: Point,
  to: Point,
  width: number,
  height: number,
  ray = false,
): Segment | null {
  const dx = to.x - from.x,
    dy = to.y - from.y;
  let enter = 0,
    leave = ray ? Infinity : 1;
  if (dx === 0 && dy === 0)
    return from.x >= 0 && from.x <= width && from.y >= 0 && from.y <= height
      ? { from, to: from }
      : null;
  for (const [p, q] of [
    [-dx, from.x],
    [dx, width - from.x],
    [-dy, from.y],
    [dy, height - from.y],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const ratio = q / p;
    if (p < 0) enter = Math.max(enter, ratio);
    else leave = Math.min(leave, ratio);
    if (enter > leave) return null;
  }
  return {
    from: { x: from.x + enter * dx, y: from.y + enter * dy },
    to: { x: from.x + leave * dx, y: from.y + leave * dy },
  };
}

const numberLabel = (value: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value);
function durationLabel(ms: number): string {
  const seconds = Math.abs(ms) / 1000;
  return seconds >= 86400
    ? `${numberLabel(seconds / 86400)} days`
    : seconds >= 3600
      ? `${numberLabel(seconds / 3600)} hours`
      : `${numberLabel(seconds / 60)} min`;
}

export function buildDrawingGeometry(
  drawing: Drawing,
  adapter: CoordinateAdapter,
): DrawingGeometry {
  const geometry: DrawingGeometry = { segments: [], fills: [], labels: [], handles: [] };
  if (!drawing.visible || !drawing.anchors.length || adapter.width <= 0 || adapter.height <= 0)
    return geometry;
  const { width, height } = adapter;
  const points = drawing.anchors.map((a) => ({
    x: adapter.timeToX(a.time),
    y: adapter.priceToY(a.value),
  }));
  const add = (a: Point, b: Point, ray = false) => {
    const segment = clipLine(a, b, width, height, ray);
    if (segment) geometry.segments.push(segment);
  };
  if (drawing.type === 'horizontal-line') {
    const y = points[0].y;
    if (y === null || !Number.isFinite(y)) return geometry;
    add({ x: 0, y }, { x: width, y });
    geometry.handles.push({ x: Math.max(8, Math.min(width - 8, points[0].x ?? width / 2)), y });
    geometry.labels.push({
      point: { x: 8, y: y - 7 },
      text: numberLabel(drawing.anchors[0].value),
    });
    return geometry;
  }
  if (drawing.type === 'vertical-line') {
    const x = points[0].x;
    if (x === null || !Number.isFinite(x)) return geometry;
    add({ x, y: 0 }, { x, y: height });
    geometry.handles.push({ x, y: Math.max(8, Math.min(height - 8, points[0].y ?? height / 2)) });
    return geometry;
  }
  if (drawing.type === 'date-range') {
    if (points.length < 2 || points.some((p) => p.x === null || !Number.isFinite(p.x)))
      return geometry;
    const x1 = points[0].x!,
      x2 = points[1].x!;
    add({ x: x1, y: 0 }, { x: x1, y: height });
    add({ x: x2, y: 0 }, { x: x2, y: height });
    geometry.fills.push([
      { x: x1, y: 0 },
      { x: x2, y: 0 },
      { x: x2, y: height },
      { x: x1, y: height },
    ]);
    geometry.handles = [
      { x: x1, y: height / 2 },
      { x: x2, y: height / 2 },
    ];
    geometry.labels.push({
      point: { x: Math.min(x1, x2) + 6, y: 18 },
      text: durationLabel(drawing.anchors[1].time - drawing.anchors[0].time),
    });
    return geometry;
  }
  if (
    points.length < 2 ||
    points.some(
      (p) => p.x === null || p.y === null || !Number.isFinite(p.x) || !Number.isFinite(p.y),
    )
  )
    return geometry;
  const [a, b, c] = points as Point[];
  geometry.handles = points as Point[];
  switch (drawing.type) {
    case 'trend-line':
      add(a, b);
      break;
    case 'ray':
      add(a, b, true);
      break;
    case 'rectangle':
    case 'price-range': {
      const corners = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
      geometry.fills.push(corners);
      corners.forEach((p, i) => add(p, corners[(i + 1) % 4]));
      if (drawing.type === 'price-range') {
        const difference = drawing.anchors[1].value - drawing.anchors[0].value;
        const percent =
          drawing.anchors[0].value === 0
            ? 'n/a'
            : `${numberLabel((difference / Math.abs(drawing.anchors[0].value)) * 100)}%`;
        geometry.labels.push({
          point: { x: Math.min(a.x, b.x) + 6, y: Math.min(a.y, b.y) - 7 },
          text: `${difference >= 0 ? '+' : ''}${numberLabel(difference)} (${percent})`,
        });
      }
      break;
    }
    case 'fibonacci': {
      add(a, b);
      for (const level of drawing.levels ?? DEFAULT_FIBONACCI_LEVELS) {
        const value =
          drawing.anchors[0].value + level * (drawing.anchors[1].value - drawing.anchors[0].value);
        const y = adapter.priceToY(value);
        if (y === null || !Number.isFinite(y)) continue;
        add({ x: a.x, y }, { x: b.x, y });
        geometry.labels.push({
          point: { x: Math.min(a.x, b.x) + 5, y: y - 5 },
          text: `${numberLabel(level)} · ${numberLabel(value)}`,
        });
      }
      break;
    }
    case 'parallel-channel': {
      if (!c) break;
      // A perpendicular offset avoids the infinite-slope failure of vertical channels.
      const dx = b.x - a.x,
        dy = b.y - a.y,
        lengthSq = dx * dx + dy * dy;
      if (!lengthSq) {
        add(a, b);
        break;
      }
      const projection = ((c.x - a.x) * dx + (c.y - a.y) * dy) / lengthSq;
      const ox = c.x - a.x - projection * dx,
        oy = c.y - a.y - projection * dy;
      const a2 = { x: a.x + ox, y: a.y + oy },
        b2 = { x: b.x + ox, y: b.y + oy };
      add(a, b);
      add(a2, b2);
      geometry.fills.push([a, b, b2, a2]);
      break;
    }
  }
  return geometry;
}

function insidePolygon(point: Point, vertices: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i],
      b = vertices[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

export function hitTestDrawings(
  drawings: readonly Drawing[],
  point: Point,
  adapter: CoordinateAdapter,
  options: DrawingFilter & { tolerance?: number; selectedId?: string | null } = {},
): DrawingHit | null {
  if (point.x < 0 || point.y < 0 || point.x > adapter.width || point.y > adapter.height)
    return null;
  const tolerance = options.tolerance ?? 6;
  const candidates = drawings
    .filter((d) => d.visible && matchesScope(d, options))
    .map((d) => ({ drawing: d, geometry: buildDrawingGeometry(d, adapter) }))
    .reverse();
  // Only selected objects display handles. Handle targets always outrank object bodies.
  const selected = candidates.find((c) => c.drawing.id === options.selectedId);
  if (selected && !selected.drawing.locked)
    for (let i = 0; i < selected.geometry.handles.length; i++) {
      const p = selected.geometry.handles[i],
        distance = Math.hypot(point.x - p.x, point.y - p.y);
      if (distance <= tolerance + 2) return { id: selected.drawing.id, handleIndex: i, distance };
    }
  for (const { drawing, geometry } of candidates) {
    const distance = Math.min(...geometry.segments.map((s) => distanceToSegment(point, s)));
    if (
      distance <= tolerance + drawing.style.lineWidth / 2 ||
      geometry.fills.some((p) => insidePolygon(point, p))
    )
      return { id: drawing.id, distance: Number.isFinite(distance) ? distance : 0 };
  }
  return null;
}
