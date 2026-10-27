import { useEffect, useRef, useState } from "react";
import { useDialogs, type Dialog } from "../lib/dialogs";

/** Renders the open dialog, if any. Enter confirms, Escape or a click on the
 *  backdrop cancels. */
export function DialogHost() {
  const current = useDialogs((s) => s.current);
  if (!current) return null;
  const cancel = () => (current.kind === "name" ? current.resolve(null) : current.resolve(false));
  return (
    <div className="overlay-backdrop dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      {current.kind === "name" ? (
        <NameDialog dialog={current} onCancel={cancel} />
      ) : (
        <ConfirmDialog dialog={current} onCancel={cancel} />
      )}
    </div>
  );
}

function NameDialog({
  dialog,
  onCancel,
}: {
  dialog: Extract<Dialog, { kind: "name" }>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(dialog.initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const problem = dialog.validate(value);
  // Say nothing until the user has typed: an untouched default is not an error.
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, dialog.selectLength ?? dialog.initial.length);
  }, [dialog]);

  const submit = () => {
    setTouched(true);
    if (!problem) dialog.resolve(value);
  };

  return (
    <div
      className="dialog"
      role="dialog"
      aria-modal="true"
      aria-label={dialog.title}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onCancel();
        else if (e.key === "Enter") submit();
      }}
    >
      <div className="dialog-title">{dialog.title}</div>
      {dialog.context && <div className="dialog-context">{dialog.context}</div>}
      <div className={`dialog-field${touched && problem ? " invalid" : ""}`}>
        <input
          ref={inputRef}
          value={value}
          spellCheck={false}
          onChange={(e) => {
            setTouched(true);
            setValue(e.target.value);
          }}
        />
        {dialog.suffix && <span className="dialog-suffix">{dialog.suffix}</span>}
      </div>
      <div className="dialog-error" aria-live="polite">
        {touched && problem ? problem : ""}
      </div>
      <div className="dialog-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={!!problem} onClick={submit}>
          {dialog.confirmLabel}
        </button>
      </div>
    </div>
  );
}

function ConfirmDialog({
  dialog,
  onCancel,
}: {
  dialog: Extract<Dialog, { kind: "confirm" }>;
  onCancel: () => void;
}) {
  const okRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => okRef.current?.focus(), []);
  return (
    <div
      className="dialog"
      role="alertdialog"
      aria-modal="true"
      aria-label={dialog.title}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="dialog-title">{dialog.title}</div>
      <div className="dialog-body">{dialog.body}</div>
      <div className="dialog-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          ref={okRef}
          className={`btn ${dialog.danger ? "danger" : "primary"}`}
          onClick={() => dialog.resolve(true)}
        >
          {dialog.confirmLabel}
        </button>
      </div>
    </div>
  );
}
