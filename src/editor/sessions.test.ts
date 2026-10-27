import { EditorState } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextFile } from "../lib/ipc";

// Disk as the sessions see it: one file per path, an mtime that moves on
// every write, and Rust's mtime guard.
const disk = new Map<string, { text: string; modified: number }>();
let clock = 1000;
const writes: Array<{ rel: string; text: string; expected: number | null }> = [];

vi.mock("../lib/ipc", () => ({
  writeText: vi.fn(async (_id: string, rel: string, text: string, expected: number | null) => {
    writes.push({ rel, text, expected });
    const cur = disk.get(rel);
    if (expected !== null) {
      if (!cur) throw "conflict: deleted on disk";
      if (cur.modified !== expected) throw "conflict: changed on disk";
    }
    const modified = ++clock;
    disk.set(rel, { text, modified });
    return { modified, bytes: text.length };
  }),
  readText: vi.fn(async (_id: string, rel: string) => {
    const cur = disk.get(rel);
    if (!cur) throw "not found";
    return file(cur.text, cur.modified);
  }),
  errorText: (e: unknown) => String(e),
  humanError: (e: unknown) => String(e).replace(/^[a-z-]+: /, ""),
}));

const notes = await import("./sessions");
const { AUTOSAVE_MS } = notes;

function file(text: string, modified: number): TextFile {
  return { text, modified, truncated: false, lossy: false, bytes: text.length };
}

function put(rel: string, text: string): TextFile {
  const modified = ++clock;
  disk.set(rel, { text, modified });
  return file(text, modified);
}

function open(rel: string, text: string) {
  return notes.openSession("m1", rel, put(rel, text), (doc) => EditorState.create({ doc }));
}

/** What a view reports after the user types `insert` at the end. */
function type(s: ReturnType<typeof open>, insert: string) {
  const tr = s.state.update({ changes: { from: s.state.doc.length, insert } });
  notes.noteUpdated(s, { state: tr.state, docChanged: true, transactions: [tr] } as unknown as ViewUpdate);
}

const status = (rel: string) => notes.useNotes.getState().notes[rel]?.status;

beforeEach(() => {
  vi.useFakeTimers();
  disk.clear();
  writes.length = 0;
});

afterEach(() => {
  notes.discardAll();
  vi.useRealTimers();
});

