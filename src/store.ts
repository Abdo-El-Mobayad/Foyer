// UI state for the open mount: the lazily loaded tree, what is expanded,
// which files are open in tabs, and the index status. Everything about a
// mount that should survive a switch is written to localStorage per mount id
// (see `prefs.ts`); the mount LIST itself is Rust's, on disk.

import { create } from "zustand";
import type { MdMode } from "./editor/modes";
import * as notes from "./editor/sessions";
import { confirmDialog } from "./lib/dialogs";
import * as ipc from "./lib/ipc";
import type { IndexStats, Mount } from "./lib/ipc";
import {
  clearViewState,
  readSidebarShown,
  readViewState,
  writeSidebarShown,
  writeViewState,
} from "./lib/prefs";
import { closeTabs as closeTabsPure, openTab, touchRecent } from "./lib/tabs";
import { toast } from "./lib/toast";
import {
  countNodes,
  dropChildrenAt,
  findNode,
  implicatedFolders,
  loadedFolderPaths,
  mergeChildren,
  setChildrenAt,
  sortNodes,
  type TreeNode,
} from "./lib/tree";
import { isUnder, remapPath } from "./lib/names";
import { ancestors, basename } from "./lib/paths";
import { clampMinutes, DEFAULT_MINUTES } from "./lib/recency";

/** Loaded tree nodes kept once folders collapse. Past this, collapsing a
 *  folder forgets its listing (it is re-listed on expand). */
export const LOADED_NODE_CAP = 20_000;
/** Folder re-listings run at once after a change batch. */
const REFRESH_CONCURRENCY = 4;
/** Trailing debounce for localStorage writes of the view state. */
const PERSIST_MS = 250;

export interface State {
  booting: boolean;
  mounts: Mount[];
  /** The open mount, or null on the welcome screen. */
  mount: Mount | null;
  /** True while a mount is being opened (tree not yet listed). */
  opening: boolean;
  /** Root listing of the open mount. Sub-folders load on expand. */
  root: TreeNode[];
  expanded: Set<string>;
  loading: Set<string>;
  tabs: string[];
  /** Tabs by last view, most recent first. Drives eviction past the cap. */
  recent: string[];
  /** The file on screen. Always one of `tabs` when not null. */
  active: string | null;
  /** The tree's keyboard cursor (a file or a folder). */
  cursor: string | null;
  indexStats: IndexStats | null;
  searchOpen: boolean;
  /** The search overlay should open with the modified-within filter already
   *  on. Set by the sidebar's recent button, read once by the overlay. */
  searchArmRecent: boolean;
  /** The open mount's modified-within window, in minutes. Persisted per
   *  mount; the filter's on/off state is not. */
  recentMinutes: number;
  sidebarShown: boolean;
  /** Bumped when the active file changed on disk, so its preview reloads. */
  reloadNonce: number;
  /** How each open Markdown tab is shown, when the user chose. Absent means
   *  the default (see `resolveMode`). Session-only, dropped with the tab. */
  mdMode: Record<string, MdMode>;

  boot: () => Promise<void>;
  refreshMounts: () => Promise<void>;
  addMount: () => Promise<void>;
  openMount: (id: string) => Promise<void>;
  removeMount: (id: string) => Promise<void>;
  closeMount: () => void;

  loadChildren: (path: string) => Promise<void>;
  refreshFolders: (paths: Iterable<string>) => Promise<void>;
  reloadTree: () => Promise<void>;
  toggleDir: (path: string) => void;
  setExpanded: (path: string, open: boolean) => void;
  collapseAll: () => void;
  revealPath: (path: string) => Promise<void>;

  openFile: (path: string) => void;
  setActive: (path: string) => void;
  closeTab: (path: string) => void;
  closeTabs: (paths: Iterable<string>) => void;
  closeOtherTabs: (path: string) => void;
  closeTabsToRight: (path: string) => void;
  closeAllTabs: () => void;
  cycleTab: (dir: 1 | -1) => void;
  setCursor: (path: string | null) => void;
  setMdMode: (path: string, mode: MdMode) => void;
  /** `from` was renamed to `to`: tabs, cursor, expanded folders and modes
   *  follow it (and everything under it, for a folder). */
  remapPaths: (from: string, to: string) => void;
  /** `dir` is gone (moved to the Recycle Bin): close its tabs, forget its
   *  expanded folders. */
  forgetUnder: (dir: string) => void;

  setSearchOpen: (open: boolean, armRecent?: boolean) => void;
  setRecentMinutes: (minutes: number) => void;
  toggleSidebar: () => void;
  setIndexStats: (mountId: string, stats: IndexStats) => void;
  applyChanges: (mountId: string, changes: ipc.FileChanged[], rescan?: boolean, stats?: IndexStats | null) => void;
}

