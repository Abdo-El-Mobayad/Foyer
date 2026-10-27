import { useEffect, useRef, useState } from "react";
import { formatBytes } from "../lib/paths";
import { shapeTable, type TableData } from "../lib/tableModel";
import type { ViewProps } from "./Preview";
import type { SheetRequest, SheetResponse } from "./sheet.worker";
import { TableView } from "./TableView";
import { useBytesFile } from "./useFile";

type Book =
  | { state: "parsing" }
  | { state: "ready"; sheetNames: string[] }
  | { state: "error"; message: string };

/**
 * Excel and OpenDocument workbooks, one tab per sheet. Parsing runs in a
 * worker (one per open workbook, dropped with the view), so a slow workbook
 * costs a spinner, not a frozen window.
 */
export function SheetView({ mountId, path, nonce }: ViewProps) {
  const file = useBytesFile(mountId, path, nonce);
  const [sheet, setSheet] = useState(0);
  const [book, setBook] = useState<Book>({ state: "parsing" });
  const [table, setTable] = useState<TableData | null>(null);
  const worker = useRef<Worker | null>(null);
  const seq = useRef(0);

  // One worker per loaded file. Its parsed workbook lives there until the
  // view goes away or the file reloads.
  useEffect(() => {
    if (file.state !== "ready") return;
    const w = new Worker(new URL("./sheet.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    setBook({ state: "parsing" });
    setTable(null);
    const id = ++seq.current;
    w.onmessage = (e: MessageEvent<SheetResponse>) => {
      const msg = e.data;
      if (msg.type === "loaded") setBook({ state: "ready", sheetNames: msg.sheetNames });
      else if (msg.type === "sheet") setTable(shapeTable(msg.rows[0] ?? [], msg.rows.slice(1), Math.max(0, msg.total - 1)));
      else setBook({ state: "error", message: msg.message });
    };
    w.onerror = (e) => setBook({ state: "error", message: e.message || "worker failed" });
    // The buffer is copied to the worker; the main thread keeps its own so a
    // reload of the same bytes needs no second IPC read.
    const bytes = file.value.buffer.slice(file.value.byteOffset, file.value.byteOffset + file.value.byteLength) as ArrayBuffer;
    w.postMessage({ type: "load", id, bytes } satisfies SheetRequest, [bytes]);
    return () => {
      w.terminate();
      if (worker.current === w) worker.current = null;
    };
  }, [file]);

  useEffect(() => {
    if (book.state !== "ready" || !worker.current) return;
    const index = Math.min(sheet, book.sheetNames.length - 1);
    worker.current.postMessage({ type: "sheet", id: ++seq.current, index } satisfies SheetRequest);
  }, [book, sheet]);

  if (file.state === "loading") return <div className="preview-status">Loading…</div>;
  if (file.state === "error") return <div className="preview-status error">{file.message}</div>;
  if (book.state === "error") {
    return <div className="preview-status error">Could not read this workbook: {book.message}</div>;
  }
  if (book.state === "parsing") return <div className="preview-status">Parsing workbook…</div>;

  return (
    <div className="doc-view">
      <div className="preview-toolbar">
        <div className="segmented sheet-tabs">
          {book.sheetNames.map((name, i) => (
            <button key={name} className={i === sheet ? "on" : ""} onClick={() => setSheet(i)} title={name}>
              {name}
            </button>
          ))}
        </div>
        <span className="preview-meta">{formatBytes(file.value.byteLength)}</span>
      </div>
      {table ? (
        <TableView data={table} note="first row shown as the header" />
      ) : (
        <div className="preview-status">Reading sheet…</div>
      )}
    </div>
  );
}
