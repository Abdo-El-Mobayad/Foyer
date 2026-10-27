import { useCallback, useState } from "react";
import * as ipc from "../lib/ipc";
import { formatBytes, joinAbs } from "../lib/paths";
import type { ViewProps } from "./Preview";
import { TextViewer } from "./TextViewer";
import { useStat, useTextFile } from "./useFile";

/** An HTML file past this opens in Source; the asset handler reads a whole
 *  file into memory for a page load, and a page this size is a data dump,
 *  not a document. One click loads it anyway. */
export const HTML_PREVIEW_CAP = 16 * 1024 * 1024;

/**
 * An HTML page rendered as a real document, loaded by URL through the asset
 * protocol so it has a base to resolve sibling files against. Scripts run
 * by default (a dashboard without its charts is not a preview); same-origin
 * is withheld, so the page executes on an opaque origin and cannot reach
 * the app, its storage, or the IPC bridge. The Scripts toggle turns them off
 * for a page that should not be running anything.
 *
 * A page that links to its siblings navigates inside the frame, the way it
 * would in a browser. Back and Forward drive the JOINT session history, which
 * is where those in-frame navigations land; the parent cannot read the frame's
 * location across origins, so this is how the app steers it without weakening
 * the sandbox or rewriting the page. Each file gets a fresh frame (the `key`
 * below), so a file's history cannot reach back into the file viewed before it.
 * Reset returns to the file the tab is actually on, whatever the page did.
 */
export function HtmlView({ mountId, mountPath, path, nonce }: ViewProps) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [scripts, setScripts] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [forced, setForced] = useState(false);
  // Bumped by Reset to rebuild the frame at this tab's own file.
  const [reset, setReset] = useState(0);
  const back = useCallback(() => window.history.back(), []);
  const forward = useCallback(() => window.history.forward(), []);
  const stat = useStat(mountId, path, nonce);
  const src = ipc.assetUrl(joinAbs(mountPath, path));
  const size = stat.state === "ready" ? stat.value.size : 0;
  const big = size > HTML_PREVIEW_CAP;
  const sandbox = `${scripts ? "allow-scripts " : ""}allow-forms allow-popups allow-modals`;
  return (
    <div className="doc-view">
      <div className="preview-toolbar">
        <div className="segmented">
          <button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>
            Preview
          </button>
          <button className={mode === "source" ? "on" : ""} onClick={() => setMode("source")}>
            Source
          </button>
        </div>
        {mode === "preview" ? (
          <>
            <span className="segmented">
              <button onClick={back} title="Back (in-page navigation)" aria-label="Back">
                ‹
              </button>
              <button onClick={forward} title="Forward (in-page navigation)" aria-label="Forward">
                ›
              </button>
            </span>
            <button className="btn" onClick={() => setReset((n) => n + 1)} title={`Reload ${path}`}>
              Reset
            </button>
            <label className="check">
              <input type="checkbox" checked={scripts} onChange={(e) => setScripts(e.target.checked)} />
              Scripts
            </label>
          </>
        ) : (
          <label className="check">
            <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
            Wrap
          </label>
        )}
        <span className="preview-meta">
          {mode === "preview" ? `isolated frame, scripts ${scripts ? "on" : "off"}` : "source"}
          {size > 0 && `, ${formatBytes(size)}`}
        </span>
      </div>
      {mode === "source" ? (
        <HtmlSource mountId={mountId} path={path} nonce={nonce} wrap={wrap} />
      ) : stat.state === "loading" ? (
        <div className="preview-status">Loading…</div>
      ) : big && !forced ? (
        <div className="empty-view">
          <div className="empty-card">
            <div className="empty-title">Large page</div>
            <div className="empty-sub">{formatBytes(size)} of HTML. Loading it as a page reads all of it into memory.</div>
            <div className="binary-actions">
              <button className="btn primary" onClick={() => setForced(true)}>
                Load anyway
              </button>
              <button className="btn" onClick={() => setMode("source")}>
                View source
              </button>
            </div>
          </div>
        </div>
      ) : (
        <iframe
          key={`${path}:${nonce}:${scripts}:${reset}`}
          className="html-frame"
          title={path}
          src={src}
          sandbox={sandbox}
        />
      )}
    </div>
  );
}

function HtmlSource({ mountId, path, nonce, wrap }: { mountId: string; path: string; nonce: number; wrap: boolean }) {
  const file = useTextFile(mountId, path, nonce);
  if (file.state === "loading") return <div className="preview-status">Loading…</div>;
  if (file.state === "error") return <div className="preview-status error">{file.message}</div>;
  return <TextViewer text={file.value.text} lang="xml" wrap={wrap} />;
}