// ---- persistence: one trailing write per burst of interactions ----------

let persistTimer: number | null = null;

function writeNow(s: State) {
  if (!s.mount) return;
  writeViewState(s.mount.id, {
    expanded: [...s.expanded],
    tabs: s.tabs,
    active: s.active,
    recentMinutes: s.recentMinutes,
  });
}

function persist(_s: State) {
  if (persistTimer !== null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    writeNow(useStore.getState());
  }, PERSIST_MS);
}

/** Write what is pending right now (before a mount switch, on page hide). */
export function flushPersist() {
  if (persistTimer === null) return;
  window.clearTimeout(persistTimer);
  persistTimer = null;
  writeNow(useStore.getState());
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPersist);
}

export const useStore = create<State>((set, get) => ({
  booting: true,
  mounts: [],
  mount: null,
  opening: false,
  root: [],
  expanded: new Set(),
  loading: new Set(),
  tabs: [],
  recent: [],
  active: null,
  cursor: null,
  indexStats: null,
  searchOpen: false,
  searchArmRecent: false,
  recentMinutes: DEFAULT_MINUTES,
  sidebarShown: readSidebarShown(),
  reloadNonce: 0,
  mdMode: {},

  boot: async () => {
    try {
      const list = await ipc.listMounts();
      set({ mounts: list.mounts });
      const first = list.mounts.find((m) => m.id === list.activeMountId && !m.missing);
      if (first) await get().openMount(first.id);
    } catch (e) {
      toast(`Could not read the mount list: ${ipc.errorText(e)}`, "error");
    } finally {
      set({ booting: false });
    }
  },

  refreshMounts: async () => {
    try {
      const list = await ipc.listMounts();
      set({ mounts: list.mounts });
    } catch (e) {
      toast(`Could not read the mount list: ${ipc.errorText(e)}`, "error");
    }
  },

  addMount: async () => {
    if (!(await settleNotes("switch"))) return;
    try {
      const mount = await ipc.addMount();
      if (!mount) return;
      await get().refreshMounts();
      await activate(mount);
    } catch (e) {
      toast(`Could not mount that folder: ${ipc.errorText(e)}`, "error");
    }
  },

  openMount: async (id) => {
    if (get().mount && !(await settleNotes("switch"))) return;
    try {
      const mount = await ipc.openMount(id);
      await get().refreshMounts();
      await activate(mount);
    } catch (e) {
      toast(`Could not open that mount: ${ipc.errorText(e)}`, "error");
      await get().refreshMounts();
    }
  },

  removeMount: async (id) => {
    if (get().mount?.id === id && !(await settleNotes("switch"))) return;
    try {
      await ipc.removeMount(id);
      if (get().mount?.id === id) get().closeMount();
      clearViewState(id);
      await get().refreshMounts();
    } catch (e) {
      toast(`Could not remove that mount: ${ipc.errorText(e)}`, "error");
    }
  },

  closeMount: () => {
    flushPersist();
    notes.discardAll();
    set({
      mount: null,
      root: [],
      expanded: new Set(),
      loading: new Set(),
      tabs: [],
      recent: [],
      active: null,
      cursor: null,
      indexStats: null,
      searchArmRecent: false,
      recentMinutes: DEFAULT_MINUTES,
      mdMode: {},
    });
  },

  loadChildren: async (path) => {
    const mount = get().mount;
    if (!mount) return;
    if (get().loading.has(path)) return;
    set((s) => ({ loading: new Set(s.loading).add(path) }));
    try {
      const kids = sortNodes(await ipc.listChildren(mount.id, path));
      if (get().mount?.id !== mount.id) return;
      set((s) => {
        const existing = path === "" ? s.root : findNode(s.root, path)?.children;
        return { root: setChildrenAt(s.root, path, mergeChildren(existing, kids)) };
      });
    } catch (e) {
      if (!ipc.isMountMismatch(e)) toast(`Could not list ${path || "the mount"}: ${ipc.errorText(e)}`, "error");
    } finally {
      set((s) => {
        const loading = new Set(s.loading);
        loading.delete(path);
        return { loading };
      });
    }
  },

  refreshFolders: async (paths) => {
    const mount = get().mount;
    if (!mount) return;
    const loaded = new Set(loadedFolderPaths(get().root));
    const todo = [...paths].filter((p) => loaded.has(p)).sort((a, b) => a.split("/").length - b.split("/").length);
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const p = todo[next++];
        if (get().mount?.id !== mount.id) return;
        await get().loadChildren(p);
      }
    };
    await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, todo.length) }, worker));
  },

  reloadTree: async () => {
    const mount = get().mount;
    if (!mount) return;
    await get().refreshFolders(loadedFolderPaths(get().root));
  },

  toggleDir: (path) => {
    const open = !get().expanded.has(path);
    get().setExpanded(path, open);
  },

  setExpanded: (path, open) => {
    set((s) => {
      const expanded = new Set(s.expanded);
      let root = s.root;
      if (open) {
        expanded.add(path);
      } else {
        expanded.delete(path);
        // Past the cache cap, a collapsed folder forgets its listing (and
        // its descendants' expansion) so the loaded tree stays bounded.
        if (countNodes(root) > LOADED_NODE_CAP) {
          root = dropChildrenAt(root, path);
          for (const e of expanded) if (e.startsWith(path + "/")) expanded.delete(e);
        }
      }
      return { expanded, cursor: path, root };
    });
    if (open) {
      const node = findNode(get().root, path);
      if (node && !node.childrenLoaded) void get().loadChildren(path);
    }
    persist(get());
  },

  collapseAll: () => {
    set({ expanded: new Set() });
    persist(get());
  },

  revealPath: async (path) => {
    // Expand every ancestor in order, loading as needed, then put the cursor on it.
    for (const dir of ancestors(path)) {
      if (!findNode(get().root, dir)) break;
      if (!get().expanded.has(dir)) {
        set((s) => ({ expanded: new Set(s.expanded).add(dir) }));
      }
      const node = findNode(get().root, dir);
      if (node && !node.childrenLoaded) await get().loadChildren(dir);
    }
    set({ cursor: path });
    persist(get());
  },

  openFile: (path) => {
    const before = get().tabs;
    set((s) => {
      const { tabs, recent } = openTab({ tabs: s.tabs, recent: s.recent }, path);
      return { tabs, recent, active: path, cursor: path };
    });
    // Past the tab cap, the least recently viewed tab went: save its note.
    released(before, get().tabs);
    persist(get());
  },

  setActive: (path) => {
    if (!get().tabs.includes(path)) return;
    set((s) => ({ active: path, cursor: path, recent: touchRecent(s.recent, path) }));
    persist(get());
  },

  closeTab: (path) => {
    get().closeTabs([path]);
  },

  closeTabs: (paths) => {
    const before = get().tabs;
    set((s) => {
      const r = closeTabsPure({ tabs: s.tabs, recent: s.recent }, paths, s.active);
      if (r.tabs.length === s.tabs.length) return {};
      return { tabs: r.tabs, recent: r.recent, active: r.active };
    });
    released(before, get().tabs);
    persist(get());
  },

  closeOtherTabs: (path) => {
    const before = get().tabs;
    set({ tabs: [path], recent: [path], active: path });
    released(before, get().tabs);
    persist(get());
  },

  closeTabsToRight: (path) => {
    const before = get().tabs;
    set((s) => {
      const i = s.tabs.indexOf(path);
      if (i === -1) return {};
      const tabs = s.tabs.slice(0, i + 1);
      const keep = new Set(tabs);
      const active = s.active && keep.has(s.active) ? s.active : path;
      return { tabs, recent: s.recent.filter((p) => keep.has(p)), active };
    });
    released(before, get().tabs);
    persist(get());
  },

  closeAllTabs: () => {
    const before = get().tabs;
    set({ tabs: [], recent: [], active: null });
    released(before, get().tabs);
    persist(get());
  },

  cycleTab: (dir) => {
    const { tabs, active } = get();
    if (tabs.length < 2 || !active) return;
    const i = tabs.indexOf(active);
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    get().setActive(next);
  },

  setCursor: (path) => set({ cursor: path }),

  setMdMode: (path, mode) => set((s) => ({ mdMode: { ...s.mdMode, [path]: mode } })),

  remapPaths: (from, to) => {
    set((s) => {
      const map = (p: string) => remapPath(p, from, to) ?? p;
      const mdMode: Record<string, MdMode> = {};
      for (const [p, m] of Object.entries(s.mdMode)) mdMode[map(p)] = m;
      return {
        tabs: s.tabs.map(map),
        recent: s.recent.map(map),
        active: s.active === null ? null : map(s.active),
        cursor: s.cursor === null ? null : map(s.cursor),
        expanded: new Set([...s.expanded].map(map)),
        mdMode,
      };
    });
    persist(get());
  },

  forgetUnder: (dir) => {
    get().closeTabs(get().tabs.filter((t) => isUnder(t, dir)));
    set((s) => ({
      expanded: new Set([...s.expanded].filter((p) => !isUnder(p, dir))),
      cursor: s.cursor !== null && isUnder(s.cursor, dir) ? null : s.cursor,
    }));
    persist(get());
  },

  setSearchOpen: (open, armRecent = false) =>
    set({ searchOpen: open, searchArmRecent: open ? armRecent : false }),

  setRecentMinutes: (minutes) => {
    set({ recentMinutes: clampMinutes(minutes) });
    persist(get());
  },

  toggleSidebar: () => {
    const shown = !get().sidebarShown;
    writeSidebarShown(shown);
    set({ sidebarShown: shown });
  },

  setIndexStats: (mountId, stats) => {
    if (get().mount?.id === mountId) set({ indexStats: stats });
  },

  applyChanges: (mountId, changes, rescan = false, stats = null) => {
    const s = get();
    if (s.mount?.id !== mountId) return;
    if (stats) set({ indexStats: stats });
    if (rescan) {
      // The watcher gave up on listing the batch: re-list every loaded
      // folder and reload whatever is on screen.
      void s.reloadTree();
      set((st) => ({ reloadNonce: st.reloadNonce + 1 }));
      return;
    }
    void s.refreshFolders(implicatedFolders(changes));
    const removed = new Set(changes.filter((c) => c.kind === "removed").map((c) => c.path));
    const modified = new Set(changes.filter((c) => c.kind === "modified").map((c) => c.path));
    // A folder that vanished takes its open files with it.
    const removedDirs = [...removed];
    const gone = s.tabs.filter((t) => removed.has(t) || removedDirs.some((r) => t.startsWith(r + "/")));
    // A note holding unsaved text keeps its tab (it says so in its banner);
    // everything else closes as before.
    const kept = gone.filter((t) => notes.onRemoved(t));
    const closing = gone.filter((t) => !kept.includes(t));
    if (closing.length > 0) {
      s.closeTabs(closing);
      if (closing.length <= 3) for (const t of closing) toast(`${t} was removed on disk`, "neutral");
      else toast(`${closing.length} open files were removed on disk`, "neutral");
    }
    // Neutral, not sticky: the tab's red dot and banner stay until it is settled.
    for (const t of kept) toast(`${basename(t)} was deleted on disk. Your unsaved text is still open.`, "neutral");
    if (s.active && modified.has(s.active)) set((st) => ({ reloadNonce: st.reloadNonce + 1 }));
  },
}));

