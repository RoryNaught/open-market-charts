# Drawing tools

`@omc/drawing-engine` has no chart-library or UI-framework dependency. It owns market-coordinate objects, geometry, hit testing, pointer gestures, validation, and undo/redo. The renderer supplies coordinate conversions and paints the geometry using Canvas 2D.

## Object model

A `Drawing` has a stable `id`, `type`, `symbolId`, `paneId`, `scaleId`, `anchors`, `style`, `visible`, and `locked`. Fibonacci drawings also have configurable `levels`.

Anchors contain `{ time, value }`. Time is UTC milliseconds. Value is the original price or indicator value, including on logarithmic and percentage scales. Pixel positions and logical bar indices are derived at draw time and never persisted. Changing chart type, pane dimensions, or price scale therefore does not rewrite the stored anchors.

| Tool               | Anchors | Behavior                                                                                                                                        |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `trend-line`       | 2       | Finite line segment.                                                                                                                            |
| `horizontal-line`  | 1       | Full-width value line; moving its handle changes only value.                                                                                    |
| `vertical-line`    | 1       | Full-height time line; moving its handle changes only time.                                                                                     |
| `ray`              | 2       | Extends from the first anchor through the second to the viewport edge.                                                                          |
| `rectangle`        | 2       | Opposing corners define the bounds. Both corners have resize handles.                                                                           |
| `price-range`      | 2       | Rectangle plus signed absolute and percentage change. A zero starting value displays percentage as `n/a`.                                       |
| `date-range`       | 2       | Full-height time interval with elapsed duration. Handles change only time.                                                                      |
| `fibonacci`        | 2       | Levels interpolate raw values; the default levels are 0, .236, .382, .5, .618, .786, and 1.                                                     |
| `parallel-channel` | 3       | Two anchors establish the baseline; the third establishes a perpendicular offset in the active display scale. Vertical baselines are supported. |

Parallel-channel lines stay visually parallel in the current scale. Fibonacci levels retain their raw-price meaning on logarithmic scales, so their screen spacing is not linear. Date ranges report elapsed wall-clock duration, including closed sessions; they do not claim that the entire interval was traded.

## Renderer adapter

```ts
interface CoordinateAdapter {
  width: number;
  height: number;
  timeToX(time: number): number | null;
  xToTime(x: number): number | null;
  priceToY(value: number): number | null;
  yToPrice(y: number): number | null;
}
```

All coordinates are pane-local CSS pixels. Use the active series' public price-conversion methods so drawings follow its scale and base value. Return `null` while a conversion is unavailable. Horizontal/time-only tools remain paintable when their irrelevant coordinate cannot be resolved. Invalid log-domain values produce no geometry rather than invalid canvas coordinates.

`timeToLogical(time, sortedUniqueTimes, intervalMs)` and `logicalToTime(logical, sortedUniqueTimes, intervalMs)` provide binary-search interpolation for a compressed time axis. Exact timestamps land on their bars; timestamps inside gaps interpolate between adjacent bars. Indices must be recalculated after history is prepended. The helpers assume sorted, unique timestamps and use uniform extrapolation outside loaded history. That extrapolation is intended for 24/7 feeds. Session-based providers must supply calendar-aware future/older projections through the adapter; simply adding an interval across overnight closures is not an exchange calendar. An absent timestamp is never inserted as a fake OHLC bar.

`buildDrawingGeometry(drawing, adapter)` returns segments, fill polygons, labels, and handle locations. Segments and rays are clipped to the pane; Canvas also clips fills and labels. `paintDrawings(context, drawings, adapter, { selectedId, symbolId, paneId, scaleId })` paints in CSS-pixel space. The caller owns canvas allocation, device-pixel scaling, and invalidation. For Lightweight Charts, call it from a public series primitive in media-coordinate space.

`hitTestDrawings` filters by scope, checks selected handles first, then checks visible object bodies in reverse drawing order. Its default tolerance is six CSS pixels; callers can pass twelve for touch. Locked objects remain selectable but have no resize handles. Drawings do not change chart autoscaling by default.

## Interaction and commands

```ts
const store = new DrawingStore();
const interaction = new DrawingInteraction(
  store,
  () => activePaneAdapter,
  () => ({ symbolId, paneId, scaleId }),
  () => renderer.setDrawings(interaction.getRenderDrawings(), store.selectedId),
);
store.subscribe(() => {
  renderer.setDrawings(interaction.getRenderDrawings(), store.selectedId);
});
```

The example is a wiring outline: use your renderer's actual update method. `getRenderDrawings()` includes the current gesture preview, while `store.getAll()` contains committed state only. This keeps pointer movement out of persistence and undo history.

- `setTool(type)` activates a tool. Drag and release to create a two-anchor drawing; click to create a horizontal or vertical line. For a parallel channel, drag its baseline, then click its third point. Successful creation returns to selection mode.
- `pointerDown({ x, y }, tolerance?)` returns whether the drawing controller owns the gesture. An empty-space gesture in selection mode returns false so the chart can pan.
- Call `pointerMove` and `pointerUp` for captured events, including moves outside the pane. Selected corner/endpoint handles resize; the object body moves all anchors through the current coordinate transform. A drag requires three CSS pixels of movement.
- The host captures the pointer, prevents the chart's scroll/scale handlers for an owned gesture, and restores the previous chart options afterward. On `pointercancel`, blur, Escape, or workspace changes, call `cancel()` and release capture. Changing symbol/pane/scale during a gesture cancels it.
- `store.select(id)`, `getSelected()`, `update(id, { style: { color, lineWidth, lineDash, fillColor, fontSize } })`, `remove(id?)`, `clear()`, `undo()`, and `redo()` support toolbar and keyboard controls. Omitting the delete ID removes the selection. Locking prevents pointer edits; the host can still explicitly unlock, delete, or edit a locked drawing through commands.

Each completed gesture commits one command. Intermediate moves stay in the preview, and cancellation leaves committed objects unchanged. Style edits and deletion are also undoable. The default history is 100 commands, sharing unchanged objects internally. New edits clear redo history. Returned drawings are copied so consumer mutation cannot corrupt history.

## Persistence and migration

`store.serialize()` creates `{ "schemaVersion": 1, "drawings": [...] }` JSON. `restore(jsonOrObject)` validates the complete document before changing state. Unknown versions, duplicate IDs, incorrect anchor counts, invalid numbers, and oversized collections are rejected. The document limit is 10,000 drawings; individual Fibonacci objects allow up to 64 levels. Restoration resets selection and session undo history.

The version-zero migration converts `{ time, price }` anchors to `{ time, value }` and supplies the original `price` pane and `right` scale defaults. New schema versions require explicit migration functions and fixtures. Save committed snapshots through the workspace store; do not save pointer previews. The workspace layer should retain a last-known-good snapshot and surface import errors without overwriting it.

Drawings are scoped by instrument and stable pane/scale IDs. Hide drawings whose associated pane/series is unavailable; preserve them in the workspace rather than reassigning their coordinates to a different indicator. Data-provider credentials never belong in drawing documents.

## Tests

Run `npx vitest run --root . packages/drawing-engine/src/drawing-engine.test.ts`. The suite covers every tool, clipping and degenerate rays, vertical channels, hit-test priority, time gaps and pagination, logarithmic/percentage transforms, creation and constrained edits, cancellation, one-command gestures, validation, migrations, and undo/redo.
