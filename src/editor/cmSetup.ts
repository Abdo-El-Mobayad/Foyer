// CodeMirror for notes: Markdown with the GitHub extensions, undo, search,
// list continuation on Enter, the slash menu and formatting shortcuts
// (markdownEditing.ts), and the app's design tokens as the theme (CSS
// variables, so light and dark need no second theme). Loaded only with the
// editor chunk.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, highlightSpecialChars, keymap, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { markdownEditing } from "./markdownEditing";
import { flush, noteUpdated, type Session } from "./sessions";

// Markup characters (#, *, >, list markers, backticks) recede; headings keep
// their weight; code switches to the mono face. Everything else is body text.
const noteHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.55em", fontWeight: "650", letterSpacing: "-0.02em" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "650", letterSpacing: "-0.01em" },
  { tag: t.heading3, fontSize: "1.12em", fontWeight: "600" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "600" },
  { tag: t.strong, fontWeight: "650" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.87em" },
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName], color: "var(--ink-3)" },
  { tag: t.quote, color: "var(--ink-2)" },
  { tag: t.comment, color: "var(--hl-comment)" },
  { tag: [t.escape, t.character], color: "var(--hl-number)" },
  { tag: t.atom, color: "var(--accent)" },
]);

const mix = (pct: number) => `color-mix(in srgb, var(--accent) ${pct}%, transparent)`;

const noteTheme = EditorView.theme({
  "&": { color: "var(--ink)", backgroundColor: "transparent", fontSize: "15px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-ui)", lineHeight: "1.65", overflow: "visible" },
  ".cm-content": { padding: "0 0 40vh", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  ".cm-selectionBackground": { backgroundColor: "var(--active)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { backgroundColor: mix(22) },
  ".cm-content ::selection": { backgroundColor: mix(22) },
  ".cm-placeholder": { color: "var(--ink-3)" },
  ".cm-specialChar": { color: "var(--danger)" },
  ".cm-searchMatch": { backgroundColor: mix(16), outline: `1px solid ${mix(40)}`, borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: mix(38) },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--ink)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)", marginBottom: "12px" },
  ".cm-panel.cm-search": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    padding: "8px 28px 8px 8px",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-sm)",
  },
  ".cm-panel.cm-search br": { display: "none" },
  ".cm-panel.cm-search label": { display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--ink-2)" },
  ".cm-panel.cm-search input[type=checkbox]": { accentColor: "var(--accent)", margin: "0" },
  ".cm-textfield": {
    height: "26px",
    margin: "0",
    padding: "0 8px",
    border: "0",
    borderRadius: "var(--r-1)",
    background: "var(--well)",
    color: "var(--ink)",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    outline: "none",
  },
  ".cm-textfield:focus": { boxShadow: "var(--accent-ring)" },
  ".cm-button": {
    height: "26px",
    margin: "0",
    padding: "0 10px",
    border: "0",
    borderRadius: "var(--r-1)",
    backgroundImage: "none",
    background: "var(--panel)",
    boxShadow: "var(--ring)",
    color: "var(--ink)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-sm)",
    textTransform: "none",
  },
  ".cm-button:hover": { background: "var(--well)" },
  ".cm-panel.cm-search [name=close]": {
    top: "8px",
    right: "8px",
    color: "var(--ink-3)",
    fontSize: "16px",
    cursor: "pointer",
  },
});

/** Everything a note's CodeMirror state carries. `s` is the session the
 *  state belongs to; its updates and Ctrl+S go to it. */
export function noteExtensions(s: Session): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    EditorState.allowMultipleSelections.of(true),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(noteHighlight),
    search({ top: true }),
    placeholder("Start writing, or type / for blocks and formatting"),
    EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "off", "aria-label": "Note editor" }),
    Prec.high(
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void flush(s.path);
            return true;
          },
        },
      ]),
    ),
    ...markdownEditing(),
    keymap.of([...searchKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
    EditorView.updateListener.of((u) => noteUpdated(s, u)),
    noteTheme,
  ];
}

export function buildNoteState(doc: string, s: Session): EditorState {
  return EditorState.create({ doc, extensions: noteExtensions(s) });
}
