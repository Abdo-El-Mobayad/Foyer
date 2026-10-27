import { describe, expect, it } from "vitest";
import { DOC_HIGHLIGHT_BUDGET, HighlightBudget, markdownToHtml, resolveRelative, slugify } from "./markdown";

describe("markdown helpers", () => {
  it("resolves relative hrefs against the note folder", () => {
    expect(resolveRelative("Vault/wiki", "img/a.png")).toBe("Vault/wiki/img/a.png");
    expect(resolveRelative("Vault/wiki", "../raw/b.md")).toBe("Vault/raw/b.md");
    expect(resolveRelative("", "./x.md")).toBe("x.md");
    expect(resolveRelative("a/b", "../../../c")).toBe("c");
  });

  it("slugifies headings the GitHub way", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  Two   spaces ")).toBe("two-spaces");
    expect(slugify("<em>Emph</em> 1.2")).toBe("emph-12");
  });
});

describe("markdown highlighting budgets", () => {
  const opts = { baseDir: "", resolveAsset: (r: string) => r };

  it("colors a small fence and leaves an oversized one plain", () => {
    const small = "```js\nconst a = 1;\n```\n";
    expect(markdownToHtml(small, opts)).toContain("hljs-keyword");
    const big = "```js\n" + "const a = 1;\n".repeat(6000) + "```\n"; // ~78 K chars > FENCE_HIGHLIGHT_CAP
    const html = markdownToHtml(big, opts);
    expect(html).not.toContain("hljs-keyword");
    expect(html).toContain('class="hljs language-js"');
  });

  it("stops coloring once the document budget is spent", () => {
    const fence = "```js\n" + "const a = 1;\n".repeat(2000) + "```\n"; // ~26 K chars each
    const doc = fence.repeat(12); // ~312 K chars of fences > DOC_HIGHLIGHT_BUDGET
    const html = markdownToHtml(doc, opts);
    const colored = html.split('<div class="code-block">').slice(1).filter((b) => b.includes("hljs-keyword")).length;
    expect(colored).toBeGreaterThan(0);
    expect(colored).toBeLessThan(12);
    expect(colored).toBe(Math.floor(DOC_HIGHLIGHT_BUDGET / (fence.length - "```js\n```\n".length)));
  });

  it("the budget object charges only what it accepts", () => {
    const b = new HighlightBudget(10, 25);
    expect(b.take(11)).toBe(false);
    expect(b.take(10)).toBe(true);
    expect(b.take(10)).toBe(true);
    expect(b.take(6)).toBe(false);
    expect(b.take(5)).toBe(true);
    expect(b.take(1)).toBe(false);
  });
});
