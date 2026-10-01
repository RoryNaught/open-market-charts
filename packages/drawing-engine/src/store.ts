import { z } from 'zod';
import { DRAWING_TOOLS, anchorCount, type Drawing, type DrawingStyle } from './types';

const anchorSchema = z
  .object({ time: z.number().finite().min(-8.64e15).max(8.64e15), value: z.number().finite() })
  .strict();
const styleSchema = z
  .object({
    color: z.string().min(1).max(100),
    fillColor: z.string().min(1).max(100),
    lineWidth: z.number().finite().min(0.5).max(20),
    lineDash: z.array(z.number().finite().min(0).max(100)).max(8),
    fontSize: z.number().finite().min(8).max(48),
  })
  .strict();
const drawingSchema = z
  .object({
    id: z.string().min(1).max(128),
    type: z.enum(DRAWING_TOOLS),
    symbolId: z.string().max(128),
    paneId: z.string().min(1).max(128),
    scaleId: z.string().min(1).max(128),
    anchors: z.array(anchorSchema).min(1).max(3),
    style: styleSchema,
    visible: z.boolean(),
    locked: z.boolean(),
    levels: z.array(z.number().finite().min(-100).max(100)).max(64).optional(),
  })
  .strict()
  .superRefine((drawing, context) => {
    if (drawing.anchors.length !== anchorCount(drawing.type))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Incorrect anchor count for drawing type',
      });
  });
const drawingsSchema = z
  .array(drawingSchema)
  .max(10_000)
  .superRefine((drawings, context) => {
    if (new Set(drawings.map((d) => d.id)).size !== drawings.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate drawing IDs' });
  });
export interface DrawingDocument {
  schemaVersion: 1;
  drawings: Drawing[];
}
export function validateDrawings(input: unknown): Drawing[] {
  return drawingsSchema.parse(input);
}

/** Explicit migrations precede validation; unsupported versions never overwrite a workspace. */
export function deserializeDrawings(input: string | unknown): Drawing[] {
  const document = typeof input === 'string' ? (JSON.parse(input) as unknown) : input;
  if (
    document &&
    typeof document === 'object' &&
    'schemaVersion' in document &&
    document.schemaVersion === 0 &&
    'drawings' in document &&
    Array.isArray(document.drawings)
  ) {
    // The early schema used `price`, without explicit pane or price-scale identifiers.
    return validateDrawings(
      document.drawings.map((raw: unknown) => {
        if (!raw || typeof raw !== 'object') return raw;
        const drawing = raw as Record<string, unknown>;
        return {
          ...drawing,
          paneId: drawing.paneId ?? 'price',
          scaleId: drawing.scaleId ?? 'right',
          anchors: Array.isArray(drawing.anchors)
            ? drawing.anchors.map((rawAnchor: unknown) => {
                if (!rawAnchor || typeof rawAnchor !== 'object') return rawAnchor;
                const { price, ...anchor } = rawAnchor as Record<string, unknown>;
                return { ...anchor, value: anchor.value ?? price };
              })
            : drawing.anchors,
        };
      }),
    );
  }
  const parsed = z
    .object({ schemaVersion: z.literal(1), drawings: drawingsSchema })
    .strict()
    .parse(document);
  return parsed.drawings;
}

export type DrawingUpdate = Partial<Omit<Drawing, 'id' | 'style'>> & {
  style?: Partial<DrawingStyle>;
};
interface HistoryEntry {
  before: Drawing[];
  after: Drawing[];
  selectionBefore: string | null;
  selectionAfter: string | null;
}

/** Immutable internal snapshots share unchanged objects; one committed gesture is one entry. */
export class DrawingStore {
  private drawings: Drawing[];
  private selected: string | null = null;
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private listeners = new Set<() => void>();
  constructor(
    initial: Drawing[] = [],
    private readonly historyLimit = 100,
  ) {
    this.drawings = validateDrawings(initial);
  }
  get selectedId(): string | null {
    return this.selected;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  getAll(): Drawing[] {
    return structuredClone(this.drawings);
  }
  getSelected(): Drawing | null {
    const drawing = this.drawings.find((d) => d.id === this.selected);
    return drawing ? structuredClone(drawing) : null;
  }
  get(id: string): Drawing | null {
    const drawing = this.drawings.find((d) => d.id === id);
    return drawing ? structuredClone(drawing) : null;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
  select(id: string | null): void {
    const next = id && this.drawings.some((d) => d.id === id) ? id : null;
    if (next !== this.selected) {
      this.selected = next;
      this.emit();
    }
  }
  private commit(next: Drawing[], selection: string | null): void {
    if (
      this.drawings.length === next.length &&
      this.drawings.every((drawing, index) => drawing === next[index])
    )
      return;
    this.past.push({
      before: this.drawings,
      after: next,
      selectionBefore: this.selected,
      selectionAfter: selection,
    });
    if (this.past.length > Math.max(1, this.historyLimit)) this.past.shift();
    this.future = [];
    this.drawings = next;
    this.selected = selection;
    this.emit();
  }
  add(drawing: Drawing): void {
    const valid = drawingSchema.parse(drawing);
    if (this.drawings.some((d) => d.id === valid.id))
      throw new Error(`Drawing ID already exists: ${valid.id}`);
    if (this.drawings.length >= 10_000) throw new Error('Drawing limit exceeded');
    this.commit([...this.drawings, valid], valid.id);
  }
  update(id: string, patch: DrawingUpdate): void {
    const current = this.drawings.find((d) => d.id === id);
    if (!current) return;
    const updated = drawingSchema.parse({
      ...current,
      ...patch,
      id,
      style: { ...current.style, ...patch.style },
    });
    if (JSON.stringify(current) === JSON.stringify(updated)) return;
    this.commit(
      this.drawings.map((d) => (d.id === id ? updated : d)),
      this.selected,
    );
  }
  remove(id: string = this.selected ?? ''): void {
    this.commit(
      this.drawings.filter((d) => d.id !== id),
      this.selected === id ? null : this.selected,
    );
  }
  clear(): void {
    this.commit([], null);
  }
  undo(): boolean {
    const entry = this.past.pop();
    if (!entry) return false;
    this.future.push(entry);
    this.drawings = entry.before;
    this.selected = entry.selectionBefore;
    this.emit();
    return true;
  }
  redo(): boolean {
    const entry = this.future.pop();
    if (!entry) return false;
    this.past.push(entry);
    this.drawings = entry.after;
    this.selected = entry.selectionAfter;
    this.emit();
    return true;
  }
  serialize(): string {
    return JSON.stringify({ schemaVersion: 1, drawings: this.drawings } satisfies DrawingDocument);
  }
  restore(document: string | unknown): void {
    const next = deserializeDrawings(document); // Validate before touching current state.
    this.drawings = next;
    this.selected = null;
    this.past = [];
    this.future = [];
    this.emit();
  }
}
