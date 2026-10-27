import { useRef, useState } from "react";
import { READING_WIDTH_MAX, READING_WIDTH_MIN, type ReadingWidth } from "../lib/prefs";

interface HandleProps {
  width: ReadingWidth;
  articleRef: React.RefObject<HTMLElement | null>;
  onWidth: (w: Partial<ReadingWidth>) => void;
  onCommit: (w: Partial<ReadingWidth>) => void;
}

/** Drag handles on both edges of the reading column. The column is centred,
 *  so an edge moved by dx widens it by 2·dx and stays under the pointer.
 *  Dragging while Full width is on turns the pane width into a custom one.
 *  Double-click resets to the default measure. */
export function ReadingWidthHandles(props: HandleProps) {
  return (
    <>
      <Handle side="left" {...props} />
      <Handle side="right" {...props} />
    </>
  );
}

function Handle({ side, width, articleRef, onWidth, onCommit }: HandleProps & { side: "left" | "right" }) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, w: 0 });
  // Moving the right edge right widens; moving the left edge right narrows.
  const dir = side === "right" ? 1 : -1;

  // The rendered width, not the stored one: at the default measure there is
  // no stored number, and a stored number wider than the pane is capped by
  // CSS, so a drag always starts from what is on screen.
  const measure = () => articleRef.current?.getBoundingClientRect().width ?? READING_WIDTH_MIN;
  const pxAt = (clientX: number) => start.current.w + 2 * dir * (clientX - start.current.x);

  return (
    <div
      className={`reading-resizer ${side}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize reading column, ${side} edge`}
      aria-valuenow={width.px ?? undefined}
      aria-valuemin={READING_WIDTH_MIN}
      aria-valuemax={READING_WIDTH_MAX}
      tabIndex={0}
      title="Drag to set the reading width, double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: measure() };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        onWidth({ px: pxAt(e.clientX), full: false });
      }}
      onPointerUp={(e) => {
        if (!dragging) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
        onCommit({ px: pxAt(e.clientX), full: false });
      }}
      onDoubleClick={() => onCommit({ px: null, full: false })}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const base = width.px ?? measure();
        if (e.key === "ArrowRight") onCommit({ px: base + dir * step, full: false });
        else if (e.key === "ArrowLeft") onCommit({ px: base - dir * step, full: false });
        else if (e.key === "Home") onCommit({ px: null, full: false });
        else if (e.key === "End") onCommit({ full: true });
        else return;
        e.preventDefault();
      }}
    />
  );
}
