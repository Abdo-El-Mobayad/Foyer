import { useStore } from "../store";

/** Mount open, nothing selected. */
export function EmptyView() {
  const mount = useStore((s) => s.mount);
  const stats = useStore((s) => s.indexStats);
  return (
    <div className="empty-view">
      <div className="empty-card">
        <div className="empty-title">{mount?.name}</div>
        <div className="empty-sub">
          {stats ? `${stats.files.toLocaleString("en-US")} files across ${stats.dirs.toLocaleString("en-US")} folders` : "Indexing file names…"}
        </div>
        <dl className="keys">
          <div>
            <dt>
              <kbd>Ctrl</kbd>
              <kbd>P</kbd>
            </dt>
            <dd>Search file names</dd>
          </div>
          <div>
            <dt>
              <kbd>Ctrl</kbd>
              <kbd>Shift</kbd>
              <kbd>O</kbd>
            </dt>
            <dd>Open in VS Code</dd>
          </div>
          <div>
            <dt>
              <kbd>Ctrl</kbd>
              <kbd>W</kbd>
            </dt>
            <dd>Close tab</dd>
          </div>
          <div>
            <dt>
              <kbd>Ctrl</kbd>
              <kbd>Tab</kbd>
            </dt>
            <dd>Next tab</dd>
          </div>
          <div>
            <dt>
              <kbd>Ctrl</kbd>
              <kbd>B</kbd>
            </dt>
            <dd>Toggle sidebar</dd>
          </div>
          <div>
            <dt>
              <kbd>↑</kbd>
              <kbd>↓</kbd>
              <kbd>←</kbd>
              <kbd>→</kbd>
            </dt>
            <dd>Move in the tree</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
