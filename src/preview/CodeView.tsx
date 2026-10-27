import { useMemo, useState } from "react";
import { languageOf, looksBinary } from "../lib/fileKinds";
import { formatBytes } from "../lib/paths";
import { countLines } from "../lib/textRows";
import { BinaryView } from "./BinaryView";
import type { ViewProps } from "./Preview";
import { HIGHLIGHT_CAP, isVirtualized, TextViewer } from "./TextViewer";
import { useTextFile } from "./useFile";

/** Source and plain text with a line-number gutter and syntax colors. */
export function CodeView({ mountId, mountPath, path, nonce, plain }: ViewProps & { plain: boolean }) {
  const file = useTextFile(mountId, path, nonce);
  const [wrap, setWrap] = useState(plain);
  const lang = languageOf(path);

  const info = useMemo(() => {
    if (file.state !== "ready") return null;
    const text = file.value.text;
    if (looksBinary(text)) return { binary: true as const };
    return {
      binary: false as const,
      lines: countLines(text),
      highlighted: Boolean(lang) && text.length <= HIGHLIGHT_CAP,
      virtual: isVirtualized(text.length),
    };
  }, [file, lang]);

  if (file.state === "loading") return <div className="preview-status">Loading…</div>;
  if (file.state === "error") return <div className="preview-status error">{file.message}</div>;
  if (!info) return null;
  if (info.binary) return <BinaryView mountId={mountId} mountPath={mountPath} path={path} nonce={nonce} />;

  return (
    <div className="doc-view">
      <div className="preview-toolbar">
        <span className="preview-meta">
          {lang ?? "text"}, {info.lines.toLocaleString("en-US")} lines, {formatBytes(file.value.bytes)}
          {!info.highlighted && lang && <span className="preview-flag">too large to highlight</span>}
          {info.virtual && <span className="preview-flag">large file view</span>}
          {file.value.truncated && <span className="preview-flag">showing the first 4 MB</span>}
        </span>
        <label className="check">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
          Wrap
        </label>
      </div>
      <TextViewer text={file.value.text} lang={lang} wrap={wrap} />
    </div>
  );
}
