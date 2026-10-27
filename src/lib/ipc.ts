// Every Tauri `invoke` and event subscription lives here behind a typed
// surface. The rest of the UI imports from this module only.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, type CloseRequestedEvent } from "@tauri-apps/api/window";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { assetPath } from "./paths";
import type { TreeNode } from "./tree";

// ---- Types (mirror the Rust structs, serialized camelCase) ---------------

export interface Mount {
  id: string;
  path: string;
  name: string;
  addedAt: number;
  lastOpenedAt: number;
  missing: boolean;
}

export interface MountList {
  mounts: Mount[];
  activeMountId: string | null;
}

export interface IndexStats {
  files: number;
  dirs: number;
  builtMs: number;
  truncated: boolean;
}

export interface SearchHit {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  modified: number;
  score: number;
}

/** One query's answer. `total` is how many entries matched before the 200-hit
 *  cap, so the UI can say "newest 200 of 1,412" instead of implying 200 is all
 *  there is. */
export interface SearchResult {
  hits: SearchHit[];
  total: number;
}

export interface TextFile {
  text: string;
  truncated: boolean;
  bytes: number;
  modified: number;
  /** The bytes were not valid UTF-8 and were decoded with U+FFFD. Such a file
   *  is shown but never written back: saving would replace those bytes. */
  lossy: boolean;
}

export interface WriteResult {
  /** The file's mtime after the write, epoch millis: the next save's guard. */
  modified: number;
  bytes: number;
}

export interface PathStat {
  size: number;
  modified: number;
  isDir: boolean;
}

export interface FileChanged {
  path: string;
  kind: "modified" | "removed";
}

export interface FilesChanged {
  mountId: string;
  changes: FileChanged[];
  /** The batch overflowed: `changes` is empty, the index was rebuilt from
   *  disk, and every loaded folder should be re-listed. */
  rescan: boolean;
  /** Index counts after the batch; null while the index is still building. */
  stats: IndexStats | null;
}

export interface IndexReady {
  mountId: string;
  stats: IndexStats;
}

/** True if `err` is Rust refusing a call because the mount changed underneath it. */
export function isMountMismatch(err: unknown): boolean {
  const msg = typeof err === "string" ? err : err instanceof Error ? err.message : "";
  return msg.startsWith("mount-mismatch");
}

export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Rust's machine prefixes on write errors, dropped for display. */
const ERROR_PREFIX = /^(conflict|exists|invalid-name|not-editable|mount-mismatch): /;

export function humanError(err: unknown): string {
  return errorText(err).replace(ERROR_PREFIX, "");
}

// ---- Mounts --------------------------------------------------------------

export const listMounts = () => invoke<MountList>("list_mounts");
export const addMount = () => invoke<Mount | null>("add_mount");
export const removeMount = (id: string) => invoke<void>("remove_mount", { id });
export const openMount = (id: string) => invoke<Mount>("open_mount", { id });

// ---- Reads ---------------------------------------------------------------

export const listChildren = (id: string, rel: string) =>
  invoke<TreeNode[]>("list_children", { id, rel });
export const readText = (id: string, rel: string) => invoke<TextFile>("read_text", { id, rel });
/** Rust answers with a binary IPC response, which arrives as an ArrayBuffer;
 *  the other shapes are kept for safety. */
export const readBytes = async (id: string, rel: string): Promise<Uint8Array> => {
  const data = await invoke<number[] | ArrayBuffer | Uint8Array>("read_bytes", { id, rel });
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Uint8Array.from(data);
};
export const statPath = (id: string, rel: string) => invoke<PathStat>("stat_path", { id, rel });
export const absPath = (id: string, rel: string) => invoke<string>("abs_path", { id, rel });

// ---- Writes --------------------------------------------------------------
// Rust accepts these for Markdown files and folders only (see writefile.rs).

/** Save a note. `expectedModified` is the mtime the text was loaded at: a
 *  file changed since is refused with a `conflict:` error instead of being
 *  overwritten. `null` writes unconditionally (Keep mine, Restore). */
export const writeText = (id: string, rel: string, text: string, expectedModified: number | null) =>
  invoke<WriteResult>("write_text", { id, rel, text, expectedModified });
