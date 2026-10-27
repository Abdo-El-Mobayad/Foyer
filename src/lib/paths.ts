// Pure path and formatting helpers. No Tauri, no DOM.

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Lowercase extension of a path, "" when it has none. A leading-dot name
 *  (".gitignore") has no extension: the dot starts the name. */
export function extOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Every ancestor folder of a path, shallowest first, root ("") excluded. */
export function ancestors(path: string): string[] {
  const out: string[] = [];
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** Join an absolute root and a relative path with the root's separator style. */
export function joinAbs(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  if (!rel) return base;
  return base + sep + rel.split("/").join(sep);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Compare names the way a reader would: "note 10" after "note 9", case-insensitive. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** An absolute filesystem path as the PATH PORTION of an asset URL, one URL
 *  segment per path segment.
 *
 *  Tauri's `convertFileSrc` percent-encodes the whole path into a single
 *  segment ("/C%3A%5CGithub%5Csite%5Cindex.html"). A document loaded from that
 *  URL has "/" as its base directory, so every relative link, stylesheet,
 *  script and image in it resolves against the server root instead of against
 *  its own folder, and a page that works in Chrome silently loads nothing.
 *  Keeping the separators as separators is what makes relative resolution
 *  behave the way the file did on disk. */
export function assetPath(absolute: string): string {
  return absolute
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

/** Shorten an absolute path for display by dropping the home directory. */
export function displayPath(path: string): string {
  const home = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)/.exec(path);
  return home && path.length > home[0].length ? "~" + path.slice(home[0].length) : path;
}
