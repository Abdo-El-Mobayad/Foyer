import { useEffect, useState } from "react";
import * as ipc from "../lib/ipc";
import type { TextFile } from "../lib/ipc";
import { isSuperseded, latest } from "../lib/latest";

export type Loaded<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "error"; message: string };

/**
 * Reads go through `latest`: one in flight per slot, one waiting, and a
 * newer request replaces the waiting one before it reaches Rust. Only one
 * preview is mounted at a time, so a superseded request always belongs to a
 * view that is already gone; its rejection is dropped.
 */
function useLoaded<T>(slot: string, run: () => Promise<T>, deps: unknown[], keepReady: boolean): Loaded<T> {
  const [result, setResult] = useState<Loaded<T>>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    setResult((r) => (keepReady && r.state === "ready" ? r : { state: "loading" }));
    latest(slot, run)
      .then((value) => {
        if (!cancelled) setResult({ state: "ready", value });
      })
      .catch((e) => {
        if (!cancelled && !isSuperseded(e)) setResult({ state: "error", message: ipc.errorText(e) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return result;
}

/** A mounted file's text, re-read whenever `nonce` changes (a disk edit). */
export function useTextFile(mountId: string, path: string, nonce: number): Loaded<TextFile> {
  return useLoaded("text", () => ipc.readText(mountId, path), [mountId, path, nonce], true);
}

/** A mounted file's bytes, for the spreadsheet parser. */
export function useBytesFile(mountId: string, path: string, nonce: number): Loaded<Uint8Array> {
  return useLoaded("bytes", () => ipc.readBytes(mountId, path), [mountId, path, nonce], false);
}

export function useStat(mountId: string, path: string, nonce: number): Loaded<ipc.PathStat> {
  return useLoaded("stat", () => ipc.statPath(mountId, path), [mountId, path, nonce], true);
}
