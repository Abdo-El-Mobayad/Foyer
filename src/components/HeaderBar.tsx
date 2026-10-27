import { Fragment, useCallback, useState } from "react";
import * as ipc from "../lib/ipc";
import { joinAbs } from "../lib/paths";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { ContextMenu, type MenuAnchor } from "./ContextMenu";
import { IconMore, IconSidebar, IconVsCode } from "./Icons";

/**
 * The strip above the tabs: a breadcrumb of the open file (each folder
 * segment reveals that folder in the tree) and, on the right, the one button
 * this app exists for.
 */
export function HeaderBar() {
  const mount = useStore((s) => s.mount);
  const active = useStore((s) => s.active);
  const sidebarShown = useStore((s) => s.sidebarShown);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  if (!mount) return null;

  const segments = active ? active.split("/") : [];
  const target = active ? joinAbs(mount.path, active) : mount.path;

  const openVsCode = () =>
    void ipc.openInVsCode(target, { newWindow: !active }).catch(() => {
      toast("Could not open VS Code. Is it installed?", "error");
    });

  return (
    <header className="header">
      {!sidebarShown && (
        <button className="icon-btn" title="Show sidebar (Ctrl+B)" aria-label="Show sidebar" onClick={toggleSidebar}>
          <IconSidebar />
        </button>
      )}
      <nav className="crumbs" aria-label="Path">
        <button
          className="crumb crumb-root"
          onClick={() => useStore.getState().collapseAll()}
          title="Collapse every folder"
        >
          {mount.name}
        </button>
        {segments.map((seg, i) => {
          const isLast = i === segments.length - 1;
          const path = segments.slice(0, i + 1).join("/");
          return (
            <Fragment key={path}>
              <span className="crumb-sep" aria-hidden="true">
                /
              </span>
              {isLast ? (
                <span className="crumb crumb-leaf" title={active ?? ""}>
                  {seg}
                </span>
              ) : (
                <button
                  className="crumb"
                  title={`Reveal ${path}`}
                  onClick={() => {
                    const st = useStore.getState();
                    void st.revealPath(path).then(() => st.setExpanded(path, true));
                  }}
                >
                  {seg}
                </button>
              )}
            </Fragment>
          );
        })}
      </nav>
      <div className="header-actions">
        <button
          className="btn primary"
          onClick={openVsCode}
          title={active ? `Open ${active} in VS Code (Ctrl+Shift+O)` : `Open ${mount.name} in a new VS Code window (Ctrl+Shift+O)`}
        >
          <IconVsCode />
          <span>Open in VS Code</span>
        </button>
        <button
          className="icon-btn"
          title="More actions"
          aria-label="More actions"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right - 220, y: r.bottom + 6, flipAbove: r.top - 6 });
          }}
        >
          <IconMore />
        </button>
      </div>
      {menu && (
        <ContextMenu
          anchor={menu}
          onClose={closeMenu}
          label="File actions"
          items={[
            {
              label: active ? "Open mount in VS Code (new window)" : "Open in VS Code (new window)",
              onSelect: () =>
                void ipc.openInVsCode(mount.path, { newWindow: true }).catch(() => {
                  toast("Could not open VS Code. Is it installed?", "error");
                }),
            },
            {
              label: "Show in Explorer",
              onSelect: () =>
                void ipc.revealInFileManager(target).catch(() => {
                  toast("Could not show that in Explorer", "error");
                }),
            },
            {
              label: "Copy path",
              onSelect: () =>
                void ipc.copyText(target).then((ok) => {
                  toast(ok ? "Path copied" : "Could not copy the path", ok ? "success" : "error");
                }),
            },
            {
              label: "Open in default app",
              disabled: !active,
              onSelect: () => {
                if (!active) return;
                void ipc.openInDefaultApp(mount.id, active).catch(() => {
                  toast("Could not open that with its default app", "error");
                });
              },
            },
            {
              label: "Reload tree",
              sep: true,
              hint: "Ctrl+R",
              onSelect: () => void useStore.getState().reloadTree(),
            },
            {
              label: sidebarShown ? "Hide sidebar" : "Show sidebar",
              hint: "Ctrl+B",
              onSelect: toggleSidebar,
            },
          ]}
        />
      )}
    </header>
  );
}
