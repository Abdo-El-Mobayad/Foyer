// Open notes. A session is one Markdown file being edited: its CodeMirror
// state (document, selection, undo history), the text believed to be on disk,
// and its autosave. Sessions live here, outside React, so a tab switch never
// loses a pending save or the undo history, and a note that failed to save
// outlives its tab until it is saved or explicitly discarded.
//
// React reads only `useNotes`, each note's save status, for the tab strip and
// the toolbar. It changes on transitions (clean to dirty, saving, conflict),
// never per keystroke.

import { Annotation, Transaction, type EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { create } from "zustand";
import * as ipc from "../lib/ipc";
import { isUnder, remapPath } from "../lib/names";
import { basename } from "../lib/paths";
import { toast } from "../lib/toast";
import { adoptShape, fromDisk, minimalChange, reconcile, toDisk, type DiskShape } from "./text";

/** Quiet period after the last keystroke before a note is written. */
export const AUTOSAVE_MS = 1000;
/** Saves retried after a refusal that turned out to be a mere touch. */
const MAX_TOUCH_RETRIES = 2;

export type NoteStatus = "clean" | "dirty" | "saving" | "conflict" | "error";

/** Why a note will not be saved until the user decides. `text` is the disk's
 *  version, or null when the disk now holds something the editor cannot load
 *  (over 4 MB, or not UTF-8). */
export type Conflict = { kind: "changed"; text: string | null; modified: number } | { kind: "deleted" };

export interface NoteInfo {
  status: NoteStatus;
  conflict: Conflict | null;
  error: string | null;
}

export const useNotes = create<{ notes: Record<string, NoteInfo> }>(() => ({ notes: {} }));

/** Marks a change the session applied itself (the disk's text), so it is not
 *  mistaken for typing and does not trigger a save. */
const fromDiskEdit = Annotation.define<boolean>();

export interface Session {
  mountId: string;
  path: string;
  state: EditorState;
  view: EditorView | null;
  /** The text believed to be on disk, normalized ("\n", no BOM). */
  baseline: string;
  /** The file's mtime when `baseline` was read or written: the save guard. */
  modified: number;
  shape: DiskShape;
  /** The document may differ from `baseline`. */
  dirty: boolean;
  /** The text being written right now, if a save is running. */
  inFlight: string | null;
  saving: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  conflict: Conflict | null;
  /** The disk's shape behind a "changed" conflict, taken on Reload. */
  conflictShape: DiskShape | null;
  error: string | null;
  /** The next save writes unconditionally (Keep mine, Restore my copy). */
  force: boolean;
  /** Where the editor was scrolled when its view last went away. */
  scrollTop: number;
  /** Called after every typed change; the split preview listens. */
  onEdit: (() => void) | null;
}

const sessions = new Map<string, Session>();

// ---- status --------------------------------------------------------------

function statusOf(s: Session): NoteStatus {
  if (s.conflict) return "conflict";
  if (s.inFlight !== null) return "saving";
  if (s.error) return "error";
  return s.dirty ? "dirty" : "clean";
}

function publish(s: Session): void {
  if (sessions.get(s.path) !== s) return;
  const next: NoteInfo = { status: statusOf(s), conflict: s.conflict, error: s.error };
  const cur = useNotes.getState().notes[s.path];
  if (cur && cur.status === next.status && cur.conflict === next.conflict && cur.error === next.error) return;
  useNotes.setState((st) => ({ notes: { ...st.notes, [s.path]: next } }));
}

function unpublish(path: string): void {
  if (!(path in useNotes.getState().notes)) return;
  useNotes.setState((st) => {
    const notes = { ...st.notes };
    delete notes[path];
    return { notes };
  });
}

// ---- lifecycle -------------------------------------------------------------

/**
 * The note for `path`: the open one, reconciled with `file` (the disk may be
 * newer), or a new one built from `file`. `build` makes the CodeMirror state;
 * it lives with the editor so this module never loads the editor's view code.
 */
export function openSession(
  mountId: string,
  path: string,
  file: ipc.TextFile,
  build: (doc: string, s: Session) => EditorState,
): Session {
  const existing = sessions.get(path);
  if (existing && existing.mountId === mountId) {
    observeDisk(path, file);
    return existing;
  }
  if (existing) drop(existing);
  const { text, shape } = fromDisk(file.text);
  const s: Session = {
    mountId,
    path,
    state: undefined as unknown as EditorState,
    view: null,
    baseline: text,
    modified: file.modified,
    shape,
    dirty: false,
    inFlight: null,
    saving: null,
    timer: null,
    conflict: null,
    conflictShape: null,
    error: null,
    force: false,
    scrollTop: 0,
    onEdit: null,
  };
  s.state = build(text, s);
  sessions.set(path, s);
  publish(s);
  return s;
}

export function getSession(path: string): Session | undefined {
  return sessions.get(path);
}

/** The note's current text, or null when it is not open. */
export function sessionText(path: string): string | null {
  return sessions.get(path)?.state.doc.toString() ?? null;
}

export function attachView(s: Session, view: EditorView): void {
  s.view = view;
}

export function detachView(s: Session, scrollTop: number): void {
  s.view = null;
  s.scrollTop = scrollTop;
}

function drop(s: Session): void {
  clearTimer(s);
  s.onEdit = null;
  if (sessions.get(s.path) === s) sessions.delete(s.path);
  unpublish(s.path);
}

/** Forget a note without saving it. */
export function discard(path: string): void {
  const s = sessions.get(path);
  if (s) drop(s);
}

export function discardUnder(dir: string): void {
  for (const s of [...sessions.values()]) if (isUnder(s.path, dir)) drop(s);
}

export function discardAll(): void {
  for (const s of [...sessions.values()]) drop(s);
}

// ---- typing and saving ---------------------------------------------------

/** Every view update of a note lands here. Typing marks it dirty and
 *  (re)starts the autosave; changes the session applied itself do not. */
export function noteUpdated(s: Session, u: ViewUpdate): void {
  s.state = u.state;
  if (!u.docChanged) return;
  if (u.transactions.every((tr) => !tr.docChanged || tr.annotation(fromDiskEdit))) return;
  s.dirty = true;
  s.onEdit?.();
  // While a conflict waits for the user, nothing is written.
  if (!s.conflict) schedule(s);
  publish(s);
}

function clearTimer(s: Session): void {
  if (s.timer !== null) {
    clearTimeout(s.timer);
    s.timer = null;
  }
}

function schedule(s: Session): void {
  clearTimer(s);
  s.timer = setTimeout(() => {
    s.timer = null;
    void save(s);
  }, AUTOSAVE_MS);
}

function save(s: Session, retries = 0): Promise<void> {
  clearTimer(s);
  if (s.saving) return s.saving.then(() => save(s, retries));
  if (sessions.get(s.path) !== s || s.conflict) return Promise.resolve();
  if (!s.dirty && !s.force) return Promise.resolve();
  const text = s.state.doc.toString();
  if (text === s.baseline && !s.force) {
    s.dirty = false;
    s.error = null;
    publish(s);
    return Promise.resolve();
  }
  const expected = s.force ? null : s.modified;
  s.force = false;
  s.inFlight = text;
  s.error = null;
  publish(s);

  const run = (async () => {
    let retry = false;
    try {
      const res = await ipc.writeText(s.mountId, s.path, toDisk(text, s.shape), expected);
      s.baseline = text;
      s.modified = res.modified;
    } catch (e) {
      const msg = ipc.errorText(e);
      if (msg.startsWith("conflict:")) retry = await onRefused(s, msg);
      else s.error = ipc.humanError(e);
    } finally {
      s.inFlight = null;
      s.saving = null;
      s.dirty = s.state.doc.toString() !== s.baseline;
      publish(s);
    }
    if (retry && retries < MAX_TOUCH_RETRIES) await save(s, retries + 1);
  })();
  s.saving = run;
  return run;
}

/** Rust refused a save because the file changed. Re-read it to tell a real
 *  edit from a touch: a file that still holds what this note last saved gets
 *  its new mtime adopted and the save retried (returns true). */
async function onRefused(s: Session, msg: string): Promise<boolean> {
  if (msg.includes("deleted")) {
    s.conflict = { kind: "deleted" };
    return false;
  }
  let file: ipc.TextFile;
  try {
    file = await ipc.readText(s.mountId, s.path);
  } catch {
    s.conflict = { kind: "deleted" };
    return false;
  }
  if (file.truncated || file.lossy) {
    s.conflict = { kind: "changed", text: null, modified: file.modified };
    return false;
  }
  const { text, shape } = fromDisk(file.text);
  if (text === s.baseline) {
    s.modified = file.modified;
    s.shape = adoptShape(s.shape, shape, text);
    return true;
  }
  if (text === s.state.doc.toString()) {
    s.baseline = text;
    s.modified = file.modified;
    s.shape = adoptShape(s.shape, shape, text);
    return false;
  }
  s.conflict = { kind: "changed", text, modified: file.modified };
  s.conflictShape = shape;
  return false;
}

/** Save now if there is anything to save. True when the note is clean
 *  afterwards (or not open); false when it still holds unsaved text. */
export async function flush(path: string): Promise<boolean> {
  const s = sessions.get(path);
  if (!s) return true;
  await save(s);
  return !s.dirty && !s.conflict;
}

async function flushMany(list: Session[]): Promise<string[]> {
  const ok = await Promise.all(list.map((s) => flush(s.path)));
  return list.filter((_, i) => !ok[i]).map((s) => s.path);
}

/** Flush every open note. Resolves to the paths that could not be saved. */
export function flushAll(): Promise<string[]> {
  return flushMany([...sessions.values()]);
}

/** Flush the notes at or under `dir` (a rename or a delete is coming). */
export function flushUnder(dir: string): Promise<string[]> {
  return flushMany([...sessions.values()].filter((s) => isUnder(s.path, dir)));
}

/** Tabs closed: save what they hold, then forget the notes that end clean. A
 *  note that could not be saved stays in the background, so its text is still
 *  there if the file is reopened, and leaving the mount asks about it.
 *  `reopened` says whether a path is back in a tab by the time its save
 *  lands, in which case the note stays. */
export function release(paths: Iterable<string>, reopened: (path: string) => boolean = () => false): void {
  for (const p of paths) {
    const s = sessions.get(p);
    if (!s) continue;
    s.onEdit = null;
    void flush(p).then((ok) => {
      if (sessions.get(p) !== s || reopened(s.path)) return;
      if (ok) drop(s);
      else toast(`${basename(p)} was not saved. Reopen it to keep your changes.`, "error");
    });
  }
}

// ---- the disk moved ------------------------------------------------------

function applyText(s: Session, text: string, undoable: boolean): void {
  const change = minimalChange(s.state.doc.toString(), text);
  if (!change) return;
  const spec: TransactionSpec = {
    changes: change,
    annotations: [fromDiskEdit.of(true), Transaction.addToHistory.of(undoable)],
  };
  if (s.view) s.view.dispatch(spec);
  else s.state = s.state.update(spec).state;
}

/**
 * A fresh read of `path` (the watcher saw it change, or the tab came back).
 * Our own save echoing back changes nothing. Another writer's text replaces
 * the document in place when the note has no unsaved edits, and becomes a
 * conflict when it does: unsaved text is never overwritten silently.
 */
export function observeDisk(path: string, file: ipc.TextFile): void {
  const s = sessions.get(path);
  if (!s) return;
  if (file.truncated || file.lossy) {
    if (file.modified !== s.modified) {
      clearTimer(s);
      s.conflict = { kind: "changed", text: null, modified: file.modified };
      publish(s);
    }
    return;
  }
  const { text, shape } = fromDisk(file.text);
  const doc = s.state.doc.toString();
  switch (reconcile({ baseline: s.baseline, doc, inFlight: s.inFlight }, text)) {
    case "same":
      if (s.inFlight === null && text === s.baseline) {
        s.modified = file.modified;
        s.shape = adoptShape(s.shape, shape, text);
        // The file came back as we left it (a stash, an undo elsewhere).
        if (s.conflict) {
          s.conflict = null;
          if (s.dirty) schedule(s);
        }
      }
      break;
    case "converged":
      clearTimer(s);
      s.baseline = text;
      s.modified = file.modified;
      s.shape = adoptShape(s.shape, shape, text);
      s.dirty = false;
      s.conflict = null;
      break;
    case "adopt":
      applyText(s, text, false);
      s.baseline = text;
      s.modified = file.modified;
      s.shape = adoptShape(s.shape, shape, text);
      s.dirty = false;
      s.conflict = null;
      s.onEdit?.();
      break;
    case "conflict":
      clearTimer(s);
      s.conflict = { kind: "changed", text, modified: file.modified };
      s.conflictShape = shape;
      break;
  }
  publish(s);
}

/** The watcher says `path` is gone. A note with nothing unsaved is simply
 *  forgotten (its tab closes, as before 0.6.0). One holding unsaved text keeps
 *  its tab and says so. True when the tab should stay open. */
export function onRemoved(path: string): boolean {
  const s = sessions.get(path);
  if (!s) return false;
  if (!s.dirty && !s.conflict && s.inFlight === null) {
    drop(s);
    return false;
  }
  clearTimer(s);
  s.conflict = { kind: "deleted" };
  publish(s);
  return true;
}

// ---- resolving a conflict ------------------------------------------------

/** Take the disk's version. Undoable: Ctrl+Z brings the note's text back. */
export function reloadFromDisk(path: string): void {
  const s = sessions.get(path);
  const c = s?.conflict;
  if (!s || !c || c.kind !== "changed" || c.text === null) return;
  applyText(s, c.text, true);
  s.baseline = c.text;
  s.modified = c.modified;
  if (s.conflictShape) s.shape = adoptShape(s.shape, s.conflictShape, c.text);
  s.conflictShape = null;
  s.conflict = null;
  s.dirty = false;
  s.error = null;
  publish(s);
  s.onEdit?.();
}

/** Write the note's text over whatever is on disk (or recreate a deleted file). */
export function keepMine(path: string): Promise<void> {
  const s = sessions.get(path);
  if (!s) return Promise.resolve();
  s.conflict = null;
  s.force = true;
  s.dirty = true;
  return save(s);
}

/** Retry a save that failed for another reason (a locked file, a full disk). */
export function retrySave(path: string): Promise<void> {
  const s = sessions.get(path);
  if (!s) return Promise.resolve();
  s.dirty = true;
  return save(s);
}

// ---- renames -------------------------------------------------------------

/** `from` was renamed to `to`: every note at or under it follows, with its
 *  undo history, status and pending save intact. */
export function renameSessions(from: string, to: string): void {
  const moves: Array<[string, Session]> = [];
  for (const [p, s] of sessions) {
    const next = remapPath(p, from, to);
    if (next !== null) moves.push([next, s]);
  }
  for (const [, s] of moves) {
    sessions.delete(s.path);
    unpublish(s.path);
  }
  for (const [next, s] of moves) {
    s.path = next;
    sessions.set(next, s);
    publish(s);
  }
}
