import { useEffect, useRef } from "react";
import { dismissToast, useToasts, type Toast } from "../lib/toast";

/** Bottom-right stack. Hovering it pauses every auto-dismiss. */
export function Toasts() {
  const toasts = useToasts();
  const hovering = useRef(false);
  return (
    <div
      className="toast-viewport"
      onMouseEnter={() => {
        hovering.current = true;
      }}
      onMouseLeave={() => {
        hovering.current = false;
      }}
    >
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} hovering={hovering} />
      ))}
    </div>
  );
}

function ToastRow({ toast, hovering }: { toast: Toast; hovering: React.RefObject<boolean> }) {
  useEffect(() => {
    if (toast.ttl === 0) return;
    let left = toast.ttl;
    const STEP = 100;
    const tick = window.setInterval(() => {
      if (hovering.current) return;
      left -= STEP;
      if (left <= 0) {
        window.clearInterval(tick);
        dismissToast(toast.id);
      }
    }, STEP);
    return () => window.clearInterval(tick);
  }, [toast.id, toast.ttl, hovering]);

  return (
    <div className={`toast toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
      <span className="toast-dot" aria-hidden="true" />
      <span className="toast-text">{toast.text}</span>
      <button className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
        ×
      </button>
    </div>
  );
}
