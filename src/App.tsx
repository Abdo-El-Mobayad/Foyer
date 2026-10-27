import { useEffect } from "react";
import { DialogHost } from "./components/DialogHost";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { HeaderBar } from "./components/HeaderBar";
import { MountSwitcher } from "./components/MountSwitcher";
import { RecentTrigger, SearchOverlay } from "./components/SearchOverlay";
import { SidebarFooter } from "./components/SidebarFooter";
import { SidebarResizer } from "./components/SidebarResizer";
import { TabBar } from "./components/TabBar";
import { Toasts } from "./components/Toasts";
import { Tree } from "./components/Tree";
import { Welcome } from "./components/Welcome";
import { IconNewNote, IconSearch } from "./components/Icons";
import * as notes from "./editor/sessions";
import { dialogOpen } from "./lib/dialogs";
import { newNote, renameEntry } from "./lib/fileOps";
import * as ipc from "./lib/ipc";
import { joinAbs } from "./lib/paths";
import { toast } from "./lib/toast";
import { findNode } from "./lib/tree";
import { useSidebarWidth } from "./lib/useSidebarWidth";
import { toggleMarkdownMode } from "./preview/MarkdownView";
import { Preview } from "./preview/Preview";
import { settleNotes, useStore } from "./store";

export default function App() {
  const booting = useStore((s) => s.booting);
  const mount = useStore((s) => s.mount);
  const searchOpen = useStore((s) => s.searchOpen);
  const sidebarShown = useStore((s) => s.sidebarShown);
  const { width, setWidth } = useSidebarWidth();

  useEffect(() => {
    void useStore.getState().boot();
  }, []);

  // Rust events: the index finished, or files changed under the open mount.
  useEffect(() => {
    let disposed = false;
    const offs: Array<() => void> = [];
    void ipc.onIndexReady((e) => useStore.getState().setIndexStats(e.mountId, e.stats)).then((off) => {
      if (disposed) off();
      else offs.push(off);
    });
    void ipc.onFilesChanged((e) => useStore.getState().applyChanges(e.mountId, e.changes, e.rescan, e.stats)).then((off) => {
      if (disposed) off();
      else offs.push(off);
    });
    return () => {
      disposed = true;
      offs.forEach((off) => off());
    };
  }, []);

  // The index can finish before the listener above is attached (a small
  // mount builds in milliseconds), so poll while the stats are still unknown.
  const indexStats = useStore((s) => s.indexStats);
  useEffect(() => {
    if (!mount || indexStats) return;
    const id = window.setInterval(() => {
      const m = useStore.getState().mount;
      if (!m) return;
      void ipc
        .indexStatus(m.id)
        .then((stats) => {
          if (stats) useStore.getState().setIndexStats(m.id, stats);
        })
        .catch(() => undefined);
    }, 700);
    return () => window.clearInterval(id);
  }, [mount, indexStats]);

  // Notes save when the window loses focus, and before it closes. The close
  // handler is awaited; if a note cannot be saved the window stays open and
  // asks before its text is thrown away.
  useEffect(() => {
    const onBlur = () => void notes.flushAll();
    window.addEventListener("blur", onBlur);
    let disposed = false;
    let off: (() => void) | null = null;
    void ipc
      .onCloseRequested(async (e) => {
        if ((await notes.flushAll()).length === 0) return;
        e.preventDefault();
        if (await settleNotes("close")) {
          notes.discardAll();
          await ipc.destroyWindow();
        }
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else off = unlisten;
      });
    return () => {
      disposed = true;
      window.removeEventListener("blur", onBlur);
      off?.();
    };
  }, []);

  // Keyboard shortcuts. A key the editor already handled (its search, its
  // Ctrl+S, bold on Ctrl+B) arrives here default-prevented and is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || dialogOpen()) return;
      const st = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        if (e.key === "Escape" && st.searchOpen) st.setSearchOpen(false);
        else if (e.key === "F2" && st.mount && !st.searchOpen) {
          // The tree's cursor when the tree has focus, else the open file.
          e.preventDefault();
          const inTree = (document.activeElement as HTMLElement | null)?.closest?.(".tree");
          const target = inTree && st.cursor ? st.cursor : st.active;
          if (target) void renameEntry(target, findNode(st.root, target)?.isDir ?? false);
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "s" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void notes.flushAll();
      } else if (k === "e" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        toggleMarkdownMode();
      } else if (k === "n" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (st.mount) void newNote();
      } else if (k === "p" && e.shiftKey && !e.altKey) {
        // Same overlay, opened with the modified-within filter already on.
        e.preventDefault();
        if (st.mount) st.setSearchOpen(!st.searchOpen, true);
      } else if ((k === "p" || k === "f") && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (st.mount) st.setSearchOpen(!st.searchOpen);
      } else if (k === "o" && e.shiftKey) {
        e.preventDefault();
        if (!st.mount) return;
        const target = st.active ? joinAbs(st.mount.path, st.active) : st.mount.path;
        void ipc.openInVsCode(target, { newWindow: !st.active }).catch(() => {
          toast("Could not open VS Code. Is it installed?", "error");
        });
      } else if (k === "w") {
        e.preventDefault();
        if (st.active) st.closeTab(st.active);
      } else if (k === "b") {
        e.preventDefault();
        st.toggleSidebar();
      } else if (k === "r") {
        e.preventDefault();
        void st.reloadTree();
      } else if (e.key === "Tab") {
        e.preventDefault();
        st.cycleTab(e.shiftKey ? -1 : 1);
      } else if (k === "o" && !e.shiftKey) {
        e.preventDefault();
        void st.addMount();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The webview's own context menu (Reload, Inspect) is never what a
  // right-click here means; every surface that has a menu draws its own.
  useEffect(() => {
    const block = (e: MouseEvent) => {
      // Text fields and the note editor keep the native menu: cut, copy,
      // paste and spelling suggestions.
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
  }, []);

  if (booting) {
    return <div className="booting" />;
  }

  if (!mount) {
    return (
      <div className="app-shell">
        <Welcome />
        <Toasts />
        <DialogHost />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div
        className={`app${sidebarShown ? "" : " sidebar-hidden"}`}
        style={{ "--sidebar-w": `${width}px` } as React.CSSProperties}
      >
        {searchOpen && <SearchOverlay onClose={() => useStore.getState().setSearchOpen(false)} />}
        {sidebarShown && (
          <>
            <aside className="sidebar">
              <MountSwitcher />
              <div className="sidebar-search-row">
                <button className="search-trigger" onClick={() => useStore.getState().setSearchOpen(true)}>
                  <IconSearch />
                  <span>Search files</span>
                  <kbd>Ctrl P</kbd>
                </button>
                <RecentTrigger />
                <button
                  className="icon-btn"
                  title="New note (Ctrl+N)"
                  aria-label="New note"
                  onClick={() => void newNote()}
                >
                  <IconNewNote />
                </button>
              </div>
              <ErrorBoundary label="File tree">
                <Tree />
              </ErrorBoundary>
              <SidebarFooter />
            </aside>
            <SidebarResizer width={width} onWidth={setWidth} />
          </>
        )}
        <main className="main">
          <HeaderBar />
          <TabBar />
          <Preview />
        </main>
        <Toasts />
        <DialogHost />
      </div>
    </div>
  );
}
