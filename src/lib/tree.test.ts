import { describe, expect, it } from "vitest";
import {
  countNodes,
  dropChildrenAt,
  findNode,
  flattenVisible,
  implicatedFolders,
  loadedFolderPaths,
  mergeChildren,
  setChildrenAt,
  sortNodes,
  type TreeNode,
} from "./tree";

const file = (path: string): TreeNode => ({
  id: path,
  name: path.split("/").pop()!,
  path,
  isDir: false,
  childrenLoaded: true,
  modified: 1,
  size: 1,
});
const dir = (path: string, children?: TreeNode[]): TreeNode => ({
  id: path,
  name: path.split("/").pop()!,
  path,
  isDir: true,
  children: children ?? [],
  childrenLoaded: children !== undefined,
  modified: 1,
  size: 0,
});

describe("tree helpers", () => {
  const root = [
    dir(".claude", [dir(".claude/skills", [file(".claude/skills/SKILL.md")]), file(".claude/settings.json")]),
    dir("Vault"),
    file("CLAUDE.md"),
  ];

  it("flattens only what is expanded and loaded", () => {
    const rows = flattenVisible(root, new Set([".claude", "Vault"]));
    expect(rows.map((r) => `${r.depth}:${r.node.path}`)).toEqual([
      "0:.claude",
      "1:.claude/skills",
      "1:.claude/settings.json",
      "0:Vault",
      "0:CLAUDE.md",
    ]);
    const deeper = flattenVisible(root, new Set([".claude", ".claude/skills"]));
    expect(deeper.map((r) => r.node.path)).toContain(".claude/skills/SKILL.md");
  });

  it("finds nodes by path", () => {
    expect(findNode(root, ".claude/skills/SKILL.md")?.name).toBe("SKILL.md");
    expect(findNode(root, "Vault/x.md")).toBeNull();
  });

  it("replaces children immutably and marks the folder loaded", () => {
    const next = setChildrenAt(root, "Vault", [file("Vault/INDEX.json")]);
    expect(next).not.toBe(root);
    expect(findNode(next, "Vault")?.childrenLoaded).toBe(true);
    expect(findNode(next, "Vault/INDEX.json")).not.toBeNull();
    expect(findNode(root, "Vault")?.childrenLoaded).toBe(false);
    expect(setChildrenAt(root, "", [file("only.md")]).length).toBe(1);
  });

  it("merges a fresh listing without folding loaded subtrees", () => {
    const previous = findNode(root, ".claude")!.children!;
    const fresh = [dir(".claude/skills"), dir(".claude/commands"), file(".claude/settings.json")];
    const merged = mergeChildren(previous, fresh);
    expect(findNode(merged, ".claude/skills")?.childrenLoaded).toBe(true);
    expect(findNode(merged, ".claude/skills/SKILL.md")).not.toBeNull();
    expect(findNode(merged, ".claude/commands")?.childrenLoaded).toBe(false);
  });

  it("lists loaded folders shallowest first and implicated parents", () => {
    expect(loadedFolderPaths(root)).toEqual(["", ".claude", ".claude/skills"]);
    const dirs = implicatedFolders([
      { path: "CLAUDE.md", kind: "modified" },
      { path: ".claude/skills/new.md", kind: "modified" },
      { path: ".claude/skills", kind: "removed" },
    ]);
    expect([...dirs].sort()).toEqual(["", ".claude", ".claude/skills"]);
  });

  it("sorts folders first, naturally", () => {
    const sorted = sortNodes([file("b10.md"), dir("z"), file("B2.md"), dir("A")]);
    expect(sorted.map((n) => n.name)).toEqual(["A", "z", "B2.md", "b10.md"]);
  });
});

describe("tree cache bounds", () => {
  const file = (path: string): TreeNode => ({ id: path, name: path.split("/").pop()!, path, isDir: false, modified: 0, size: 1 });
  const dir = (path: string, children?: TreeNode[]): TreeNode => ({
    id: path,
    name: path.split("/").pop()!,
    path,
    isDir: true,
    children: children ?? [],
    childrenLoaded: children !== undefined,
    modified: 0,
    size: 0,
  });
  const tree = [dir("a", [dir("a/b", [file("a/b/x.md"), file("a/b/y.md")]), file("a/z.md")]), file("top.md")];

  it("counts every loaded node", () => {
    expect(countNodes(tree)).toBe(6);
    expect(countNodes([])).toBe(0);
  });

  it("drops a collapsed folder's listing back to the lazy placeholder", () => {
    const next = dropChildrenAt(tree, "a/b");
    expect(countNodes(next)).toBe(4);
    const b = findNode(next, "a/b");
    expect(b?.childrenLoaded).toBe(false);
    expect(b?.children).toEqual([]);
    // Siblings and the original are untouched.
    expect(findNode(next, "a/z.md")).not.toBeNull();
    expect(findNode(tree, "a/b/x.md")).not.toBeNull();
    // Dropping a file or an unknown path is a no-op.
    expect(countNodes(dropChildrenAt(tree, "top.md"))).toBe(6);
    expect(countNodes(dropChildrenAt(tree, "nope"))).toBe(6);
  });
});