/** Tabs that were in `before` and are not in `after` just closed: save their
 *  notes and forget each one's mode. */
function released(before: string[], after: string[]) {
  if (before.length === after.length && before.every((t, i) => after[i] === t)) return;
  const still = new Set(after);
  const closed = before.filter((t) => !still.has(t));
  if (closed.length === 0) return;
  notes.release(closed, (p) => useStore.getState().tabs.includes(p));
  const mdMode = { ...useStore.getState().mdMode };
  for (const t of closed) delete mdMode[t];
  useStore.setState({ mdMode });
}

/**
 * Before the open mount goes away (a switch, a removal, the window closing):
 * save every open note. If some cannot be saved (changed or deleted on disk,
 * or unwritable), ask before their text is thrown away. False means stay.
 * The sessions themselves are dropped by whoever actually leaves, so a
 * cancelled folder picker leaves every note intact.
 */
export async function settleNotes(action: "switch" | "close"): Promise<boolean> {
  const failed = await notes.flushAll();
  if (failed.length === 0) return true;
  const names = failed.map(basename).join(", ");
  return confirmDialog({
    title: failed.length === 1 ? "A note is not saved" : `${failed.length} notes are not saved`,
    body: `${names} ${failed.length === 1 ? "has" : "have"} changes that could not be written. ${
      action === "close" ? "Close anyway" : "Leave this folder anyway"
    } and discard them?`,
    confirmLabel: action === "close" ? "Discard and close" : "Discard and leave",
    danger: true,
  });
}

