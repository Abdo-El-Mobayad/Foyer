import { formatCount, formatMs } from "../lib/paths";
import { useStore } from "../store";
import { IconCollapse } from "./Icons";
import { ThemeToggle } from "./ThemeToggle";

/** Index status on the left, tree and theme controls on the right. */
export function SidebarFooter() {
  const stats = useStore((s) => s.indexStats);
  const collapseAll = useStore((s) => s.collapseAll);
  return (
    <div className="sidebar-footer">
      <span className="index-status" title={stats ? `${formatCount(stats.dirs)} folders` : "The name index is building"}>
        {stats ? (
          <>
            {formatCount(stats.files)} files
            <span className="index-dot" aria-hidden="true" />
            {formatMs(stats.builtMs)}
            {stats.truncated && <span className="index-flag">truncated</span>}
          </>
        ) : (
          <>
            <span className="index-pulse" aria-hidden="true" />
            indexing
          </>
        )}
      </span>
      <span className="sidebar-footer-actions">
        <button className="icon-btn" title="Collapse all folders" aria-label="Collapse all folders" onClick={collapseAll}>
          <IconCollapse />
        </button>
        <ThemeToggle />
      </span>
    </div>
  );
}
