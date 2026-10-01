import { buildDrawingGeometry } from './geometry';
import { matchesScope, type CoordinateAdapter, type Drawing, type DrawingFilter } from './types';

/** Paint in CSS-pixel space; the caller owns the canvas and device-pixel scaling. */
export function paintDrawings(
  context: CanvasRenderingContext2D,
  drawings: readonly Drawing[],
  adapter: CoordinateAdapter,
  options: DrawingFilter & { selectedId?: string | null; handles?: boolean } = {},
): void {
  context.save();
  context.beginPath();
  context.rect(0, 0, adapter.width, adapter.height);
  context.clip();
  for (const drawing of drawings) {
    if (!drawing.visible || !matchesScope(drawing, options)) continue;
    const geometry = buildDrawingGeometry(drawing, adapter);
    context.strokeStyle = drawing.style.color;
    context.lineWidth = drawing.style.lineWidth;
    context.setLineDash(drawing.style.lineDash);
    context.fillStyle = drawing.style.fillColor;
    for (const polygon of geometry.fills) {
      if (!polygon.length) continue;
      context.beginPath();
      context.moveTo(polygon[0].x, polygon[0].y);
      for (const point of polygon.slice(1)) context.lineTo(point.x, point.y);
      context.closePath();
      context.fill();
    }
    context.beginPath();
    for (const segment of geometry.segments) {
      context.moveTo(segment.from.x, segment.from.y);
      context.lineTo(segment.to.x, segment.to.y);
    }
    context.stroke();
    context.fillStyle = drawing.style.color;
    context.font = `${drawing.style.fontSize}px ui-monospace, SFMono-Regular, monospace`;
    context.textBaseline = 'alphabetic';
    for (const label of geometry.labels) {
      if (label.point.y < -20 || label.point.y > adapter.height + 20) continue;
      const labelWidth = context.measureText(label.text).width;
      context.fillText(
        label.text,
        Math.max(4, Math.min(adapter.width - labelWidth - 4, label.point.x)),
        Math.max(drawing.style.fontSize + 3, Math.min(adapter.height - 4, label.point.y)),
      );
    }
    if (options.handles !== false && drawing.id === options.selectedId && !drawing.locked) {
      context.setLineDash([]);
      context.lineWidth = 1.5;
      for (const handle of geometry.handles) {
        context.beginPath();
        context.arc(handle.x, handle.y, 4.5, 0, Math.PI * 2);
        context.fillStyle = '#111820';
        context.fill();
        context.stroke();
      }
    }
  }
  context.restore();
}
