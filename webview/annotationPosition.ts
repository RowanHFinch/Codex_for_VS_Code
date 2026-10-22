type Rect = { left: number; right: number; top: number; bottom: number };

/** Keep the popup eight pixels from the first selected line, inside the visible transcript. */
export function annotationPosition(anchor: Rect, size: { width: number; height: number }, bounds: Rect) {
  const left = Math.max(
    bounds.left,
    Math.min((anchor.left + anchor.right - size.width) / 2, bounds.right - size.width),
  );
  const above = anchor.top - size.height - 8;
  const top = above >= bounds.top ? above : anchor.bottom + 8;
  return { left, top: Math.max(bounds.top, Math.min(top, bounds.bottom - size.height)) };
}
