# Foyer

A companion app for people who run their wikis, knowledge bases and
repositories through Claude Code, Codex or any other AI agent in the
terminal.

When an agent does the writing, you stop needing an editor and start
needing a fast way to see what it wrote. That job usually takes two apps,
Obsidian to read the notes and VS Code to browse the tree. Foyer merges
them into one window built for reading and searching, so your terminal
session stays the place you work and Foyer sits beside it:

- Every file in the folder, the way VS Code's explorer shows it
  (dotfolders, gitignored files, every extension).
- Instant previews of Markdown, HTML, CSV, spreadsheets, images, PDFs,
  video and audio.
- File-name search across the whole folder, indexed in well under a
  second on each open.
- Live updates: the tree and the open note follow the agent's writes as
  they land.
- Markdown notes edit in place, with autosave that never overwrites a
  file the agent changed under you. Anything else opens in VS Code with
  one click.

No server, no accounts, no sync, no network calls. The only files it writes
are notes (`.md`, `.markdown`, `.mdx`) and folders. Built and tested on
Windows, and the installer is Windows-only for now.

## Build

```
pnpm install
pnpm exec vitest run
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build          # NSIS installer in src-tauri/target/release/bundle/nsis/
pnpm tauri dev            # development
```

## Shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+P, Ctrl+F | Search file names in the active mount (Ctrl+F searches the note while editing) |
| Ctrl+N | New note in the current folder |
| Ctrl+E | Switch the active note between Preview and editing |
| Ctrl+S | Save now (notes also save by themselves) |
| F2 | Rename the active note, or the tree's selected note or folder |
| Delete | In the tree: move the selected note or folder to the Recycle Bin |
| / | While editing: the slash menu (every block, format and insert, with its Markdown and shortcut) |
| Ctrl+B, Ctrl+I, Ctrl+Shift+S, Ctrl+Shift+C | While editing: bold, italic, strikethrough, inline code |
| Ctrl+K | While editing: link (the selection becomes its text) |
| Ctrl+Enter | While editing: tick or untick a checkbox (a plain line becomes one) |
| Ctrl+Shift+8, 7, 9, . | While editing: bullet list, numbered list, checkbox, quote (again to undo) |
| Ctrl+Alt+1, 2, 3, 0 | While editing: heading 1, 2, 3, plain text |
| Ctrl+Shift+O | Open the active file (or the mount) in VS Code |
| Ctrl+W | Close the active tab |
| Ctrl+Tab, Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+B | Toggle the sidebar |
| Ctrl+R | Reload the tree |

## Notes

A Markdown file opens in Preview. Edit (or Ctrl+E) opens it in the editor;
Split puts the editor beside a live preview. Whichever of the two you pick
last is what Ctrl+E and a new note use.

- **Saving is automatic:** about a second after you stop typing, and whenever
  you switch notes, leave the window, change mounts or close the app. The tab
  shows a dot until the note is on disk.
- **Nothing is overwritten behind your back.** If the file changes on disk
  while you have unsaved text (Claude, git, another editor), the save is
  refused and a banner offers Reload from disk (undo brings your text back)
  or Keep mine. A change to a note with no unsaved text simply appears.
- **Bytes are kept:** line endings (LF or CRLF) and a BOM are written back
  the way the file had them.
- Files over 4 MB (shown truncated) and files that are not UTF-8 stay
  read-only, since saving them would change bytes you never saw.
- **You never need to remember Markdown.** Type `/` at the start of a line
  or after a space and pick from the menu; keep typing to narrow it
  (`/todo`, `/h2`, `/table`). Block items turn the current line into that
  block, so `buy milk /todo` becomes `- [ ] buy milk`. Every item shows the
  Markdown it writes and its shortcut, so the menu doubles as a cheat
  sheet. Tab moves through the blanks of a link, image, table or code block.
  Checkboxes tick on click. What gets saved is plain Markdown either way.
- New note, New folder, Rename and Move to Recycle Bin are in the tree's
  right-click menu (right-click the empty space below the rows for the mount
  root). Deleting never skips the Recycle Bin.

## Reading width

Rendered Markdown sits in a 78-character column. Drag either edge of the
column to set your own width; it is kept across documents and restarts.
Double-click an edge to return to the default, or tick Full width in the
preview toolbar to fill the pane. With an edge focused, Left and Right nudge
it by 16 px (64 px with Shift), Home resets, End fills the pane.

## What is indexed

Everything under a mount except: `node_modules`, `.git`, `target`, `dist`,
`build`, `.venv`, `venv`, `__pycache__`, `.next`, `.turbo`, `.cache` and the
other generated-output folders listed in `src-tauri/src/rules.rs`. Only file
names are indexed, never contents; the index lives in memory and is rebuilt
in well under a second on each open.

## Large files

Previews are bounded so a big file costs a spinner at most, never a stall:

- Text and code read the first 4 MB. Up to 128 Ki characters a file is one
  highlighted `<pre>` (native selection and find); past that it is shown as
  virtualized rows, with lines over 4,096 characters split into continuation
  rows, so Wrap stays cheap at any size (measured: ~30 ms on a one-line
  4 MB JSON, versus minutes in 0.1.0).
- Tables (CSV, TSV, workbooks) keep 5,000 rows, 256 columns and 400,000
  cells, and only the rows in view are in the DOM. Workbooks parse in a
  worker. CSV Raw, Markdown Source and HTML Source use the same text viewer.
- Markdown fences are highlighted up to 64 KB each and 256 KB per document;
  a document past 1 MB opens in Source. Images past 32 MB, PDFs past 64 MB
  and HTML pages past 16 MB offer the exits instead of loading. Video and
  audio stream by byte range and have no cap.
- Tabs are capped at 40 (least recently viewed closes first); the view state
  is written to localStorage at most once per 250 ms.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
