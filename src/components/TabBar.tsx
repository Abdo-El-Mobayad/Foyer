import { useCallback, useEffect, useRef, useState } from "react";
import { useNotes, type NoteStatus } from "../editor/sessions";
import { badgeOf } from "../lib/fileKinds";
import { canManage, renameEntry } from "../lib/fileOps";
import { basename } from "../lib/paths";
import { useStore } from "../store";
import { ContextMenu, type MenuAnchor } from "./ContextMenu";
import { IconClose } from "./Icons";

interface TabMenu extends MenuAnchor {
  path: string;
}

const DOT_TITLE: Partial<Record<NoteStatus, string>> = {
  dirty: "Unsaved changes",
  saving: "Saving…",
  conflict: "Not saved: changed or deleted on disk",
  error: "Save failed",
};

/**
 * The open-files strip. Click to switch, × or middle-click to close,
 * right-click for the bulk close actions and Rename. The active tab is
 * derived from the store's `active`, never tracked separately. A note that
 * is not saved yet carries a dot.
 */
export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.active);
  const noteInfo = useNotes((s) => s.notes);
  const activeRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  if (tabs.length === 0) return null;

  const menuIdx = menu ? tabs.indexOf(menu.path) : -1;

  return (
    <div
      className="tab-strip"
      role="tablist"
      aria-label="Open files"
      onWheel={(e) => {
        // A vertical wheel over a horizontal strip scrolls it sideways.
        if (e.deltaY !== 0 && e.deltaX === 0) {
          e.currentTarget.scrollLeft += e.deltaY;
        }
      }}
    >
      {tabs.map((path) => {
        const isActive = path === active;
        const name = basename(path);
        const badge = badgeOf(name);
        return (
          <div
            key={path}
            ref={isActive ? activeRef : undefined}
            className={`tab${isActive ? " active" : ""}`}
            role="tab"
            aria-selected={isActive}
            title={path}
            onClick={() => {
              if (!isActive) useStore.getState().setActive(path);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) useStore.getState().closeTab(path);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, path });
            }}
          >
            <span className="tab-label">{name}</span>
            {badge && <span className="tab-badge">{badge}</span>}
            {noteInfo[path] && noteInfo[path].status !== "clean" && (
              <span
                className={`tab-dot ${noteInfo[path].status}`}
                title={DOT_TITLE[noteInfo[path].status]}
                aria-label={DOT_TITLE[noteInfo[path].status]}
              />
            )}
            <button
              className="tab-close"
              title="Close (Ctrl+W)"
              aria-label={`Close ${name}`}
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                useStore.getState().closeTab(path);
              }}
            >
              <IconClose />
            </button>
          </div>
        );
      })}

      {menu && (
        <ContextMenu
          anchor={menu}
          onClose={closeMenu}
          label={`Tab actions for ${basename(menu.path)}`}
          items={[
            { label: "Close", hint: "Ctrl+W", onSelect: () => useStore.getState().closeTab(menu.path) },
            ...(canManage(menu.path, false)
              ? [{ label: "Rename…", hint: "F2", onSelect: () => void renameEntry(menu.path, false) }]
              : []),
            {
              label: "Close others",
              disabled: tabs.length < 2,
              onSelect: () => useStore.getState().closeOtherTabs(menu.path),
            },
            {
              label: "Close tabs to the right",
              disabled: menuIdx === -1 || menuIdx === tabs.length - 1,
              onSelect: () => useStore.getState().closeTabsToRight(menu.path),
            },
            { label: "Close all", sep: true, onSelect: () => useStore.getState().closeAllTabs() },
          ]}
        />
      )}
    </div>
  );
}
