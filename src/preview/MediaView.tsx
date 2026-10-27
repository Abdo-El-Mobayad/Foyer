import { useState } from "react";
import type { Kind } from "../lib/fileKinds";
import * as ipc from "../lib/ipc";
import { basename, formatBytes, formatDate, joinAbs } from "../lib/paths";
import { BinaryView } from "./BinaryView";
import type { ViewProps } from "./Preview";
import { useStat } from "./useFile";

/**
 * Byte caps for previews the asset handler serves in one read: an <img> or
 * an <iframe> fetches the whole file, and the handler reads all of it into
 * memory before answering (verified in tauri 2.11.5 asset.rs: only Range
 * requests are partial). Video and audio elements request byte ranges, so
 * they stream and carry no cap.
 */
export const IMAGE_CAP = 32 * 1024 * 1024;
export const PDF_CAP = 64 * 1024 * 1024;

export function mediaCap(kind: Kind): number | null {
  if (kind === "image") return IMAGE_CAP;
  if (kind === "pdf") return PDF_CAP;
  return null;
}

/** Images, PDFs, video and audio, served from disk through the asset protocol. */
export function MediaView({ mountId, mountPath, path, nonce, kind }: ViewProps & { kind: Kind }) {
  const src = ipc.assetUrl(joinAbs(mountPath, path));
  const stat = useStat(mountId, path, nonce);
  const [failed, setFailed] = useState(false);
  const name = basename(path);

  const cap = mediaCap(kind);
  if (cap !== null && stat.state === "loading") return <div className="preview-status">Loading…</div>;
  if (cap !== null && stat.state === "ready" && stat.value.size > cap) {
    return (
      <BinaryView
        mountId={mountId}
        mountPath={mountPath}
        path={path}
        nonce={nonce}
        reason={`${formatBytes(stat.value.size)} is past the ${formatBytes(cap)} in-app ${kind} limit.`}
      />
    );
  }

  return (
    <div className="doc-view">
      <div className="preview-toolbar">
        <span className="preview-meta">
          {kind}
          {stat.state === "ready" && (
            <>
              , {formatBytes(stat.value.size)}, modified {formatDate(stat.value.modified)}
            </>
          )}
        </span>
      </div>
      <div className={`media media-${kind}`}>
        {failed ? (
          <div className="preview-status error">Could not load {name}.</div>
        ) : kind === "image" ? (
          <img key={nonce} src={src} alt={name} onError={() => setFailed(true)} />
        ) : kind === "pdf" ? (
          <iframe key={nonce} src={src} title={name} className="pdf-frame" />
        ) : kind === "video" ? (
          <video key={nonce} src={src} controls onError={() => setFailed(true)} />
        ) : (
          <audio key={nonce} src={src} controls onError={() => setFailed(true)} />
        )}
      </div>
    </div>
  );
}
