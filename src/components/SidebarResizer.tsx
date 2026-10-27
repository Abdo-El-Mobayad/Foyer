import { useRef, useState } from "react";
import {
  clampSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  writeSidebarWidth,
} from "../lib/prefs";

/** Drag handle on the sidebar's right edge. Double-click resets. */
export function SidebarResizer({
  width,
  onWidth,
}: {
  width: number;
  onWidth: (px: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const grabOffset = useRef(0);

  const commit = (px: number) => {
    onWidth(px);
    writeSidebarWidth(clampSidebarWidth(px, window.innerWidth));
  };

  return (
    <div
      className={`sidebar-resizer${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={(e) => {
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
        e.currentTarget.setPointerCapture(e.pointerId);
        grabOffset.current = e.clientX - width;
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        onWidth(e.clientX - grabOffset.current);
      }}
      onPointerUp={(e) => {
        if (!dragging) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
        commit(e.clientX - grabOffset.current);
      }}
      onDoubleClick={() => commit(SIDEBAR_WIDTH_DEFAULT)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 32 : 8;
        if (e.key === "ArrowLeft") commit(width - step);
        else if (e.key === "ArrowRight") commit(width + step);
        else if (e.key === "Home") commit(SIDEBAR_WIDTH_DEFAULT);
        else return;
        e.preventDefault();
      }}
    />
  );
}
