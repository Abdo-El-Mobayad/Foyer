// Markdown line operations and the slash-command catalog. Pure: strings and
// offsets in, strings and offsets out, so every transform is unit-tested.
// `markdownEditing.ts` turns them into CodeMirror changes.

export type BlockKind = "text" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "bullet" | "numbered" | "task" | "quote";

/** What a line starts with: its indentation and its block marker. A task
 *  box needs a space after it or the end of the line; a bullet or number
 *  needs a space after it ("-x" is text, "- x" is a bullet). */
const LEAD = /^([ \t]*)(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+\[[ xX]\](?:[ \t]+|$)|[-*+][ \t]+|\d{1,9}[.)][ \t]+)?/;

export interface Lead {
  indent: string;
  marker: string;
  kind: BlockKind;
  /** indent + marker, in characters: what a block change replaces. */
  length: number;
}

export function leadOf(line: string): Lead {
  const m = LEAD.exec(line)!;
  const indent = m[1];
  const marker = m[2] ?? "";
  return { indent, marker, kind: kindOfMarker(marker), length: indent.length + marker.length };
}

function kindOfMarker(marker: string): BlockKind {
  if (!marker) return "text";
  if (marker[0] === "#") return `h${/^#+/.exec(marker)![0].length}` as BlockKind;
  if (marker[0] === ">") return "quote";
  if (/^\d/.test(marker)) return "numbered";
  if (/\[[ xX]\]/.test(marker)) return "task";
  return "bullet";
}

export function markerFor(kind: BlockKind, n = 1): string {
  switch (kind) {
    case "text":
      return "";
    case "bullet":
      return "- ";
    case "numbered":
      return `${n}. `;
    case "task":
      return "- [ ] ";
    case "quote":
      return "> ";
    default:
      return "#".repeat(Number(kind.slice(1))) + " ";
  }
}

/** The new lead for turning a line that starts with `lead` into `kind`.
 *  Lists and plain text keep their nesting; headings and quotes go to the
 *  margin, since four spaces in front would make them a code block. */
export function leadFor(kind: BlockKind, lead: Lead, n = 1): string {
  const keep = kind === "text" || kind === "bullet" || kind === "numbered" || kind === "task";
  return (keep ? lead.indent : "") + markerFor(kind, n);
}

/** The number for a numbered item that follows `prev`: one more than prev's
 *  when prev is a numbered item at the same indent, else 1. */
export function nextNumber(prev: string | null, indent: string): number {
  if (prev === null) return 1;
  const m = /^([ \t]*)(\d{1,9})[.)][ \t]/.exec(prev);
  return m && m[1] === indent ? Number(m[2]) + 1 : 1;
}

/** The box of a task on this line: where its mark sits and what a toggle
 *  writes there. Null when the line is not a task. */
export function taskBox(line: string): { offset: number; next: " " | "x" } | null {
  const m = /^([ \t]*[-*+][ \t]+\[)([ xX])\]/.exec(line);
  if (!m) return null;
  return { offset: m[1].length, next: m[2] === " " ? "x" : " " };
}

/** Where to start deleting a typed slash command (`/todo`) that runs from
 *  `slashAt` to `end`: at the slash, or one earlier to take the space that
 *  introduced it when nothing but a space or the line's end follows, so
 *  "milk /todo" leaves "milk", not "milk ". Never before `floor` (the line's
 *  lead, which a block change rewrites separately). */