/** Create an empty note; `dir` "" is the mount root. Returns its path. */
export const createNote = (id: string, dir: string, name: string) =>
  invoke<string>("create_note", { id, dir, name });
export const createFolder = (id: string, dir: string, name: string) =>
  invoke<string>("create_folder", { id, dir, name });
/** Rename in place (same folder). Returns the new path. */
export const renamePath = (id: string, rel: string, name: string) =>
  invoke<string>("rename_path", { id, rel, name });
/** Move to the Recycle Bin. Never a permanent delete. */
export const trashPath = (id: string, rel: string) => invoke<void>("trash_path", { id, rel });

// ---- Index ---------------------------------------------------------------

/** `sinceMs` switches the index from relevance to recency: files modified at
 *  or after that instant, newest first, with an empty `query` then legal. */
export const searchNames = (id: string, query: string, sinceMs?: number) =>
  invoke<SearchResult>("search_names", { id, query, sinceMs: sinceMs ?? null });
export const indexStatus = (id: string) => invoke<IndexStats | null>("index_status", { id });

// ---- Launching -----------------------------------------------------------

export const openInDefaultApp = (id: string, rel: string) =>
  invoke<void>("open_in_default_app", { id, rel });
export const openFolder = (id: string, rel: string) => invoke<void>("open_folder", { id, rel });

/**
 * Open a file or folder in VS Code through its `vscode://file/<path>` URL
 * scheme (the same mechanism GitHub Desktop uses). Needs no shell plugin and
 * works whether or not `code` is on the PATH.
 *
 * A folder opened through the scheme reuses the last active window and
 * replaces its workspace; VS Code's handler reads a `windowId` query
 * parameter and treats `_blank` as "force a new window" (verified in
 * source, not on the docs page). Files do not get it: a file belongs as a
 * tab in the window you are already working in.
 */
export const openInVsCode = (absolute: string, opts: { newWindow?: boolean } = {}) => {
  const normalized = absolute.replace(/\\/g, "/").replace(/\/+$/, "");
  const query = opts.newWindow ? "?windowId=_blank" : "";
  return openUrl("vscode://file/" + encodeURI(normalized) + query);
};

/** Show a file or folder selected in Explorer. Falls back to opening it. */
export const revealInFileManager = async (absolute: string): Promise<void> => {
  try {
    await revealItemInDir(absolute);
  } catch {
    await openPath(absolute);
  }
};

export const copyText = async (text: string): Promise<boolean> => {
  try {
    await writeClipboard(text);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
};

/** Open an http(s) link from a rendered document in the default browser. */
export const openExternal = (url: string) => openUrl(url);

/** A URL the webview can load a mounted file from, through the asset protocol. */
/** A mounted file as a URL the webview can load. The origin comes from Tauri
 *  (it differs per platform); the path is rebuilt segment by segment so the
 *  document keeps a real base directory. See `assetPath`. */
export const assetUrl = (absolute: string): string => {
  const tauri = convertFileSrc(absolute);
  const afterScheme = tauri.indexOf("//");
  const pathStart = tauri.indexOf("/", afterScheme + 2);
  const origin = pathStart === -1 ? tauri : tauri.slice(0, pathStart);
  return `${origin}/${assetPath(absolute)}`;
};

// ---- Events --------------------------------------------------------------

export const onFilesChanged = (cb: (e: FilesChanged) => void): Promise<UnlistenFn> =>
  listen<FilesChanged>("files-changed", (ev) => cb(ev.payload));

export const onIndexReady = (cb: (e: IndexReady) => void): Promise<UnlistenFn> =>
  listen<IndexReady>("index-ready", (ev) => cb(ev.payload));

/** The window is about to close. The handler is awaited before the window
 *  goes, so unsaved notes can be flushed; `preventDefault` keeps it open. */
export const onCloseRequested = (cb: (e: CloseRequestedEvent) => Promise<void>): Promise<UnlistenFn> =>
  getCurrentWindow().onCloseRequested(cb);

/** Close the window without asking again (after the user chose to discard). */
export const destroyWindow = () => getCurrentWindow().destroy();
