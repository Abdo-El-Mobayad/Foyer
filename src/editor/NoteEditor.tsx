import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { TextFile } from "../lib/ipc";
import type { ReadingWidth } from "../lib/prefs";
import { ReadingWidthHandles } from "../preview/ReadingWidthHandles";
import { buildNoteState } from "./cmSetup";
import { attachView, detachView, getSession, openSession } from "./sessions";

interface Props {
  mountId: string;
  path: string;
  /** The file as last read, or null while it is (re)loading or cannot be
   *  read (deleted under unsaved text): the open note is then shown as is. */
  file: TextFile | null;
  /** The reading column, shared with rendered Markdown so Edit and Preview
   *  line up. Split passes none and the editor fills its pane. */
  reading?: {
    width: ReadingWidth;
    set: (w: Partial<ReadingWidth>) => void;
    commit: (w: Partial<ReadingWidth>) => void;
  };
  /** Called after each typed change (the split preview re-renders). */
  onEdit?: () => void;
}

/**
 * CodeMirror on a note. The view is a window onto the note's session
 * (`sessions.ts`): it is created on mount from the session's state and
 * destroyed on unmount, while the document, undo history and pending save
 * stay with the session. Later reads of the file reach the session through
 * MarkdownView, never by rebuilding this view.
 *
 * The editor sits inside the same scroller and column as rendered Markdown;
 * CodeMirror measures its viewport through scrolling ancestors, so only the
 * visible lines are in the DOM either way.
 */
export default function NoteEditor({ mountId, path, file, reading, onEdit }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;

  useEffect(() => {
    const host = hostRef.current;
    const s = file ? openSession(mountId, path, file, buildNoteState) : getSession(path);
    if (!host || !s) return;
    const view = new EditorView({ state: s.state, parent: host });
    attachView(s, view);
    s.onEdit = () => onEditRef.current?.();
    viewRef.current = view;
    const scroller = scrollRef.current;
    const top = s.scrollTop;
    if (scroller && top > 0) {
      scroller.scrollTop = top;
      // CodeMirror measures on the next frame; land there once heights are real.
      requestAnimationFrame(() => {
        if (viewRef.current === view) scroller.scrollTop = top;
      });
    }
    view.focus();
    return () => {
      detachView(s, scroller?.scrollTop ?? 0);
      s.onEdit = null;
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountId, path]);

  // A press in the column's margins lands the cursor on the nearest text,
  // the way a click beside a paragraph does in a word processor.
  const onMouseDown = (e: React.MouseEvent) => {
    const view = viewRef.current;
    if (!view || e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".cm-editor, .reading-resizer")) return;
    e.preventDefault();
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
  };

  const full = !reading || reading.width.full;
  const px = reading?.width.px ?? null;
  return (
    <div className="doc-scroll note-scroll" ref={scrollRef} onMouseDown={onMouseDown}>
      <article
        className={`markdown note-column${full ? " full" : ""}`}
        ref={articleRef}
        style={px === null ? undefined : ({ "--reading-w": `${px}px` } as React.CSSProperties)}
      >
        {reading && (
          <ReadingWidthHandles
            width={reading.width}
            articleRef={articleRef}
            onWidth={reading.set}
            onCommit={reading.commit}
          />
        )}
        <div className="note-host" ref={hostRef} />
      </article>
    </div>
  );
}
