import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isEditing, resolveMode, toggledMode, type MdMode } from "../editor/modes";
import * as notes from "../editor/sessions";
import { useNotes, type NoteInfo, type NoteStatus } from "../editor/sessions";
import { splitFrontMatter } from "../lib/frontmatter";
import * as ipc from "../lib/ipc";
import { MARKDOWN_RENDER_CAP, renderMarkdown } from "../lib/markdown";
import { dirname, formatBytes, joinAbs } from "../lib/paths";
import { readEditMode, writeEditMode } from "../lib/prefs";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import type { ViewProps } from "./Preview";
import { ReadingWidthHandles } from "./ReadingWidthHandles";
import { TextViewer } from "./TextViewer";
import { useTextFile } from "./useFile";
import { useReadingWidth } from "./useReadingWidth";

// The editor (CodeMirror) loads on first use, so reading costs nothing new.
const NoteEditor = lazy(() => import("../editor/NoteEditor"));

/** Split's live preview re-renders at most this often while typing. */
const LIVE_RENDER_MS = 150;

/** Ctrl+E for the Markdown view on screen, if one is. */
let toggleActive: (() => void) | null = null;

/** Flip the active Markdown tab between Preview and editing. False when the
 *  active tab is not Markdown. */
export function toggleMarkdownMode(): boolean {
  if (!toggleActive) return false;
  toggleActive();
  return true;
}

const SAVE_LABEL: Record<NoteStatus, string> = {
  clean: "Saved",
  dirty: "Unsaved",
  saving: "Saving…",
  conflict: "Not saved",
  error: "Save failed",
};

/**
 * Markdown: rendered, edited, or both side by side. A file that was read in
 * full and is valid UTF-8 offers Preview, Edit and Split; anything else keeps
 * the read-only Source view (see `resolveMode`). Editing goes through the
 * file's note session, which autosaves and guards against overwriting a file
 * that changed on disk (`editor/sessions.ts`).
 *
 * A document past MARKDOWN_RENDER_CAP is not rendered until asked; the
 * editor and Source are instant at any size.
 */
