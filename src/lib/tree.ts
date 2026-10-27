// Pure helpers for the lazily loaded sidebar tree. No Tauri, no DOM.

import { compareNames } from "./paths";

export interface TreeNode {
  id: string;
  name: string;
  /** Mount-relative, forward-slash path. */
  path: string;
  isDir: boolean;
  children?: TreeNode[];
  /** Directories only: is `children` the real listing or the lazy placeholder? */
  childrenLoaded?: boolean;
  modified: number;
  size: number;
}

/** One rendered row of the tree. */
export interface Row {
  node: TreeNode;
  depth: number;
  expanded: boolean;
}

/** Folders first, then files, each in natural name order. */
export function sortNodes(nodes: TreeNode[]): TreeNode[] {
  const dirs = nodes.filter((n) => n.isDir).sort((a, b) => compareNames(a.name, b.name));
  const files = nodes.filter((n) => !n.isDir).sort((a, b) => compareNames(a.name, b.name));
  return [...dirs, ...files];
}

/** The visible rows given which folders are expanded, depth-first. A folder
 *  that is expanded but not yet loaded contributes no rows beneath it. */
export function flattenVisible(nodes: TreeNode[], expanded: ReadonlySet<string>): Row[] {
  const out: Row[] = [];
  const walk = (list: TreeNode[], depth: number) => {
    for (const n of list) {
      const isOpen = n.isDir && expanded.has(n.path);
      out.push({ node: n, depth, expanded: isOpen });
      if (isOpen && n.children) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

/** The node at `path`, or null if it is not in the loaded tree. */
export function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.isDir && n.children && path.startsWith(n.path + "/")) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

/** Immutably replace one folder's `children` (by path) and mark it loaded.
 *  `path === ""` replaces the root list. */
export function setChildrenAt(nodes: TreeNode[], path: string, children: TreeNode[]): TreeNode[] {
  if (path === "") return children;
  return nodes.map((n) => {
    if (n.path === path) return { ...n, children, childrenLoaded: true };
    if (n.isDir && n.children && path.startsWith(n.path + "/")) {
      return { ...n, children: setChildrenAt(n.children, path, children) };
    }
    return n;
  });
}

/** A fresh listing of one folder with previously loaded subtrees carried
 *  over, so re-listing a folder never folds up what was expanded beneath it. */
export function mergeChildren(previous: TreeNode[] | undefined, fresh: TreeNode[]): TreeNode[] {
  if (!previous || previous.length === 0) return fresh;
  const byPath = new Map<string, TreeNode>();
  for (const p of previous) if (p.isDir && p.childrenLoaded) byPath.set(p.path, p);
  if (byPath.size === 0) return fresh;
  return fresh.map((node) => {
    if (!node.isDir || node.childrenLoaded) return node;
    const loaded = byPath.get(node.path);
    return loaded ? { ...node, children: loaded.children, childrenLoaded: true } : node;
  });
}

/** Every loaded folder path, shallowest first, root ("") included. */
export function loadedFolderPaths(nodes: TreeNode[]): string[] {
  const out: string[] = [""];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      if (!n.isDir) continue;
      if (n.childrenLoaded) out.push(n.path);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out.sort((a, b) => a.split("/").length - b.split("/").length);
}

/** The folders whose listing a batch of changes can have altered: the parent
 *  of every changed path. */
export function implicatedFolders(
  changes: ReadonlyArray<{ path: string; kind: string }>,
): Set<string> {
  const dirs = new Set<string>();
  for (const c of changes) {
    const i = c.path.lastIndexOf("/");
    dirs.add(i === -1 ? "" : c.path.slice(0, i));
  }
  return dirs;
}

/** Every node in the loaded tree, folders and files. */
export function countNodes(nodes: TreeNode[]): number {
  let n = 0;
  const walk = (list: TreeNode[]) => {
    for (const x of list) {
      n++;
      if (x.children) walk(x.children);
    }
  };
  walk(nodes);
  return n;
}

/** Immutably forget one folder's listing (back to the lazy placeholder), so
 *  a collapsed subtree stops costing memory and walk time. Re-expanding it
 *  lists it again. */
export function dropChildrenAt(nodes: TreeNode[], path: string): TreeNode[] {
  return nodes.map((n) => {
    if (n.path === path) return n.isDir ? { ...n, children: [], childrenLoaded: false } : n;
    if (n.isDir && n.children && path.startsWith(n.path + "/")) {
      return { ...n, children: dropChildrenAt(n.children, path) };
    }
    return n;
  });
}
