import { beforeEach, describe, expect, it } from "vitest";
import { isSuperseded, latest, resetLatest, SUPERSEDED } from "./latest";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("latest", () => {
  beforeEach(() => resetLatest());

  it("runs the first request at once and queues the second", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    let started = 0;
    const pa = latest("t", () => (started++, a.promise));
    const pb = latest("t", () => (started++, b.promise));
    expect(started).toBe(1);
    a.resolve("A");
    await expect(pa).resolves.toBe("A");
    await Promise.resolve();
    expect(started).toBe(2);
    b.resolve("B");
    await expect(pb).resolves.toBe("B");
  });

  it("a newer request replaces the waiting one, which never runs", async () => {
    const a = deferred<string>();
    const c = deferred<string>();
    let bRan = false;
    const pa = latest("t", () => a.promise);
    const pb = latest("t", () => ((bRan = true), Promise.resolve("B")));
    const pc = latest("t", () => c.promise);
    await expect(pb).rejects.toBe(SUPERSEDED);
    expect(isSuperseded(SUPERSEDED)).toBe(true);
    a.resolve("A");
    await expect(pa).resolves.toBe("A");
    c.resolve("C");
    await expect(pc).resolves.toBe("C");
    expect(bRan).toBe(false);
  });

  it("slots are independent and a failure frees the slot", async () => {
    const a = deferred<string>();
    const pa = latest("x", () => a.promise);
    const py = latest("y", () => Promise.resolve("Y"));
    await expect(py).resolves.toBe("Y");
    a.reject(new Error("disk"));
    await expect(pa).rejects.toThrow("disk");
    await expect(latest("x", () => Promise.resolve("again"))).resolves.toBe("again");
    // A synchronous throw inside `run` is a rejection, not a stuck slot.
    await expect(
      latest("x", () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    await expect(latest("x", () => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});