/** Make `mount` the open one: restore its view state and list its root. */
async function activate(mount: Mount) {
  flushPersist();
  notes.discardAll();
  const st = useStore.getState();
  const view = readViewState(mount.id);
  useStore.setState({
    mount,
    opening: true,
    root: [],
    expanded: new Set(view.expanded),
    loading: new Set(),
    tabs: view.tabs,
    recent: [],
    active: view.active && view.tabs.includes(view.active) ? view.active : view.tabs[0] ?? null,
    cursor: view.active,
    indexStats: null,
    searchOpen: false,
    searchArmRecent: false,
    recentMinutes: view.recentMinutes,
    mdMode: {},
  });
  try {
    await st.loadChildren("");
    // Re-open what was expanded, shallowest first, so each parent exists
    // before its child is listed.
    const dirs = [...view.expanded].sort((a, b) => a.split("/").length - b.split("/").length);
    for (const d of dirs) {
      if (useStore.getState().mount?.id !== mount.id) return;
      if (findNode(useStore.getState().root, d)) await st.loadChildren(d);
    }
    const stats = await ipc.indexStatus(mount.id).catch(() => null);
    if (stats && useStore.getState().mount?.id === mount.id) useStore.setState({ indexStats: stats });
  } finally {
    if (useStore.getState().mount?.id === mount.id) useStore.setState({ opening: false });
  }
}
