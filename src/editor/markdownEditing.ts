// Notion-style help for writing Markdown without remembering it: a slash
// menu, formatting shortcuts, and checkboxes that tick on click. Everything
// writes plain Markdown, the same bytes as typing it by hand; the rules for
// what each command writes live in `markdownOps.ts` (pure, tested).

import {
  autocompletion,
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSection,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  Prec,
  RangeSetBuilder,
  type ChangeSpec,
  type EditorState,
  type Extension,
  type Line,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  type Command,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  leadFor,
  leadOf,
  nextNumber,
  rankCommands,
  slashCut,
  taskBox,
  type BlockKind,
  type SlashCommand,
  type SlashSection,
} from "./markdownOps";

// ---- block changes -------------------------------------------------------

/** The change turning `line` into `kind`: its lead (indent and marker) is
 *  replaced, its text untouched, so the cursor stays where it was. */
function blockChange(state: EditorState, line: Line, kind: BlockKind, n?: number): ChangeSpec {
  const lead = leadOf(line.text);
  const prev = line.number > 1 ? state.doc.line(line.number - 1).text : null;
  const insert = leadFor(kind, lead, n ?? nextNumber(prev, lead.indent));
  return { from: line.from, to: line.from + lead.length, insert };
}

/** Every line a selection touches, once, top to bottom. */
function selectedLines(state: EditorState): Line[] {
  const seen = new Set<number>();
  const lines: Line[] = [];
  for (const r of state.selection.ranges) {
    for (let pos = r.from; pos <= r.to; ) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.number)) {
        seen.add(line.number);
        lines.push(line);
      }
      pos = line.to + 1;
    }
  }
  return lines.sort((a, b) => a.number - b.number);
}

/** Shortcut for a block kind: the selected lines become `kind`, or go back
 *  to plain text if every one of them already is. Numbers count up. */
function toggleBlock(kind: BlockKind): Command {
  return (view) => {
    const { state } = view;
    const lines = selectedLines(state);
    const all = lines.every((l) => leadOf(l.text).kind === kind);
    const target = all ? "text" : kind;
    let n = lines.length ? nextNumber(lines[0].number > 1 ? state.doc.line(lines[0].number - 1).text : null, leadOf(lines[0].text).indent) : 1;
    const changes = lines.map((l) => blockChange(state, l, target, target === "numbered" ? n++ : undefined));
    view.dispatch({ changes, userEvent: "input", scrollIntoView: true });
    return true;
  };
}

/** Tick or untick the checkbox on each selected line; a line that is not a
 *  task becomes one. */
const toggleTasks: Command = (view) => {
  const { state } = view;
  const changes: ChangeSpec[] = selectedLines(state).map((l) => {
    const box = taskBox(l.text);
    if (box) return { from: l.from + box.offset, to: l.from + box.offset + 1, insert: box.next };
    return blockChange(state, l, "task");
  });
  view.dispatch({ changes, userEvent: "input" });
  return true;
};

/** Wrap each selection in `mark`, or unwrap it when it already is. An empty
 *  selection gets an empty pair with the cursor inside. */
function toggleMark(mark: string): Command {
  return (view) => {
    const { state } = view;
    const n = mark.length;
    const change = state.changeByRange((range) => {
      const wrapped =
        state.sliceDoc(range.from - n, range.from) === mark && state.sliceDoc(range.to, range.to + n) === mark;
      if (wrapped) {
        return {
          changes: [
            { from: range.from - n, to: range.from },
            { from: range.to, to: range.to + n },
          ],
          range: EditorSelection.range(range.from - n, range.to - n),
        };
      }
      return {
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark },
        ],
        range: EditorSelection.range(range.from + n, range.to + n),
      };
    });
    view.dispatch(state.update(change, { scrollIntoView: true, userEvent: "input" }));
    return true;
  };
}

/** Ctrl+K: a selection becomes the link's text with the URL to fill in;
 *  with nothing selected, both are placeholders (Tab moves between them). */
const insertLink: Command = (view) => {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);
  // The last stop is an unnamed field, not ${0}: CodeMirror orders numbered
  // stops before named ones, so ${0} would come first.
  const template = text ? `[${text.replace(/[{}]/g, "\\$&")}](\${url})\${}` : "[${text}](${url})${}";
  snippet(template)(view, null, from, to);
  return true;
};

// ---- the slash menu --------------------------------------------------------

const SECTIONS: Record<SlashSection, CompletionSection> = {
  Blocks: { name: "Turn into", rank: 0 },
  Inline: { name: "Format", rank: 1 },
  Insert: { name: "Insert", rank: 2 },
};

type SlashCompletion = Completion & { command: SlashCommand };

