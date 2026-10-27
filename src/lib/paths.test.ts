import { describe, expect, it } from "vitest";
import {
  ancestors,
  assetPath,
  basename,
  compareNames,
  dirname,
  displayPath,
  extOf,
  formatBytes,
  joinAbs,
} from "./paths";

describe("paths", () => {
  it("splits names, folders and extensions", () => {
    expect(basename(".claude/skills/SKILL.md")).toBe("SKILL.md");
    expect(basename("CLAUDE.md")).toBe("CLAUDE.md");
    expect(dirname(".claude/skills/SKILL.md")).toBe(".claude/skills");
    expect(dirname("CLAUDE.md")).toBe("");
    expect(extOf("a/b/notes.MD")).toBe("md");
    expect(extOf(".gitignore")).toBe("");
    expect(extOf(".env.local")).toBe("local");
    expect(extOf("Makefile")).toBe("");
  });

  it("lists ancestors shallowest first", () => {
    expect(ancestors("a/b/c.md")).toEqual(["a", "a/b"]);
    expect(ancestors("c.md")).toEqual([]);
  });

  it("joins with the root's separator style", () => {
    expect(joinAbs("C:\\Users\\me\\notes", ".claude/skills/x.md")).toBe(
      "C:\\Users\\me\\notes\\.claude\\skills\\x.md",
    );
    expect(joinAbs("/home/me/repo/", "a/b")).toBe("/home/me/repo/a/b");
    expect(joinAbs("C:\\Github\\Repo", "")).toBe("C:\\Github\\Repo");
  });

  it("sorts names naturally and case-insensitively, but totally", () => {
    const names = ["note 10.md", "Note 9.md", "note 9.md", "alpha", "Beta"];
    expect([...names].sort(compareNames)).toEqual([
      "alpha",
      "Beta",
      "Note 9.md",
      "note 9.md",
      "note 10.md",
    ]);
  });

  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(353 * 1024 * 1024)).toBe("353 MB");
  });

  it("shortens home paths", () => {
    expect(displayPath("C:\\Users\\me\\notes")).toBe("~\\notes");
    expect(displayPath("C:\\Projects\\foyer")).toBe("C:\\Projects\\foyer");
    expect(displayPath("/home/me")).toBe("/home/me");
  });
});

describe("assetPath", () => {
  it("keeps every path separator a URL separator", () => {
    // The whole point: the document's base directory must be its own folder,
    // or every relative link in it resolves against the server root.
    expect(assetPath(String.raw`C:\Github\site\index.html`)).toBe("C%3A/Github/site/index.html");
    expect(assetPath("C:/Github/site/index.html")).toBe("C%3A/Github/site/index.html");
    expect(assetPath("/home/me/site/index.html")).toBe("home/me/site/index.html");
  });

  it("resolves a sibling link the way the file would on disk", () => {
    const base = `http://asset.localhost/${assetPath(String.raw`C:\Github\site\index.html`)}`;
    expect(new URL("docs/index.html", base).href).toBe(
      "http://asset.localhost/C%3A/Github/site/docs/index.html",
    );
    expect(new URL("../other/page.html", base).href).toBe(
      "http://asset.localhost/C%3A/Github/other/page.html",
    );
  });

  it("encodes each segment without eating the separators", () => {
    expect(assetPath("C:/My Docs/a&b/page #1.html")).toBe(
      "C%3A/My%20Docs/a%26b/page%20%231.html",
    );
    // Repeated and trailing separators collapse rather than producing empty
    // segments that would change what a relative link resolves against.
    // A doubled separator and a trailing one, appended because a raw template
    // cannot itself end in a backslash.
    expect(assetPath(String.raw`C:\Github\\site` + "\\")).toBe("C%3A/Github/site");
  });
});
