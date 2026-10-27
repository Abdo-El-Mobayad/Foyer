// Modal questions: a name to type, or a yes/no. One at a time, rendered by
// `DialogHost`, awaited by whoever asked. A second request while one is open
// is answered "cancel" at once rather than stacked.

import { create } from "zustand";

export interface NameRequest {
  title: string;
  /** A muted line under the title, e.g. the folder the note goes into. */
  context?: string;
  initial: string;
  /** Characters of `initial` selected on open (the stem of a file name). */
  selectLength?: number;
  /** Shown after the field, e.g. ".md" when it is appended for the user. */
  suffix?: string;
  confirmLabel: string;
  /** Why the value cannot be used, or null. Runs on every keystroke. */
  validate: (value: string) => string | null;
}

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
}

export type Dialog =
  | (NameRequest & { kind: "name"; resolve: (value: string | null) => void })
  | (ConfirmRequest & { kind: "confirm"; resolve: (ok: boolean) => void });

export const useDialogs = create<{ current: Dialog | null }>(() => ({ current: null }));

export const dialogOpen = () => useDialogs.getState().current !== null;

export function promptName(req: NameRequest): Promise<string | null> {
  if (dialogOpen()) return Promise.resolve(null);
  return new Promise((resolve) => {
    useDialogs.setState({
      current: {
        ...req,
        kind: "name",
        resolve: (value) => {
          useDialogs.setState({ current: null });
          resolve(value);
        },
      },
    });
  });
}

export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
  if (dialogOpen()) return Promise.resolve(false);
  return new Promise((resolve) => {
    useDialogs.setState({
      current: {
        ...req,
        kind: "confirm",
        resolve: (ok) => {
          useDialogs.setState({ current: null });
          resolve(ok);
        },
      },
    });
  });
}