/** True inside code, where a slash is a slash (a path, a comment). */
function inCode(state: EditorState, pos: number): boolean {
  for (let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (/^(FencedCode|CodeBlock|InlineCode|CodeText|HTMLBlock|CommentBlock|Comment)$/.test(node.name)) return true;
  }
  return false;
}

/** Remove the typed command ("/todo", and the space before it when it ended
 *  the line), alongside `more` changes, in one undoable step. */
function withoutCommand(view: EditorView, from: number, to: number, floor: number, more: ChangeSpec[] = []) {
  const line = view.state.doc.lineAt(from);
  const cut = line.from + slashCut(line.text, from - line.from, to - line.from, floor - line.from);
  view.dispatch({ changes: [...more, { from: cut, to }], userEvent: "input.complete", scrollIntoView: true });
}

function apply(command: SlashCommand) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const { state } = view;
    const line = state.doc.lineAt(from);
    const action = command.action;
    switch (action.type) {
      case "block": {
        const lead = leadOf(line.text);
        withoutCommand(view, from, to, line.from + lead.length, [blockChange(state, line, action.kind)]);
        return;
      }
      case "toggle-task": {
        const box = taskBox(line.text);
        const lead = leadOf(line.text);
        const change: ChangeSpec = box
          ? { from: line.from + box.offset, to: line.from + box.offset + 1, insert: box.next }
          : blockChange(state, line, "task");
        withoutCommand(view, from, to, line.from + lead.length, [change]);
        return;
      }
      case "text":
        view.dispatch({ changes: { from, to, insert: action.value(new Date()) }, userEvent: "input.complete" });
        return;
      case "inline":
        snippet(action.snippet)(view, _c, from, to);
        return;
      case "lines": {
        // A block needs lines of its own, with a blank line above when text
        // precedes it: "---" under a paragraph would make that paragraph a
        // heading, and a table glued to one is not a table.
        const rest = (line.text.slice(0, from - line.from) + line.text.slice(to - line.from)).trim();
        if (rest) {
          withoutCommand(view, from, to, line.from);
          // The line start survives the removal; the slash position may not.
          const end = view.state.doc.lineAt(line.from).to;
          view.dispatch({ changes: { from: end, insert: "\n\n" }, selection: { anchor: end + 2 } });
          const at = end + 2;
          snippet(action.snippet)(view, _c, at, at);
          return;
        }
        const prev = line.number > 1 ? state.doc.line(line.number - 1).text : "";
        const gap = prev.trim() ? "\n" : "";
        view.dispatch({ changes: { from: line.from, to: line.to, insert: gap }, selection: { anchor: line.from + gap.length } });
        const at = line.from + gap.length;
        snippet(action.snippet)(view, _c, at, at);
        return;
      }
      case "front-matter": {
        withoutCommand(view, from, to, line.from);
        const doc = view.state.doc;
        const existing = /^---[ \t]*\r?\n/.test(doc.sliceString(0, 8));
        if (existing) {
          // Already there: go to the end of its first property line.
          const first = doc.lines > 1 ? doc.line(2) : doc.line(1);
          view.dispatch({ selection: { anchor: first.to }, scrollIntoView: true });
          return;
        }
        snippet("---\ntitle: ${title}\ntags: ${}\n---\n\n")(view, _c, 0, 0);
        return;
      }
    }
  };
}

function slashSource(context: CompletionContext): CompletionResult | null {
  const typed = context.matchBefore(/\/[\w-]*$/);
  if (!typed) return null;
  const { state } = context;
  const line = state.doc.lineAt(typed.from);
  // A slash opens the menu at the start of a line or after a space; inside
  // a word or a URL ("a/b", "https://") it is just a slash.
  if (typed.from > line.from && !/\s/.test(state.sliceDoc(typed.from - 1, typed.from))) return null;
  if (inCode(state, typed.from)) return null;
  const query = typed.text.slice(1);
  const ranked = rankCommands(query);
  if (ranked.length === 0) return null;
  // Browsing (nothing typed) groups the menu; a query ranks it flat.
  const browsing = query === "";
  return {
    from: typed.from,
    filter: false,
    options: ranked.map(
      (command): SlashCompletion => ({
        label: command.label,
        detail: command.syntax,
        section: browsing ? SECTIONS[command.section] : undefined,
        apply: apply(command),
        command,
      }),
    ),
  };
}

function glyph(completion: Completion): Node {
  const el = document.createElement("span");
  el.className = "cm-slash-glyph";
  el.textContent = (completion as SlashCompletion).command.glyph;
  return el;
}

function keys(completion: Completion): Node | null {
  const k = (completion as SlashCompletion).command.keys;
  if (!k) return null;
  const el = document.createElement("kbd");
  el.className = "cm-slash-keys";
  el.textContent = k;
  return el;
}

