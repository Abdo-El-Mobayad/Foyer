import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { badgeOf } from "../lib/fileKinds";
import { canManage, newFolder, newNote, renameEntry, trashEntry } from "../lib/fileOps";
import * as ipc from "../lib/ipc";
import { joinAbs } from "../lib/paths";
import { toast } from "../lib/toast";
import { flattenVisible, type Row, type TreeNode } from "../lib/tree";
import { useStore } from "../store";
import { ContextMenu, type MenuAnchor, type MenuItem } from "./ContextMenu";
import { IconChevron, IconMore } from "./Icons";

const ROW_H = 26;
const INDENT = 12;
const OVERSCAN = 12;

/** A row's menu, or (node null) the menu of the empty space below the rows. */
interface RowMenu extends MenuAnchor {
  node: TreeNode | null;
}

/**
 * The file tree: a flat, windowed list of the visible rows. Only the rows in
 * view (plus a small overscan) are in the DOM, so a folder with ten thousand
 * entries scrolls like one with ten. Keyboard: arrows move and open/close,
 * Enter opens, Home/End jump, Delete bins a note or folder (F2 renames, from
 * App). Right-click on the empty space below the rows for New note / folder
 * at the mount root.
 */
export function Tree() {
  const root = useStore((s) => s.root);
  const expanded = useStore((s) => s.expanded);
  const loading = useStore((s) => s.loading);
  const active = useStore((s) => s.active);
  const cursor = useStore((s) => s.cursor);
  const opening = useStore((s) => s.opening);
  const mount = useStore((s) => s.mount);

  const rows = useMemo(() => flattenVisible(root, expanded), [root, expanded]);
  const indexByPath = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.node.path, i));
    return m;
  }, [rows]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Keep the cursor row in view when it moves by keyboard or reveal.
  useEffect(() => {
    if (!cursor) return;
    const i = indexByPath.get(cursor);
    const el = scrollerRef.current;
    if (i === undefined || !el) return;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  }, [cursor, indexByPath]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const visible = rows.slice(first, last);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    const st = useStore.getState();
    const i = cursor ? (indexByPath.get(cursor) ?? -1) : -1;
    const row = i >= 0 ? rows[i] : null;
    const go = (n: number) => {
      const j = Math.max(0, Math.min(rows.length - 1, n));
      st.setCursor(rows[j].node.path);
    };
    switch (e.key) {
      case "ArrowDown":
        go(i + 1);
        break;
      case "ArrowUp":
        go(i - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(rows.length - 1);
        break;
      case "PageDown":
        go(i + Math.floor(height / ROW_H));
        break;
      case "PageUp":
        go(i - Math.floor(height / ROW_H));
        break;
      case "ArrowRight":
        if (!row) return;
        if (row.node.isDir && !row.expanded) st.setExpanded(row.node.path, true);
        else if (row.node.isDir) go(i + 1);
        break;
      case "ArrowLeft":
        if (!row) return;
        if (row.node.isDir && row.expanded) st.setExpanded(row.node.path, false);
        else {
          const parent = row.node.path.slice(0, row.node.path.lastIndexOf("/"));
          if (parent && indexByPath.has(parent)) st.setCursor(parent);
        }
        break;
      case "Enter":
      case " ":
        if (!row) return;
        if (row.node.isDir) st.toggleDir(row.node.path);
        else st.openFile(row.node.path);
        break;
      case "Delete":
        if (!row || !canManage(row.node.path, row.node.isDir)) return;
        void trashEntry(row.node.path, row.node.isDir);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  if (opening && rows.length === 0) {
    return <div className="tree-empty">Listing…</div>;
  }
  if (!opening && rows.length === 0) {
    return <div className="tree-empty">This folder is empty.</div>;
  }

  return (
    <div
      className="tree"
      ref={scrollerRef}
      role="tree"
      aria-label="Files"
      tabIndex={0}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, node: null });
      }}
    >
      <div className="tree-space" style={{ height: rows.length * ROW_H }}>
        {visible.map((r, k) => (
          <TreeRow
            key={r.node.path}
            row={r}
            top={(first + k) * ROW_H}
            isActive={r.node.path === active}
            isCursor={r.node.path === cursor}
            isLoading={loading.has(r.node.path)}
            onMenu={(anchor, node) => setMenu({ ...anchor, node })}
          />
        ))}
      </div>
      {menu && mount && (
        <ContextMenu
          anchor={menu}
          onClose={closeMenu}
          label={menu.node ? `Actions for ${menu.node.name}` : `Actions for ${mount.name}`}
          items={
            menu.node
              ? rowMenuItems(mount, menu.node)
              : [
                  { label: "New note", hint: "Ctrl+N", onSelect: () => void newNote("") },
                  { label: "New folder", onSelect: () => void newFolder("") },
                ]
          }
        />
      )}
    </div>
  );
}