export function slashCut(line: string, slashAt: number, end: number, floor: number): number {
  const spaceBefore = slashAt - 1 >= floor && line[slashAt - 1] === " ";
  const spaceOrEndAfter = end === line.length || line[end] === " ";
  return spaceBefore && spaceOrEndAfter ? slashAt - 1 : slashAt;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isoDateTime(d: Date): string {
  return `${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---- The slash menu -------------------------------------------------------

/** A block snippet ("lines") ends where the next paragraph can start
 *  safely. A table needs a blank line after it: in GitHub Markdown a plain
 *  line right under a table is read as one more row. */
export type SlashAction =
  /** Turn the current line into a block kind (keeps its text). */
  | { type: "block"; kind: BlockKind }
  /** Write a snippet in place of the command, inside the line. */
  | { type: "inline"; snippet: string }
  /** Write a snippet on lines of its own (a code block, a table). */
  | { type: "lines"; snippet: string }
  /** Write plain text in place of the command. */
  | { type: "text"; value: (now: Date) => string }
  /** Add front matter at the top of the note, or go to it. */
  | { type: "front-matter" }
  | { type: "toggle-task" };

export type SlashSection = "Blocks" | "Inline" | "Insert";

export interface SlashCommand {
  id: string;
  label: string;
  section: SlashSection;
  /** A short mark for the menu's icon column. */
  glyph: string;
  /** The Markdown it writes, shown in the menu so the syntax is learned. */
  syntax: string;
  /** Its keyboard shortcut, if it has one. */
  keys?: string;
  /** Other words it answers to: "/todo" finds Checkbox. */
  aliases: string[];
  action: SlashAction;
}

const block = (kind: BlockKind): SlashAction => ({ type: "block", kind });

export const SLASH_COMMANDS: SlashCommand[] = [
  { id: "text", label: "Text", section: "Blocks", glyph: "T", syntax: "plain", keys: "Ctrl+Alt+0", aliases: ["paragraph", "plain", "normal", "clear"], action: block("text") },
  { id: "h1", label: "Heading 1", section: "Blocks", glyph: "H1", syntax: "#", keys: "Ctrl+Alt+1", aliases: ["h1", "title"], action: block("h1") },
  { id: "h2", label: "Heading 2", section: "Blocks", glyph: "H2", syntax: "##", keys: "Ctrl+Alt+2", aliases: ["h2", "subtitle"], action: block("h2") },
  { id: "h3", label: "Heading 3", section: "Blocks", glyph: "H3", syntax: "###", keys: "Ctrl+Alt+3", aliases: ["h3"], action: block("h3") },
  { id: "h4", label: "Heading 4", section: "Blocks", glyph: "H4", syntax: "####", aliases: ["h4"], action: block("h4") },
  { id: "h5", label: "Heading 5", section: "Blocks", glyph: "H5", syntax: "#####", aliases: ["h5"], action: block("h5") },
  { id: "h6", label: "Heading 6", section: "Blocks", glyph: "H6", syntax: "######", aliases: ["h6"], action: block("h6") },
  { id: "bullet", label: "Bullet list", section: "Blocks", glyph: "•", syntax: "-", keys: "Ctrl+Shift+8", aliases: ["bullet", "ul", "list", "unordered", "dash"], action: block("bullet") },
  { id: "numbered", label: "Numbered list", section: "Blocks", glyph: "1.", syntax: "1.", keys: "Ctrl+Shift+7", aliases: ["ol", "number", "ordered", "numbered"], action: block("numbered") },
  { id: "task", label: "Checkbox", section: "Blocks", glyph: "☐", syntax: "- [ ]", keys: "Ctrl+Shift+9", aliases: ["todo", "to-do", "task", "check", "checklist"], action: block("task") },
  { id: "quote", label: "Quote", section: "Blocks", glyph: "❝", syntax: ">", keys: "Ctrl+Shift+.", aliases: ["blockquote", "bq", "citation"], action: block("quote") },
  { id: "toggle-task", label: "Tick checkbox", section: "Blocks", glyph: "☑", syntax: "[ ] ↔ [x]", keys: "Ctrl+Enter", aliases: ["done", "complete", "tick", "toggle", "uncheck"], action: { type: "toggle-task" } },

  { id: "bold", label: "Bold", section: "Inline", glyph: "B", syntax: "**bold**", keys: "Ctrl+B", aliases: ["strong", "b"], action: { type: "inline", snippet: "**${}**${}" } },
  { id: "italic", label: "Italic", section: "Inline", glyph: "I", syntax: "*italic*", keys: "Ctrl+I", aliases: ["em", "emphasis", "i"], action: { type: "inline", snippet: "*${}*${}" } },
  { id: "strike", label: "Strikethrough", section: "Inline", glyph: "S", syntax: "~~strike~~", keys: "Ctrl+Shift+S", aliases: ["strike", "del", "delete", "s"], action: { type: "inline", snippet: "~~${}~~${}" } },
  { id: "code", label: "Inline code", section: "Inline", glyph: "`", syntax: "`code`", keys: "Ctrl+Shift+C", aliases: ["code", "mono", "monospace"], action: { type: "inline", snippet: "`${}`${}" } },
  { id: "link", label: "Link", section: "Inline", glyph: "↗", syntax: "[text](url)", keys: "Ctrl+K", aliases: ["url", "href", "web"], action: { type: "inline", snippet: "[${text}](${url})${}" } },
  { id: "wikilink", label: "Link to note", section: "Inline", glyph: "[[", syntax: "[[note]]", aliases: ["wikilink", "wiki", "page", "backlink", "note"], action: { type: "inline", snippet: "[[${note}]]${}" } },
  { id: "image", label: "Image", section: "Inline", glyph: "▣", syntax: "![alt](path)", aliases: ["img", "picture", "photo", "screenshot"], action: { type: "inline", snippet: "![${alt text}](${path})${}" } },

  { id: "codeblock", label: "Code block", section: "Insert", glyph: "{}", syntax: "```", aliases: ["fence", "pre", "snippet", "code"], action: { type: "lines", snippet: "```${language}\n${}\n```\n${}" } },
  { id: "table", label: "Table", section: "Insert", glyph: "▦", syntax: "| a | b |", aliases: ["grid", "columns"], action: { type: "lines", snippet: "| ${Column A} | ${Column B} |\n| --- | --- |\n| ${} | ${} |\n\n${}" } },
  { id: "divider", label: "Divider", section: "Insert", glyph: "─", syntax: "---", aliases: ["hr", "line", "separator", "rule"], action: { type: "lines", snippet: "---\n${}" } },
  { id: "today", label: "Today's date", section: "Insert", glyph: "◷", syntax: "2026-01-31", aliases: ["date", "today", "day"], action: { type: "text", value: isoDate } },
  { id: "now", label: "Date and time", section: "Insert", glyph: "◴", syntax: "2026-01-31 09:30", aliases: ["now", "time", "timestamp", "datetime"], action: { type: "text", value: isoDateTime } },
  { id: "properties", label: "Properties", section: "Insert", glyph: "≡", syntax: "--- front matter", aliases: ["frontmatter", "front", "yaml", "meta", "tags"], action: { type: "front-matter" } },
  { id: "comment", label: "Hidden comment", section: "Insert", glyph: "%", syntax: "<!-- -->", aliases: ["comment", "hidden", "private"], action: { type: "inline", snippet: "<!-- ${} -->${}" } },
];

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The commands matching what was typed after the slash, best first. An
 * exact name or alias ranks first, then a name, word or alias that starts
 * with it, then a name that merely contains it; ties keep catalog order.
 * Nothing typed lists everything, in catalog order.
 */
export function rankCommands(query: string, list: SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const q = compact(query);
  if (!q) return list;
  const scored: Array<{ c: SlashCommand; score: number; i: number }> = [];
  list.forEach((c, i) => {
    const names = [compact(c.label), ...c.aliases.map(compact)];
    const words = c.label.toLowerCase().split(/\s+/).map(compact);
    let score = 0;
    if (names.includes(q)) score = 3;
    else if (names.some((n) => n.startsWith(q)) || words.some((w) => w.startsWith(q))) score = 2;
    else if (names.some((n) => n.includes(q))) score = 1;
    if (score > 0) scored.push({ c, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.c);
}
