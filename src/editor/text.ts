// A note's text on disk versus in the editor. Pure: no CodeMirror, no Tauri.
//
// CodeMirror keeps every line ending as "\n" and has no idea a file started
// with a BOM. The session records both on the way in and puts them back on
// the way out, so an edit changes only the lines that were edited.

export type Eol = "\n" | "\r\n";

export interface DiskShape {
  eol: Eol;
  bom: boolean;
}

const BOM = "﻿";

/** The editor's view of a file: BOM stripped, every ending as "\n", plus the
 *  shape to write it back in. The dominant ending wins (CRLF when CRLF lines
 *  outnumber lone-LF lines), so a file with mixed endings is normalized to its
 *  majority on the first save. */
export function fromDisk(raw: string): { text: string; shape: DiskShape } {
  const bom = raw.startsWith(BOM);
  const body = bom ? raw.slice(1) : raw;
  let crlf = 0;
  let lf = 0;
  for (let i = body.indexOf("\n"); i !== -1; i = body.indexOf("\n", i + 1)) {
    if (i > 0 && body.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return {
    text: body.replace(/\r\n?/g, "\n"),
    shape: { eol: crlf > lf ? "\r\n" : "\n", bom },
  };
}

/** The shape to keep once the disk's text is accepted (adopted, reloaded,
 *  or found equal): the disk's, so a file someone converted from CRLF to LF
 *  is not converted back by the next save. A text with no line break says
 *  nothing about endings, so the current one stands. */
export function adoptShape(current: DiskShape, disk: DiskShape, diskText: string): DiskShape {
  return { eol: diskText.includes("\n") ? disk.eol : current.eol, bom: disk.bom };
}

/** The bytes-to-be for editor text, in the file's own shape. */
export function toDisk(text: string, shape: DiskShape): string {
  const body = shape.eol === "\n" ? text : text.replace(/\n/g, "\r\n");
  return shape.bom ? BOM + body : body;
}

/** The smallest single replacement that turns `a` into `b`: common prefix and
 *  suffix kept, the middle swapped. Applying a disk change this way keeps the
 *  cursor and scroll where they were instead of resetting the document. */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  const min = Math.min(a.length, b.length);
  let start = 0;
  while (start < min && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

/**
 * What a fresh read of the file means for an open note.
 *
 * - `same`: the disk holds what the note last saved, or the save in flight.
 *   Our own write, echoed back by the watcher.
 * - `converged`: someone else wrote exactly the text the editor has.
 * - `adopt`: someone else changed the file and the note has no unsaved
 *   edits, so the new text replaces the old in place.
 * - `conflict`: someone else changed the file under unsaved edits. Never
 *   resolved silently.
 */
export type Reconcile = "same" | "converged" | "adopt" | "conflict";

export function reconcile(
  note: { baseline: string; doc: string; inFlight: string | null },
  disk: string,
): Reconcile {
  if (disk === note.baseline || disk === note.inFlight) return "same";
  if (disk === note.doc) return "converged";
  if (note.doc === note.baseline) return "adopt";
  return "conflict";
}
