export type WindowRect = { left: number; top: number; width: number; height: number };
export type Viewport = { width: number; height: number };
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const MARGIN = 12;
const INITIAL_BOTTOM_INSET = 84;
const INITIAL_WIDTH = 430;
const INITIAL_HEIGHT = 680;
const EDGES: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function limits(viewport: Viewport) {
  const width = Math.max(1, finiteOr(viewport.width, 1024));
  const height = Math.max(1, finiteOr(viewport.height, 768));
  // On impossibly small viewports, shrink reservations only enough to retain a
  // finite one-pixel window. Normal viewports keep all requested clearances.
  const side = Math.min(MARGIN, Math.max(0, (width - 1) / 2));
  const top = Math.min(MARGIN, Math.max(0, (height - 1) / 2));
  const left = side, right = width - side, bottom = height - top;
  const availableWidth = right - left, availableHeight = bottom - top;
  return { viewportWidth: width, viewportHeight: height, left, top, right, bottom, availableWidth, availableHeight,
    minWidth: Math.min(340, availableWidth), minHeight: Math.min(360, availableHeight) };
}

/** Fit size first, then position, keeping a twelve-pixel viewport margin on each side. */
export function clampWindowRect(rect: WindowRect, viewport: Viewport): WindowRect {
  const bounds = limits(viewport);
  const width = clamp(finiteOr(rect.width, INITIAL_WIDTH), bounds.minWidth, bounds.availableWidth);
  const height = clamp(finiteOr(rect.height, INITIAL_HEIGHT), bounds.minHeight, bounds.availableHeight);
  return {
    left: clamp(finiteOr(rect.left, bounds.left), bounds.left, bounds.right - width),
    top: clamp(finiteOr(rect.top, bounds.top), bounds.top, bounds.bottom - height),
    width, height,
  };
}

/** Open at the lower right, using the preferred launcher inset when the minimum size fits. */
export function initialWindowRect(viewport: Viewport): WindowRect {
  const bounds = limits(viewport);
  const width = Math.min(INITIAL_WIDTH, bounds.availableWidth);
  const initialBottom = Math.max(bounds.top + 1, bounds.viewportHeight - INITIAL_BOTTOM_INSET);
  const height = Math.min(INITIAL_HEIGHT, initialBottom - bounds.top);
  const rightInset = bounds.viewportWidth <= 600 ? MARGIN : 24;
  return clampWindowRect({ left: bounds.viewportWidth - rightInset - width, top: initialBottom - height, width, height }, viewport);
}

/** The largest allowed window keeps only the twelve-pixel viewport margins. */
export function maximizedWindowRect(viewport: Viewport): WindowRect {
  const bounds = limits(viewport);
  return { left: bounds.left, top: bounds.top, width: bounds.availableWidth, height: bounds.availableHeight };
}

/**
 * Resize from an original gesture rectangle. Requested edges move; opposite edges
 * remain pinned. Clamp each moving edge directly so large overdrags cannot move
 * the window or flip its orientation. Nonfinite pointer deltas mean no movement.
 */
export function resizeWindowRect(rect: WindowRect, edge: ResizeEdge, dx: number, dy: number, viewport: Viewport): WindowRect {
  const original = clampWindowRect(rect, viewport);
  if (!EDGES.includes(edge)) return original;
  const bounds = limits(viewport);
  const deltaX = finiteOr(dx, 0), deltaY = finiteOr(dy, 0);
  let left = original.left, top = original.top;
  let right = left + original.width, bottom = top + original.height;
  if (edge.includes('w')) left = clamp(left + deltaX, bounds.left, right - bounds.minWidth);
  if (edge.includes('e')) right = clamp(right + deltaX, left + bounds.minWidth, bounds.right);
  if (edge.includes('n')) top = clamp(top + deltaY, bounds.top, bottom - bounds.minHeight);
  if (edge.includes('s')) bottom = clamp(bottom + deltaY, top + bounds.minHeight, bounds.bottom);
  return { left, top, width: right - left, height: bottom - top };
}
