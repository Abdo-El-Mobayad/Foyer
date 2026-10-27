import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeMenu, type Placement } from "../lib/menuPlacement";

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** A thin rule above this item. */
  sep?: boolean;
  hint?: string;
}

export interface MenuAnchor {
  x: number;
  y: number;
  /** When the menu flips above, its bottom lands here (a button's top). */
  flipAbove?: number;
}

/**
 * A floating menu anchored to a point. Rendered hidden first, measured, then
 * placed so it never leaves the window. Closes on outside press, Escape, blur
 * and window resize.
 */
export function ContextMenu({
  anchor,
  items,
  onClose,
  label,
}: {
  anchor: MenuAnchor;
  items: MenuItem[];
  onClose: () => void;
  label: string;
}) {
  const ref = useRef<HTMLUListElement | null>(null);
  const [pos, setPos] = useState<Placement | null>(null);

  useEffect(() => {
    const onPress = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPress, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setPos(
      placeMenu(
        { x: anchor.x, y: anchor.y },
        { width: box.width, height: box.height },
        { width: window.innerWidth, height: window.innerHeight },
        anchor.flipAbove,
      ),
    );
  }, [anchor]);

  return createPortal(
    <ul
      className="context-menu"
      role="menu"
      aria-label={label}
      ref={ref}
      style={
        pos
          ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight }
          : { left: anchor.x, top: anchor.y, visibility: "hidden" }
      }
    >
      {items.map((item, i) => (
        <li
          key={i}
          role="menuitem"
          aria-disabled={item.disabled || undefined}
          className={`${item.sep ? "sep " : ""}${item.disabled ? "disabled " : ""}${item.danger ? "danger" : ""}`.trim()}
          onClick={() => {
            if (item.disabled) return;
            onClose();
            item.onSelect?.();
          }}
        >
          <span>{item.label}</span>
          {item.hint && <kbd>{item.hint}</kbd>}
        </li>
      ))}
    </ul>,
    document.body,
  );
}
