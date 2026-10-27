import { useMemo, useState } from "react";
import { parseCsvBounded } from "../lib/csv";
import { formatBytes } from "../lib/paths";
import { shapeTable } from "../lib/tableModel";
import type { ViewProps } from "./Preview";
import { TableView } from "./TableView";
import { TextViewer } from "./TextViewer";
import { useTextFile } from "./useFile";

/** CSV and TSV as a table. The delimiter is auto-detected. */
export function CsvView({ mountId, path, nonce }: ViewProps) {
  const file = useTextFile(mountId, path, nonce);
  const [headerRow, setHeaderRow] = useState(true);
  const [raw, setRaw] = useState(false);
  const [wrap, setWrap] = useState(true);

  const parsed = useMemo(() => {
    if (file.state !== "ready") return null;
    return parseCsvBounded(file.value.text, { tsv: path.toLowerCase().endsWith(".tsv") });
  }, [file, path]);

  const data = useMemo(() => {
    if (!parsed) return null;
    const header = headerRow ? (parsed.rows[0] ?? []) : [];
    const body = headerRow ? parsed.rows.slice(1) : parsed.rows;
    const total = headerRow ? Math.max(0, parsed.total - 1) : parsed.total;
    return shapeTable(header, body, total);
  }, [parsed, headerRow]);

  if (file.state === "loading") return <div className="preview-status">Loading…</div>;
  if (file.state === "error") return <div className="preview-status error">{file.message}</div>;
  if (!parsed || !data) return null;

  return (
    <div className="doc-view">
      <div className="preview-toolbar">
        <div className="segmented">
          <button className={!raw ? "on" : ""} onClick={() => setRaw(false)}>
            Table
          </button>
          <button className={raw ? "on" : ""} onClick={() => setRaw(true)}>
            Raw
          </button>
        </div>
        {raw ? (
          <label className="check">
            <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
            Wrap
          </label>
        ) : (
          <label className="check">
            <input type="checkbox" checked={headerRow} onChange={(e) => setHeaderRow(e.target.checked)} />
            First row is the header
          </label>
        )}
        <span className="preview-meta">
          {formatBytes(file.value.bytes)}, {parsed.delimiter}-separated
          {file.value.truncated && <span className="preview-flag">showing the first 4 MB</span>}
        </span>
      </div>
      {raw ? <TextViewer text={file.value.text} lang={null} wrap={wrap} /> : <TableView data={data} />}
    </div>
  );
}
