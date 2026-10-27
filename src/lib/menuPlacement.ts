// Where a floating menu goes so it stays on screen: below and to the right of
// the anchor when it fits, flipped when it does not, clamped otherwise.

export interface Placement {
  left: number;
  top: number;
  maxHeight: number;
}

const MARGIN = 8;

export function placeMenu(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  flipAbove?: number,
): Placement {
  let left = anchor.x;
  if (left + size.width + MARGIN > viewport.width) {
    left = Math.max(MARGIN, viewport.width - size.width - MARGIN);
  }
  let top = anchor.y;
  const fitsBelow = top + size.height + MARGIN <= viewport.height;
  if (!fitsBelow) {
    const above = flipAbove ?? anchor.y;
    if (above - size.height >= MARGIN) {
      top = above - size.height;
    } else {
      top = Math.max(MARGIN, viewport.height - size.height - MARGIN);
    }
  }
  const maxHeight = Math.max(80, viewport.height - top - MARGIN);
  return { left, top, maxHeight };
}
