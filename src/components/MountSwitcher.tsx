import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../lib/ipc";
import { displayPath } from "../lib/paths";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { ContextMenu, type MenuAnchor } from "./ContextMenu";
import { IconChevronDown, IconFolder, IconFolderOpen, IconPlus, IconVsCode, IconWarning } from "./Icons";

/**
 * The sidebar header: the open mount's name (a button that lists every
 * mount), its path, and the two launch buttons for the mount as a whole.
 */
export function MountSwitcher() {
  const mount = useStore((s) => s.mount);
  const mounts = useStore((s) => s.mounts);
  const openMount = useStore((s) => s.openMount);
  const addMount = useStore((s) => s.addMount);
  const removeMount = useStore((s) => s.removeMount);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!open) return;
    const onPress = (e: PointerEvent) => {
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPress, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!mount) return null;

  const openInVsCode = () =>
    void ipc.openInVsCode(mount.path, { newWindow: true }).catch(() => {
      toast("Could not open VS Code. Is it installed?", "error");
    });
  const reveal = () =>
    void ipc.revealInFileManager(mount.path).catch(() => {
      toast("Could not show that folder", "error");
    });

  return (
    <div className="mount-header" ref={popRef}>
      <div className="mount-row">
        <button
          className={`mount-name${open ? " open" : ""}`}
          onClick={() => setOpen((v) => !v)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY });
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
          title="Switch mount"
        >
          <span className="mount-name-text">{mount.name}</span>
          <IconChevronDown className="mount-chevron" />
        </button>
        <div className="mount-actions">
          <button
            className="icon-btn"
            title={`Open ${mount.path} in VS Code (new window)`}
            aria-label="Open mount in VS Code"
            onClick={openInVsCode}
          >
            <IconVsCode />
          </button>
          <button
            className="icon-btn"
            title={`Show ${mount.path} in Explorer`}
            aria-label="Show mount in Explorer"
            onClick={reveal}
          >
            <IconFolderOpen />
          </button>
        </div>
      </div>
      <div className="mount-path" title={mount.path}>
        {displayPath(mount.path)}
      </div>

      {open && (
        <div className="mount-pop" role="listbox" aria-label="Mounts">
          {mounts.map((m) => (
            <div
              key={m.id}
              role="option"
              aria-selected={m.id === mount.id}
              className={`mount-opt${m.id === mount.id ? " current" : ""}${m.missing ? " missing" : ""}`}
              onClick={() => {
                if (m.missing) return;
                setOpen(false);
                if (m.id !== mount.id) void openMount(m.id);
              }}
              title={m.path}
            >
              <span className="mount-opt-icon">{m.missing ? <IconWarning /> : <IconFolder />}</span>
              <span className="mount-opt-text">
                <span className="mount-opt-name">{m.name}</span>
                <span className="mount-opt-path">{displayPath(m.path)}</span>
              </span>
              {m.missing && <span className="mount-opt-flag">missing</span>}
            </div>
          ))}
          <button
            className="mount-add"
            onClick={() => {
              setOpen(false);
              void addMount();
            }}
          >
            <IconPlus />
            Mount another folder
          </button>
        </div>
      )}

      {menu && (
        <ContextMenu
          anchor={menu}
          onClose={closeMenu}
          label={`Actions for ${mount.name}`}
          items={[
            { label: "Open in VS Code", onSelect: openInVsCode },
            { label: "Show in Explorer", onSelect: reveal },
            {
              label: "Copy path",
              onSelect: () =>
                void ipc.copyText(mount.path).then((ok) => {
                  toast(ok ? "Path copied" : "Could not copy the path", ok ? "success" : "error");
                }),
            },
            {
              label: "Remove mount",
              sep: true,
              danger: true,
              onSelect: () => void removeMount(mount.id),
            },
          ]}
        />
      )}
    </div>
  );
}
