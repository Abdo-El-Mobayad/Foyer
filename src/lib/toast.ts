import { useEffect, useState } from "react";

/**
 * Transient notifications. Deliberately outside the store: a toast is not
 * mount state and nothing else reads it, so the store's subscribers should
 * not re-render because a message appeared in the corner.
 *
 * `error` toasts do not auto-dismiss: a failure the user blinked past is a
 * failure they will report as "nothing happened".
 */
export type ToastTone = "success" | "error" | "neutral";

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  /** ms until auto-dismiss; 0 = sticky (errors). */
  ttl: number;
}

const DEFAULT_TTL = 3600;
const MAX_VISIBLE = 4;

let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();

function emit(): void {
  const snapshot = toasts;
  for (const l of listeners) l(snapshot);
}

export function toast(text: string, tone: ToastTone = "success"): number {
  const id = nextId++;
  const ttl = tone === "error" ? 0 : DEFAULT_TTL;
  toasts = [...toasts, { id, text, tone, ttl }].slice(-MAX_VISIBLE);
  emit();
  return id;
}

export function dismissToast(id: number): void {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function useToasts(): Toast[] {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    setList(toasts);
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}