function rowMenuItems(mount: ipc.Mount, node: TreeNode): MenuItem[] {
  const abs = joinAbs(mount.path, node.path);
  const st = useStore.getState();
  const managed = canManage(node.path, node.isDir);
  return [
    ...(node.isDir
      ? [
          {
            label: st.expanded.has(node.path) ? "Collapse" : "Expand",
            onSelect: () => st.toggleDir(node.path),
          },
          { label: "New note here", hint: "Ctrl+N", onSelect: () => void newNote(node.path) },
          { label: "New folder here", onSelect: () => void newFolder(node.path) },
        ]
      : [{ label: "Open", onSelect: () => st.openFile(node.path) }]),
    ...(managed
      ? [
          { label: "Rename…", hint: "F2", sep: true, onSelect: () => void renameEntry(node.path, node.isDir) },
          {
            label: "Move to Recycle Bin",
            hint: "Del",
            danger: true,
            onSelect: () => void trashEntry(node.path, node.isDir),
          },
        ]
      : []),
    {
      label: node.isDir ? "Open in VS Code (new window)" : "Open in VS Code",
      sep: true,
      onSelect: () =>
        void ipc.openInVsCode(abs, { newWindow: node.isDir }).catch(() => {
          toast("Could not open VS Code. Is it installed?", "error");
        }),
    },
    {
      label: "Show in Explorer",
      onSelect: () =>
        void ipc.revealInFileManager(abs).catch(() => {
          toast("Could not show that in Explorer", "error");
        }),
    },
    {
      label: "Copy path",
      onSelect: () =>
        void ipc.copyText(abs).then((ok) => {
          toast(ok ? "Path copied" : "Could not copy the path", ok ? "success" : "error");
        }),
    },
    {
      label: "Copy relative path",
      onSelect: () =>
        void ipc.copyText(node.path).then((ok) => {
          toast(ok ? "Path copied" : "Could not copy the path", ok ? "success" : "error");
        }),
    },
    ...(node.isDir
      ? []
      : [
          {
            label: "Open in default app",
            onSelect: () =>
              void ipc.openInDefaultApp(mount.id, node.path).catch(() => {
                toast("Could not open that with its default app", "error");
              }),
          },
        ]),
  ];
}

function TreeRow({
  row,
  top,
  isActive,
  isCursor,
  isLoading,
  onMenu,
}: {
  row: Row;
  top: number;
  isActive: boolean;
  isCursor: boolean;
  isLoading: boolean;
  onMenu: (anchor: MenuAnchor, node: TreeNode) => void;
}) {
  const { node, depth, expanded } = row;
  const badge = node.isDir ? null : badgeOf(node.name);
  const isEmpty = node.isDir && node.childrenLoaded && (node.children?.length ?? 0) === 0;
  return (
    <div
      className={`tree-row${node.isDir ? " is-dir" : ""}${isActive ? " active" : ""}${isCursor ? " cursor" : ""}${node.name.startsWith(".") ? " is-dot" : ""}`}
      style={{ top, paddingLeft: 8 + depth * INDENT }}
      role="treeitem"
      aria-expanded={node.isDir ? expanded : undefined}
      aria-selected={isActive || undefined}
      title={node.path}
      onClick={() => {
        const st = useStore.getState();
        if (node.isDir) st.toggleDir(node.path);
        else st.openFile(node.path);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        useStore.getState().setCursor(node.path);
        onMenu({ x: e.clientX, y: e.clientY }, node);
      }}
      onMouseDown={(e) => {
        if (e.detail > 1) e.preventDefault();
      }}
    >
      <span className={`tree-chevron${expanded ? " open" : ""}${isLoading ? " loading" : ""}`} aria-hidden="true">
        {node.isDir && <IconChevron />}
      </span>
      <span className="tree-label">{node.name}</span>
      {badge && <span className="tree-badge">{badge}</span>}
      {isEmpty && <span className="tree-hint">empty</span>}
      <button
        className="tree-more"
        title="More actions"
        aria-label={`Actions for ${node.name}`}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu({ x: r.left, y: r.bottom + 4, flipAbove: r.top - 4 }, node);
        }}
      >
        <IconMore />
      </button>
    </div>
  );
}
