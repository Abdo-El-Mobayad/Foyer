// File and folder names for the note operations. Pure. Rust re-checks every
// rule (`writefile.rs`); these exist so the dialog can say what is wrong
// while the name is being typed.

import { basename } from "./paths";

const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;

/** Why `name` cannot be used on Windows, or null when it can. */
export function nameProblem(name: string): string | null {
  if (!name) return "Enter a name";
  if (name.length > 255) return "That name is too long";
  if (name === "." || name === "..") return "That name is reserved";
  if (INVALID_CHARS.test(name)) return 'A name cannot contain < > : " / \\ | ? *';
  if (/[. ]$/.test(name)) return "A name cannot end with a space or a dot";
  if (DEVICE_NAME.test(name)) return "That name is reserved by Windows";
  return null;
}

export function isMarkdownName(name: string): boolean {
  return MARKDOWN_EXT.test(name);
}

/** What the user typed as a note's file name: trimmed, and given `.ext` when
 *  it has no Markdown extension of its own ("Meeting" becomes "Meeting.md"). */
export function noteFileName(input: string, ext = "md"): string {
  const name = input.trim();
  return isMarkdownName(name) ? name : `${name}.${ext}`;
}

/** "Untitled", or "Untitled 2", 3... whichever `<stem>.md` is free among
 *  `taken` (compared case-insensitively, as Windows does). */
export function untitledStem(taken: Iterable<string>, base = "Untitled"): string {
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  if (!lower.has(`${base}.md`.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const stem = `${base} ${i}`;
    if (!lower.has(`${stem}.md`.toLowerCase())) return stem;
  }
}

/** Length of a file name without its extension: the part a rename selects.
 *  A folder, or a dotfile with no other dot, selects the whole name. */
export function stemLength(name: string, isDir: boolean): number {
  if (isDir) return name.length;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

/** True when `path` is `dir` or inside it. "" is the mount root. */
export function isUnder(path: string, dir: string): boolean {
  return dir === "" || path === dir || path.startsWith(dir + "/");
}

/** `path` rewritten for `from` having been renamed to `to`, or null when the
 *  rename does not touch it. Works for a file and for everything under a
 *  renamed folder. */
export function remapPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(from + "/")) return to + path.slice(from.length);
  return null;
}

/** Whether a name is free in a folder whose entries are `taken`. A
 *  case-only rename of `self` is free: on Windows it is the same entry. */
export function nameTaken(name: string, taken: Iterable<string>, self?: string): boolean {
  const lower = name.toLowerCase();
  if (self !== undefined && basename(self).toLowerCase() === lower) return false;
  for (const t of taken) if (t.toLowerCase() === lower) return true;
  return false;
}
