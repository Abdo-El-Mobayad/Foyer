// YAML front matter, split off a Markdown body and flattened to key/value
// pairs for the strip above a rendered note. Values are kept as written;
// this is a display of what the file says, not a YAML parser.

export interface FrontMatter {
  fields: Array<[string, string]>;
  body: string;
}

export function splitFrontMatter(text: string): FrontMatter {
  const m = /^(?:﻿)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fields: [], body: text };
  const raw = m[1];
  const body = text.slice(m[0].length);
  const fields: Array<[string, string]> = [];
  let current: [string, string[]] | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line);
    if (kv && !line.startsWith(" ") && !line.startsWith("\t")) {
      if (current) fields.push([current[0], current[1].join(" ").trim()]);
      current = [kv[1], kv[2] !== undefined ? [kv[2]] : []];
      continue;
    }
    if (current) {
      const item = line.trim();
      if (!item) continue;
      current[1].push(item.startsWith("- ") ? item.slice(2) : item);
    }
  }
  if (current) fields.push([current[0], current[1].join(" ").trim()]);
  return { fields: fields.map(([k, v]) => [k, tidy(v)]), body };
}

/** Strip the quotes and brackets YAML lets a scalar wear. */
function tidy(v: string): string {
  let s = v.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1);
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    s = s
      .slice(1, -1)
      .split(",")
      .map((x) => tidy(x))
      .filter(Boolean)
      .join(", ");
  }
  return s;
}
