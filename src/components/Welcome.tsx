import { useStore } from "../store";
import { displayPath } from "../lib/paths";
import { IconFolder, IconPlus, IconTrash, IconWarning } from "./Icons";
import { ThemeToggle } from "./ThemeToggle";

/** The screen with no mount open: mount a folder, or reopen a known one. */
export function Welcome() {
  const mounts = useStore((s) => s.mounts);
  const addMount = useStore((s) => s.addMount);
  const openMount = useStore((s) => s.openMount);
  const removeMount = useStore((s) => s.removeMount);

  return (
    <div className="welcome">
      <div className="welcome-theme">
        <ThemeToggle />
      </div>
      <div className="welcome-card">
        <div className="welcome-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h1>Foyer</h1>
        <p>
          Mount a folder to see every file in it, preview Markdown, HTML and
          spreadsheets, search by name, and open anything in VS Code.
        </p>
        <button className="btn primary lg" onClick={() => void addMount()}>
          <IconPlus />
          Mount a folder
        </button>

        {mounts.length > 0 && (
          <ul className="welcome-mounts" aria-label="Mounted folders">
            {mounts.map((m) => (
              <li key={m.id} className={m.missing ? "missing" : ""}>
                <button
                  className="welcome-mount"
                  disabled={m.missing}
                  onClick={() => void openMount(m.id)}
                  title={m.missing ? `${m.path} is not available` : m.path}
                >
                  <span className="welcome-mount-icon">
                    {m.missing ? <IconWarning /> : <IconFolder />}
                  </span>
                  <span className="welcome-mount-text">
                    <span className="welcome-mount-name">{m.name}</span>
                    <span className="welcome-mount-path">{displayPath(m.path)}</span>
                  </span>
                </button>
                <button
                  className="icon-btn welcome-mount-remove"
                  title="Remove from the list (nothing on disk is touched)"
                  aria-label={`Remove ${m.name}`}
                  onClick={() => void removeMount(m.id)}
                >
                  <IconTrash />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="welcome-note">
          Nothing is copied, synced or written. Removing a mount only forgets it.
        </p>
      </div>
    </div>
  );
}