export function MarkdownView({ mountId, mountPath, path, nonce }: ViewProps) {
  const file = useTextFile(mountId, path, nonce);
  const chosen = useStore((s) => s.mdMode[path]);
  const info = useNotes((s) => s.notes[path]);
  const [wrap, setWrap] = useState(true);
  const [forced, setForced] = useState(false);
  // The open note's text, when there is one: what Preview and Split render.
  const [live, setLive] = useState<string | null>(() => notes.sessionText(path));
  const previewRef = useRef<HTMLDivElement | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  const liveTimer = useRef<number | null>(null);
  const reading = useReadingWidth();

  const ready = file.state === "ready" ? file.value : null;
  const hasNote = info !== undefined;
  // An open note stays editable even if the disk now holds something that is
  // not (its banner offers the way out); otherwise the read decides.
  const editable = hasNote || (ready !== null && !ready.truncated && !ready.lossy);
  const text = live ?? ready?.text ?? "";
  const big = text.length > MARKDOWN_RENDER_CAP;
  const mode = resolveMode(chosen, editable, big);
  const render = (mode === "preview" || mode === "split") && (!big || forced);

  // Every fresh read passes through the open note before it is shown: our
  // own save echoing back changes nothing, another writer's text is adopted
  // or becomes a conflict.
  useEffect(() => {
    if (!ready) return;
    notes.observeDisk(path, ready);
    setLive(notes.sessionText(path));
  }, [ready, path]);

  const onEdit = useCallback(() => {
    if (liveTimer.current !== null) return;
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = null;
      setLive(notes.sessionText(path));
    }, LIVE_RENDER_MS);
  }, [path]);

  useEffect(
    () => () => {
      if (liveTimer.current !== null) window.clearTimeout(liveTimer.current);
    },
    [],
  );

  const setMode = useCallback(
    (next: MdMode) => {
      if (isEditing(next)) writeEditMode(next);
      else void notes.flush(path);
      setLive(notes.sessionText(path));
      useStore.getState().setMdMode(path, next);
    },
    [path],
  );

  const loaded = ready !== null || hasNote;
  useEffect(() => {
    if (!loaded) return;
    toggleActive = () => setMode(toggledMode(mode, editable, readEditMode()));
    return () => {
      toggleActive = null;
    };
  }, [loaded, mode, editable, setMode]);

  const rendered = useMemo(() => {
    if (!render || !loaded) return null;
    const { fields, body } = splitFrontMatter(text);
    const html = renderMarkdown(body, {
      baseDir: dirname(path),
      resolveAsset: (rel) => ipc.assetUrl(joinAbs(mountPath, rel)),
    });
    // One object per render result, so React never re-assigns innerHTML
    // for a state change elsewhere in this component.
    return { fields, html: { __html: html } };
  }, [text, path, mountPath, render, loaded]);

  useEffect(() => {
    previewRef.current?.scrollTo({ top: 0 });
  }, [path]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const st = useStore.getState();
    if (a.dataset.external) {
      e.preventDefault();
      void ipc.openExternal(a.getAttribute("href") ?? "").catch(() => {
        toast("Could not open that link", "error");
      });
    } else if (a.dataset.relpath !== undefined) {
      e.preventDefault();
      const rel = a.dataset.relpath;
      if (rel) {
        void st.revealPath(rel);
        st.openFile(rel);
      }
    } else if (a.dataset.anchor !== undefined) {
      e.preventDefault();
      const id = a.dataset.anchor;
      const target = previewRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
      target?.scrollIntoView({ block: "start" });
    } else if (a.dataset.wikilink !== undefined) {
      e.preventDefault();
      const name = a.dataset.wikilink.split("#")[0].split("|")[0];
      void ipc
        .searchNames(mountId, name)
        .then(({ hits }) => {
          const wanted = name.toLowerCase();
          const hit =
            hits.find((h) => !h.isDir && h.name.toLowerCase() === `${wanted}.md`) ??
            hits.find((h) => !h.isDir && h.name.toLowerCase().replace(/\.[^.]+$/, "") === wanted) ??
            hits.find((h) => !h.isDir);
          if (!hit) {
            toast(`No file named "${name}" in this mount`, "neutral");
            return;
          }
          void st.revealPath(hit.path);
          st.openFile(hit.path);
        })
        .catch(() => toast("Search is not ready yet", "neutral"));
    }
  };

  if (!loaded) {
    if (file.state === "error") return <div className="preview-status error">{file.message}</div>;
    return <div className="preview-status">Loading…</div>;
  }

  const bytes = ready?.bytes ?? text.length;
  const editor = (split: boolean) => (
    <Suspense fallback={<div className="preview-status">Loading editor…</div>}>
      <NoteEditor
        mountId={mountId}
        path={path}
        file={ready}
        reading={split ? undefined : reading}
        onEdit={split ? onEdit : undefined}
      />
    </Suspense>
  );

  const preview = (split: boolean) => {
    if (!render) {
      return (
        <div className="empty-view">
          <div className="empty-card">
            <div className="empty-title">Large document</div>
            <div className="empty-sub">
              {formatBytes(bytes)} of Markdown. Rendering it all at once can take a while;{" "}
              {split ? "the editor beside it is instant." : editable ? "the editor is instant." : "the Source view is instant."}
            </div>
            <div className="binary-actions">
              <button className="btn primary" onClick={() => setForced(true)}>
                Render anyway
              </button>
              {!split && (
                <button className="btn" onClick={() => setMode(editable ? readEditMode() : "source")}>
                  {editable ? "Edit" : "View source"}
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    const full = split || reading.width.full;
    return (
      <div className="doc-scroll" ref={previewRef} onClick={onClick}>
        <article
          className={`markdown${full ? " full" : ""}`}
          ref={split ? undefined : articleRef}
          style={
            split || reading.width.px === null
              ? undefined
              : ({ "--reading-w": `${reading.width.px}px` } as React.CSSProperties)
          }
        >
          {!split && (
            <ReadingWidthHandles
              width={reading.width}
              articleRef={articleRef}
              onWidth={reading.set}
              onCommit={reading.commit}
            />
          )}
          {rendered && rendered.fields.length > 0 && (
            <dl className="frontmatter">
              {rendered.fields.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="markdown-body" dangerouslySetInnerHTML={rendered?.html ?? EMPTY_HTML} />
        </article>
      </div>
    );
  };

  return (
    <div className="doc-view">
      <div className="preview-toolbar">
        <div className="segmented">
          <button
            className={mode === "preview" ? "on" : ""}
            title="Rendered (Ctrl+E switches)"
            onClick={() => setMode("preview")}
          >
            Preview
          </button>
          {editable ? (
            <>
              <button className={mode === "edit" ? "on" : ""} title="Edit (Ctrl+E switches)" onClick={() => setMode("edit")}>
                Edit
              </button>
              <button
                className={mode === "split" ? "on" : ""}
                title="Edit beside a live preview"
                onClick={() => setMode("split")}
              >
                Split
              </button>
            </>
          ) : (
            <button className={mode === "source" ? "on" : ""} onClick={() => setMode("source")}>
              Source
            </button>
          )}
        </div>
        {mode === "source" && (
          <label className="check">
            <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
            Wrap
          </label>
        )}
        {(mode === "edit" || (mode === "preview" && render)) && (
          <label
            className="check"
            title="Fill the pane. Drag either edge of the column for a custom width, double-click an edge to reset."
          >
            <input
              type="checkbox"
              checked={reading.width.full}
              onChange={(e) => reading.commit({ full: e.target.checked })}
            />
            Full width
          </label>
        )}
        <span className="preview-meta">
          {info && (
            <span className={`save-state ${info.status}`} title={info.error ?? undefined}>
              {SAVE_LABEL[info.status]}
            </span>
          )}
          {formatBytes(bytes)}
          {big && mode !== "edit" && <span className="preview-flag">large document</span>}
          {ready?.truncated && <span className="preview-flag">first 4 MB, read-only</span>}
          {ready && ready.lossy && !ready.truncated && <span className="preview-flag">not UTF-8, read-only</span>}
        </span>
      </div>
      {info && <NoteBanner path={path} info={info} />}
      {mode === "source" ? (
        <TextViewer text={ready?.text ?? text} lang="markdown" wrap={wrap} />
      ) : mode === "edit" ? (
        editor(false)
      ) : mode === "split" ? (
        <div className="split">
          <div className="split-pane">{editor(true)}</div>
          <div className="split-pane">{preview(true)}</div>
        </div>
      ) : (
        preview(false)
      )}
    </div>
  );
}

/** What stands between the note and the disk, and the ways out. */
function NoteBanner({ path, info }: { path: string; info: NoteInfo }) {
  const c = info.conflict;
  const discardAndReload = () => {
    notes.discard(path);
    const st = useStore.getState();
    st.setMdMode(path, "preview");
    useStore.setState({ reloadNonce: st.reloadNonce + 1 });
  };
  if (c?.kind === "changed") {
    return (
      <div className="note-banner" role="alert">
        <span className="note-banner-text">
          {c.text === null
            ? "This file changed on disk into something the editor cannot load (over 4 MB, or not UTF-8). Your text is not saved."
            : "This file changed on disk while you were editing. Your text is not saved yet."}
        </span>
        {c.text !== null && (
          <button className="btn sm" onClick={() => notes.reloadFromDisk(path)} title="Undo (Ctrl+Z) brings your text back">
            Reload from disk
          </button>
        )}
        <button className="btn sm" onClick={() => void notes.keepMine(path)}>
          Keep mine
        </button>
        {c.text === null && (
          <button className="btn sm" onClick={discardAndReload}>
            Discard my edits
          </button>
        )}
      </div>
    );
  }
  if (c?.kind === "deleted") {
    return (
      <div className="note-banner" role="alert">
        <span className="note-banner-text">This file was deleted on disk. Your text is still here.</span>
        <button className="btn sm" onClick={() => void notes.keepMine(path)}>
          Restore my copy
        </button>
        <button
          className="btn sm"
          onClick={() => {
            notes.discard(path);
            useStore.getState().closeTab(path);
          }}
        >
          Discard and close
        </button>
      </div>
    );
  }
  if (info.status === "error") {
    return (
      <div className="note-banner" role="alert">
        <span className="note-banner-text">Could not save: {info.error}</span>
        <button className="btn sm" onClick={() => void notes.retrySave(path)}>
          Retry
        </button>
      </div>
    );
  }
  return null;
}

const EMPTY_HTML = { __html: "" };