describe("note sessions", () => {
  it("autosaves after the quiet period, in the file's own shape", async () => {
    const s = open("a.md", "﻿# A\r\n");
    type(s, "more\n");
    expect(status("a.md")).toBe("dirty");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 10);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toBe("﻿# A\r\nmore\r\n");
    expect(disk.get("a.md")!.text).toBe("﻿# A\r\nmore\r\n");
    expect(status("a.md")).toBe("clean");
  });

  it("restarts the timer on every keystroke and writes once", async () => {
    const s = open("a.md", "x");
    for (let i = 0; i < 5; i++) {
      type(s, String(i));
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS / 2);
    }
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toBe("x01234");
  });

  it("ignores its own save echoed back by the watcher", async () => {
    const s = open("a.md", "one");
    type(s, " two");
    expect(await notes.flush("a.md")).toBe(true);
    const cur = disk.get("a.md")!;
    notes.observeDisk("a.md", file(cur.text, cur.modified));
    expect(s.state.doc.toString()).toBe("one two");
    expect(status("a.md")).toBe("clean");
  });

  it("adopts another writer's change when nothing is unsaved", () => {
    const s = open("a.md", "line one\nline two\n");
    notes.observeDisk("a.md", put("a.md", "line one\nline 2\n"));
    expect(s.state.doc.toString()).toBe("line one\nline 2\n");
    expect(s.baseline).toBe("line one\nline 2\n");
    expect(status("a.md")).toBe("clean");
  });

  it("never overwrites unsaved text: a conflict, then either choice", async () => {
    const s = open("a.md", "base");
    type(s, " mine");
    notes.observeDisk("a.md", put("a.md", "theirs"));
    expect(status("a.md")).toBe("conflict");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 3);
    expect(writes).toHaveLength(0);
    expect(await notes.flush("a.md")).toBe(false);

    await notes.keepMine("a.md");
    expect(writes[writes.length - 1]).toMatchObject({ text: "base mine", expected: null });
    expect(status("a.md")).toBe("clean");

    type(s, "!");
    notes.observeDisk("a.md", put("a.md", "theirs again"));
    notes.reloadFromDisk("a.md");
    expect(s.state.doc.toString()).toBe("theirs again");
    expect(status("a.md")).toBe("clean");
  });

  it("catches a change the watcher has not reported yet, at save time", async () => {
    const s = open("a.md", "base");
    put("a.md", "sneaky");
    type(s, " mine");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 10);
    expect(disk.get("a.md")!.text).toBe("sneaky");
    expect(notes.useNotes.getState().notes["a.md"].conflict).toMatchObject({ kind: "changed", text: "sneaky" });
  });

  it("retries silently when the file was only touched", async () => {
    const s = open("a.md", "same");
    put("a.md", "same");
    type(s, " more");
    expect(await notes.flush("a.md")).toBe(true);
    expect(disk.get("a.md")!.text).toBe("same more");
    expect(writes).toHaveLength(2);
  });

  it("does not convert back line endings someone changed on disk", async () => {
    const s = open("a.md", "one\r\ntwo\r\n");
    // Same text, now LF: a touch as far as the note is concerned.
    notes.observeDisk("a.md", put("a.md", "one\ntwo\n"));
    type(s, "three\n");
    expect(await notes.flush("a.md")).toBe(true);
    expect(disk.get("a.md")!.text).toBe("one\ntwo\nthree\n");
  });

  it("writes a reloaded note in the disk's shape", async () => {
    const s = open("a.md", "\uFEFFbase\r\n");
    type(s, "mine");
    notes.observeDisk("a.md", put("a.md", "theirs\nline\n"));
    notes.reloadFromDisk("a.md");
    type(s, "more");
    expect(await notes.flush("a.md")).toBe(true);
    expect(disk.get("a.md")!.text).toBe("theirs\nline\nmore");
  });

  it("reports a deleted file instead of recreating it", async () => {
    const s = open("a.md", "x");
    type(s, "y");
    disk.delete("a.md");
    expect(await notes.flush("a.md")).toBe(false);
    expect(notes.useNotes.getState().notes["a.md"].conflict).toEqual({ kind: "deleted" });
    await notes.keepMine("a.md");
    expect(disk.get("a.md")!.text).toBe("xy");
  });

  it("keeps a removed file's tab only when it holds unsaved text", () => {
    open("clean.md", "c");
    expect(notes.onRemoved("clean.md")).toBe(false);
    expect(notes.getSession("clean.md")).toBeUndefined();
    const s = open("dirty.md", "d");
    type(s, "!");
    expect(notes.onRemoved("dirty.md")).toBe(true);
    expect(status("dirty.md")).toBe("conflict");
  });

  it("forgets a closed tab's note once saved, keeps one that failed", async () => {
    const a = open("a.md", "a");
    type(a, "1");
    notes.release(["a.md"]);
    await vi.runAllTimersAsync();
    expect(disk.get("a.md")!.text).toBe("a1");
    expect(notes.getSession("a.md")).toBeUndefined();

    const b = open("b.md", "b");
    type(b, "2");
    disk.delete("b.md");
    notes.release(["b.md"]);
    await vi.runAllTimersAsync();
    expect(notes.getSession("b.md")).toBeDefined();
    expect(notes.sessionText("b.md")).toBe("b2");
  });

  it("follows a rename with its status and pending text", async () => {
    const s = open("dir/n.md", "n");
    type(s, "+");
    notes.renameSessions("dir", "folder");
    expect(notes.getSession("dir/n.md")).toBeUndefined();
    expect(notes.getSession("folder/n.md")).toBe(s);
    expect(status("dir/n.md")).toBeUndefined();
    expect(status("folder/n.md")).toBe("dirty");
    disk.set("folder/n.md", disk.get("dir/n.md")!);
    expect(await notes.flush("folder/n.md")).toBe(true);
    expect(disk.get("folder/n.md")!.text).toBe("n+");
  });

  it("names every note that could not be saved", async () => {
    const a = open("a.md", "a");
    const b = open("b.md", "b");
    type(a, "1");
    type(b, "2");
    disk.delete("b.md");
    expect(await notes.flushAll()).toEqual(["b.md"]);
  });
});
