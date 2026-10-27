// Latest-wins request coalescing. Pure (no Tauri), so it runs in tests.
//
// A preview read that is still in flight when the user moves on cannot be
// cancelled inside Rust, but the NEXT one can be: each named slot keeps one
// request in flight and at most one waiting. A newer request replaces the
// waiting one, which is rejected with SUPERSEDED before it ever reaches the
// backend. Holding arrow-down through twenty files costs two reads, not
// twenty.

export const SUPERSEDED = "superseded";

export function isSuperseded(err: unknown): boolean {
  return err === SUPERSEDED;
}

interface Job {
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface Slot {
  busy: boolean;
  next: Job | null;
}

const slots = new Map<string, Slot>();

function pump(s: Slot): void {
  if (s.busy || !s.next) return;
  const job = s.next;
  s.next = null;
  s.busy = true;
  let p: Promise<unknown>;
  try {
    p = job.run();
  } catch (e) {
    p = Promise.reject(e);
  }
  p.then(job.resolve, job.reject).finally(() => {
    s.busy = false;
    pump(s);
  });
}

/** Run `run` in `slot`, replacing any request still waiting there. */
export function latest<T>(slot: string, run: () => Promise<T>): Promise<T> {
  let s = slots.get(slot);
  if (!s) {
    s = { busy: false, next: null };
    slots.set(slot, s);
  }
  const mine = s;
  return new Promise<T>((resolve, reject) => {
    if (mine.next) mine.next.reject(SUPERSEDED);
    mine.next = { run, resolve: resolve as (v: unknown) => void, reject };
    pump(mine);
  });
}

/** Test hook: forget every slot. */
export function resetLatest(): void {
  slots.clear();
}