// ---- clickable checkboxes --------------------------------------------------

const boxOpen = Decoration.mark({ class: "cm-task-box" });
const boxDone = Decoration.mark({ class: "cm-task-box done" });
const doneText = Decoration.mark({ class: "cm-task-done" });

function taskDecorations(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "TaskMarker") return;
        const done = /x/i.test(view.state.sliceDoc(node.from + 1, node.to - 1));
        b.add(node.from, node.to, done ? boxDone : boxOpen);
        const lineEnd = view.state.doc.lineAt(node.to).to;
        if (done && lineEnd > node.to) b.add(node.to, lineEnd, doneText);
      },
    });
  }
  return b.finish();
}

const taskBoxes = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = taskDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = taskDecorations(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(e, view) {
        const el = (e.target as HTMLElement).closest(".cm-task-box");
        if (!el || e.button !== 0) return false;
        const pos = view.posAtDOM(el);
        const line = view.state.doc.lineAt(pos);
        const box = taskBox(line.text);
        if (!box) return false;
        e.preventDefault();
        view.dispatch({
          changes: { from: line.from + box.offset, to: line.from + box.offset + 1, insert: box.next },
          userEvent: "input",
        });
        return true;
      },
    },
  },
);

// ---- theme ---------------------------------------------------------------

const menuTheme = EditorView.theme({
  ".cm-tooltip.cm-tooltip-autocomplete": {
    background: "var(--panel)",
    border: "none",
    borderRadius: "var(--r-3)",
    boxShadow: "var(--float)",
    padding: "4px",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-ui)",
    maxHeight: "min(380px, 55vh)",
    minWidth: "320px",
    maxWidth: "min(480px, 90vw)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "4px 8px",
    borderRadius: "var(--r-1)",
    lineHeight: "1.35",
    color: "var(--ink)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "var(--accent-soft)",
    color: "var(--ink)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > completion-section": {
    display: "block",
    padding: "8px 8px 4px",
    border: "none",
    fontSize: "var(--fs-xs)",
    fontWeight: "600",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--ink-3)",
  },
  ".cm-completionLabel": { fontSize: "13px" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent)", fontWeight: "600" },
  ".cm-completionDetail": {
    marginLeft: "auto",
    paddingLeft: "12px",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    fontStyle: "normal",
    color: "var(--ink-3)",
    whiteSpace: "pre",
  },
  ".cm-slash-glyph": {
    flex: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "26px",
    height: "26px",
    borderRadius: "var(--r-1)",
    background: "var(--well)",
    boxShadow: "var(--ring)",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    fontWeight: "600",
    color: "var(--ink-2)",
  },
  ".cm-slash-keys": {
    flex: "none",
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    padding: "1px 5px",
    borderRadius: "3px",
    background: "var(--well)",
    color: "var(--ink-3)",
  },
  ".cm-task-box": { cursor: "pointer", color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: "0.9em" },
  ".cm-task-box.done": { color: "var(--ok)" },
  ".cm-task-done": { color: "var(--ink-3)", textDecoration: "line-through" },
});

/** The slash menu, the formatting shortcuts and clickable checkboxes. */
export function markdownEditing(): Extension[] {
  return [
    autocompletion({
      override: [slashSource],
      icons: false,
      activateOnTyping: true,
      // Query at once: "/todo" then a quick Enter must pick Checkbox, not
      // land in the 100 ms default wait and insert a newline.
      activateOnTypingDelay: 0,
      closeOnBlur: true,
      maxRenderedOptions: 60,
      addToOptions: [
        { render: glyph, position: 20 },
        { render: keys, position: 90 },
      ],
    }),
    Prec.high(
      keymap.of([
        { key: "Mod-b", run: toggleMark("**") },
        { key: "Mod-i", run: toggleMark("*") },
        { key: "Mod-Shift-s", run: toggleMark("~~"), preventDefault: true },
        { key: "Mod-Shift-c", run: toggleMark("`"), preventDefault: true },
        { key: "Mod-k", run: insertLink, preventDefault: true },
        { key: "Mod-Enter", run: toggleTasks },
        { key: "Mod-Alt-0", run: toggleBlock("text") },
        { key: "Mod-Alt-1", run: toggleBlock("h1") },
        { key: "Mod-Alt-2", run: toggleBlock("h2") },
        { key: "Mod-Alt-3", run: toggleBlock("h3") },
        { key: "Mod-Shift-7", run: toggleBlock("numbered") },
        { key: "Mod-Shift-8", run: toggleBlock("bullet") },
        { key: "Mod-Shift-9", run: toggleBlock("task") },
        { key: "Mod-Shift-.", run: toggleBlock("quote") },
      ]),
    ),
    taskBoxes,
    menuTheme,
  ];
}
