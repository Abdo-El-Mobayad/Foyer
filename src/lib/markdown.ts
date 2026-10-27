// Markdown to sanitized HTML. GFM through `marked`, code blocks through
// highlight.js, every output scrubbed by DOMPurify before it reaches the DOM.
// Relative image paths are resolved against the note's folder and turned
// into asset-protocol URLs by the caller-supplied resolver.
//
// Highlighting is budgeted per fence and per document: one 2 MB fence, or a
// hundred 30 KB ones, would otherwise tokenize synchronously with no cap at
// all (the code viewer's cap did not apply here).

import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";
import { highlight, isLanguage } from "./highlight";

export interface RenderOptions {
  /** Turn a mount-relative path into a URL the webview can load. */
  resolveAsset: (rel: string) => string;
  /** The folder of the note being rendered (mount-relative, "" for root). */
  baseDir: string;
}

/** Largest single fence that gets syntax colors. */
export const FENCE_HIGHLIGHT_CAP = 64 * 1024;
/** Highlighted characters per document, across all fences. */
export const DOC_HIGHLIGHT_BUDGET = 256 * 1024;
/** Documents past this many chars open in Source; Preview is one click away. */
export const MARKDOWN_RENDER_CAP = 1024 * 1024;

const SAFE_URI = /^(?:(?:https?|mailto|tel|asset|vscode|obsidian):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Resolve a relative href against a note's folder, collapsing `..`. */
export function resolveRelative(baseDir: string, href: string): string {
  const parts = baseDir ? baseDir.split("/") : [];
  for (const seg of href.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

/** The highlighting budget for one render. Pure, for tests. */
export class HighlightBudget {
  private spent = 0;
  constructor(
    private readonly perFence = FENCE_HIGHLIGHT_CAP,
    private readonly perDoc = DOC_HIGHLIGHT_BUDGET,
  ) {}

  /** True if a fence of `chars` may be highlighted; charges the budget if so. */
  take(chars: number): boolean {
    if (chars > this.perFence || this.spent + chars > this.perDoc) return false;
    this.spent += chars;
    return true;
  }
}

function buildMarked(opts: RenderOptions, budget: HighlightBudget): Marked {
  const m = new Marked({ gfm: true, breaks: false });
  m.use({
    extensions: [
      {
        name: "wikilink",
        level: "inline",
        start(src: string) {
          return src.indexOf("[[");
        },
        tokenizer(src: string) {
          const match = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(src);
          if (!match) return undefined;
          return {
            type: "wikilink",
            raw: match[0],
            target: match[1].trim(),
            label: (match[2] ?? match[1]).trim(),
          };
        },
        renderer(token) {
          const t = token as unknown as { target: string; label: string };
          return `<a class="wikilink" data-wikilink="${escapeHtml(t.target)}" href="#">${escapeHtml(t.label)}</a>`;
        },
      },
    ],
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const text = this.parser.parseInline(tokens);
        const id = slugify(text);
        return `<h${depth} id="${id}">${text}</h${depth}>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        const language = (lang ?? "").trim().split(/\s+/)[0].toLowerCase();
        const colored = Boolean(language) && isLanguage(language) && budget.take(text.length);
        const body = colored ? highlight(text, language) : escapeHtml(text);
        const cls = language ? ` class="hljs language-${escapeHtml(language)}"` : ' class="hljs"';
        const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : "";
        return `<div class="code-block">${label}<pre><code${cls}>${body}</code></pre></div>\n`;
      },
      image({ href, title, text }: Tokens.Image) {
        const src = isExternal(href) ? href : opts.resolveAsset(resolveRelative(opts.baseDir, href));
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${t} loading="lazy">`;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        if (href.startsWith("#")) {
          return `<a href="${escapeHtml(href)}" data-anchor="${escapeHtml(href.slice(1))}"${t}>${inner}</a>`;
        }
        if (isExternal(href)) {
          return `<a href="${escapeHtml(href)}" data-external="1" rel="noopener"${t}>${inner}</a>`;
        }
        // A relative link points at another file in the mount: open it here.
        const [pathPart, hash] = href.split("#");
        const rel = resolveRelative(opts.baseDir, decodeURIComponent(pathPart));
        const h = hash ? ` data-hash="${escapeHtml(hash)}"` : "";
        return `<a href="#" data-relpath="${escapeHtml(rel)}"${h}${t}>${inner}</a>`;
      },
    },
  });
  return m;
}

/** Markdown to HTML, unsanitized. Exposed for tests (no DOM needed). */
export function markdownToHtml(source: string, opts: RenderOptions, budget = new HighlightBudget()): string {
  return buildMarked(opts, budget).parse(source, { async: false }) as string;
}

export function renderMarkdown(source: string, opts: RenderOptions): string {
  return DOMPurify.sanitize(markdownToHtml(source, opts), {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["data-relpath", "data-external", "data-anchor", "data-wikilink", "data-hash", "loading", "align"],
    ALLOWED_URI_REGEXP: SAFE_URI,
    FORBID_TAGS: ["style", "form", "button"],
  });
}
