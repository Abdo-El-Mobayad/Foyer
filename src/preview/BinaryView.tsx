import * as ipc from "../lib/ipc";
import { basename, extOf, formatBytes, formatDate, joinAbs } from "../lib/paths";
import { toast } from "../lib/toast";
import { IconFolderOpen, IconVsCode } from "../components/Icons";
import type { ViewProps } from "./Preview";
import { useStat } from "./useFile";

/** A file the app cannot render (or will not, past a size cap): say what it
 *  is and offer the exits. */
export function BinaryView({ mountId, mountPath, path, nonce, reason }: ViewProps & { reason?: string }) {
  const stat = useStat(mountId, path, nonce);
  const abs = joinAbs(mountPath, path);
  const ext = extOf(path);
  return (
    <div className="empty-view">
      <div className="empty-card binary-card">
        <div className="binary-ext">{ext ? ext.toUpperCase() : "FILE"}</div>
        <div className="empty-title">{basename(path)}</div>
        <div className="empty-sub">
          {stat.state === "ready"
            ? `${formatBytes(stat.value.size)}, modified ${formatDate(stat.value.modified)}`
            : stat.state === "error"
              ? stat.message
              : ""}
        </div>
        <p className="binary-note">{reason ?? "No in-app preview for this format."}</p>
        <div className="binary-actions">
          <button
            className="btn primary"
            onClick={() =>
              void ipc.openInVsCode(abs).catch(() => toast("Could not open VS Code. Is it installed?", "error"))
            }
          >
            <IconVsCode />
            Open in VS Code
          </button>
          <button
            className="btn"
            onClick={() =>
              void ipc.openInDefaultApp(mountId, path).catch(() => toast("Could not open that with its default app", "error"))
            }
          >
            Open in default app
          </button>
          <button
            className="btn"
            onClick={() => void ipc.revealInFileManager(abs).catch(() => toast("Could not show that in Explorer", "error"))}
          >
            <IconFolderOpen />
            Show in Explorer
          </button>
        </div>
      </div>
    </div>
  );
}
