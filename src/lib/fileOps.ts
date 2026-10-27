// The note-taking file operations: new note, new folder, rename, move to the
// Recycle Bin. Each one asks (dialogs), writes (Rust, which re-checks every
// rule), then brings the tree, the tabs and the open notes along.

import * as notes from "../editor/sessions";
import { useStore } from "../store";
import { confirmDialog, promptName } from "./dialogs";
import * as ipc from "./ipc";
import { isMarkdownName, isUnder, nameProblem, nameTaken, noteFileName, stemLength, untitledStem } from "./names";
import { basename, dirname, extOf } from "./paths";
import { readEditMode } from "./prefs";
import { toast } from "./toast";
import { findNode } from "./tree";

/** Whether a tree entry can be renamed or binned here: folders and notes. */
export function canManage(path: string, isDir: boolean): boolean {
  return path !== "" && (isDir || isMarkdownName(basename(path)));
}

/** The folder a new note goes into: the tree cursor's folder (the cursor
 *  itself when it is a folder), else the active file's, else the root. */
export function currentFolder(): string {
  const st = useStore.getState();
  const at = st.cursor ?? st.active;
  if (!at) return "";
  return findNode(st.root, at)?.isDir ? at : dirname(at);
}

async function namesIn(mountId: string, dir: string): Promise<string[]> {
  try {
    return (await ipc.listChildren(mountId, dir)).map((n) => n.name);
  } catch {
    return [];
  }
}

function where(dir: string): string {
  const mount = useStore.getState().mount;
  return dir ? `in ${dir}` : `in ${mount?.name ?? "the mount root"}`;
}

/** Re-list `dir` and open every expanded folder under `under` again,
 *  shallowest first, so a renamed or new folder shows its contents. */
async function relist(dir: string, under?: string) {
  const st = useStore.getState();
  await st.loadChildren(dir);
  if (under === undefined) return;
  const open = [...useStore.getState().expanded]
    .filter((p) => isUnder(p, under))
    .sort((a, b) => a.split("/").length - b.split("/").length);
  for (const p of open) await useStore.getState().loadChildren(p);
}

export async function newNote(dir = currentFolder()): Promise<void> {
  const mount = useStore.getState().mount;
  if (!mount) return;
  const taken = await namesIn(mount.id, dir);
  const name = await promptName({
    title: "New note",
    context: where(dir),
    initial: untitledStem(taken),
    suffix: ".md",
    confirmLabel: "Create",
    validate: (v) => {
      const file = noteFileName(v);
      if (!v.trim()) return "Enter a name";
      return nameProblem(file) ?? (nameTaken(file, taken) ? `${file} already exists here` : null);
    },
  });
  if (name === null) return;
  try {
    const rel = await ipc.createNote(mount.id, dir, noteFileName(name));
    const st = useStore.getState();
    st.setMdMode(rel, readEditMode());
    await relist(dir);
    st.openFile(rel);
    await useStore.getState().revealPath(rel);
  } catch (e) {
    toast(`Could not create the note: ${ipc.humanError(e)}`, "error");
  }
}

export async function newFolder(dir = currentFolder()): Promise<void> {
  const mount = useStore.getState().mount;
  if (!mount) return;
  const taken = await namesIn(mount.id, dir);
  const name = await promptName({
    title: "New folder",
    context: where(dir),
    initial: "New folder",
    confirmLabel: "Create",
    validate: (v) => {
      const n = v.trim();
      return nameProblem(n) ?? (nameTaken(n, taken) ? `${n} already exists here` : null);
    },
  });
  if (name === null) return;
  try {
    const rel = await ipc.createFolder(mount.id, dir, name.trim());
    await relist(dir);
    await useStore.getState().revealPath(rel);
  } catch (e) {
    toast(`Could not create the folder: ${ipc.humanError(e)}`, "error");
  }
}

export async function renameEntry(path: string, isDir: boolean): Promise<void> {
  const mount = useStore.getState().mount;
  if (!mount) return;
  if (!canManage(path, isDir)) {
    toast("Only notes (Markdown) and folders can be renamed here", "neutral");
    return;
  }
  const current = basename(path);
  const parent = dirname(path);
  const taken = await namesIn(mount.id, parent);
  const finalName = (v: string) => (isDir ? v.trim() : noteFileName(v, extOf(current)));
  const typed = await promptName({
    title: isDir ? "Rename folder" : "Rename note",
    context: where(parent),
    initial: current,
    selectLength: stemLength(current, isDir),
    confirmLabel: "Rename",
    validate: (v) => {
      const n = finalName(v);
      if (!v.trim()) return "Enter a name";
      return nameProblem(n) ?? (nameTaken(n, taken, path) ? `${n} already exists here` : null);
    },
  });
  if (typed === null) return;
  const next = finalName(typed);
  if (next === current) return;

  // Whatever is typed in the note(s) lands under the old name first.
  const unsaved = await notes.flushUnder(path);
  if (unsaved.length > 0) {
    toast(`Save ${unsaved.map(basename).join(", ")} before renaming`, "error");
    return;
  }
  try {
    const rel = await ipc.renamePath(mount.id, path, next);
    // Tabs and notes follow BEFORE the watcher reports the old path as
    // removed, so no "removed on disk" toast fires for our own rename.
    notes.renameSessions(path, rel);
    useStore.getState().remapPaths(path, rel);
    await relist(parent, isDir ? rel : undefined);
  } catch (e) {
    toast(`Could not rename: ${ipc.humanError(e)}`, "error");
  }
}

export async function trashEntry(path: string, isDir: boolean): Promise<void> {
  const mount = useStore.getState().mount;
  if (!mount || !canManage(path, isDir)) return;
  const name = basename(path);
  const ok = await confirmDialog({
    title: "Move to the Recycle Bin?",
    body: isDir
      ? `"${name}" and everything in it will be moved to the Recycle Bin.`
      : `"${name}" will be moved to the Recycle Bin.`,
    confirmLabel: "Move to Recycle Bin",
    danger: true,
  });
  if (!ok) return;
  // The binned copy should hold the latest text.
  await notes.flushUnder(path);
  try {
    await ipc.trashPath(mount.id, path);
    notes.discardUnder(path);
    useStore.getState().forgetUnder(path);
    await relist(dirname(path));
    toast(`Moved "${name}" to the Recycle Bin`, "success");
  } catch (e) {
    toast(`Could not move it to the Recycle Bin: ${ipc.humanError(e)}`, "error");
  }
}

