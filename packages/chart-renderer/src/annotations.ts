import type { IndicatorAnnotation } from '@omc/indicator-engine';
import type { CoordinateAdapter } from '@omc/drawing-engine';

export interface AnnotationGeometry {
  annotation: IndicatorAnnotation;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  labelX: number;
}

/** Geometry uses data coordinates; zones start when known, levels reference their source swing. */
export function annotationGeometry(
  annotation: IndicatorAnnotation,
  adapter: CoordinateAdapter,
  latestTime: number,
): AnnotationGeometry | null {
  const x1 = adapter.timeToX(
    annotation.kind === 'level' ? (annotation.originTime ?? annotation.time) : annotation.time,
  );
  const x2 = adapter.timeToX(
    annotation.endTime ?? (annotation.kind === 'zone' ? latestTime : annotation.time),
  );
  const y1 = adapter.priceToY(annotation.price);
  const y2 = adapter.priceToY(annotation.price2 ?? annotation.price);
  if (
    x1 === null ||
    x2 === null ||
    y1 === null ||
    y2 === null ||
    ![x1, x2, y1, y2].every(Number.isFinite) ||
    Math.max(x1, x2) < 0 ||
    Math.min(x1, x2) > adapter.width ||
    Math.max(y1, y2) < 0 ||
    Math.min(y1, y2) > adapter.height
  )
    return null;
  return { annotation, x1, x2, y1, y2, labelX: annotation.kind === 'level' ? x2 : Math.max(0, x1) };
}

export function paintAnnotations(
  ctx: CanvasRenderingContext2D,
  geometries: readonly AnnotationGeometry[],
) {
  ctx.save();
  ctx.font = '10px Inter, sans-serif';
  ctx.lineWidth = 1;
  const labels: Array<{ x: number; y: number; width: number }> = [];
  // Newer confirmations get first choice of label space.
  for (const g of [...geometries].reverse()) {
    const a = g.annotation;
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    ctx.globalAlpha = a.status === 'filled' ? 0.27 : 0.8;
    ctx.setLineDash(a.kind === 'level' || a.status === 'touched' ? [4, 3] : []);
    if (a.kind === 'zone') {
      const y = Math.min(g.y1, g.y2),
        h = Math.max(1, Math.abs(g.y2 - g.y1));
      ctx.globalAlpha = a.status === 'filled' ? 0.035 : 0.09;
      ctx.fillRect(g.x1, y, g.x2 - g.x1, h);
      ctx.globalAlpha = a.status === 'filled' ? 0.2 : 0.55;
      ctx.strokeRect(g.x1, y, g.x2 - g.x1, h);
    } else if (a.kind === 'level') {
      ctx.beginPath();
      ctx.moveTo(g.x1, g.y1);
      ctx.lineTo(g.x2, g.y1);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(g.x1, g.y1, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    const label = a.text + (a.status === 'filled' ? ' · filled' : '');
    const width = ctx.measureText(label).width + 8,
      x = g.labelX + 4,
      y = Math.min(g.y1, g.y2) - 6;
    if (
      labels.some(
        (other) => Math.abs(other.y - y) < 14 && x < other.x + other.width && x + width > other.x,
      )
    )
      continue;
    labels.push({ x, y, width });
    ctx.globalAlpha = a.status === 'filled' ? 0.35 : 0.95;
    ctx.fillStyle = '#101721';
    ctx.fillRect(x - 3, y - 10, width, 14);
    ctx.fillStyle = a.color;
    ctx.fillText(label, x, y);
  }
  ctx.restore();
}
