// One highlight.js instance for the whole app: the common bundle plus the
// languages a Windows developer's folders actually hold.

import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import dos from "highlight.js/lib/languages/dos";
import powershell from "highlight.js/lib/languages/powershell";
import vbnet from "highlight.js/lib/languages/vbnet";

hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("dos", dos);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("vbnet", vbnet);

const ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  rs: "rust",
  md: "markdown",
  html: "xml",
  svg: "xml",
  vue: "xml",
  jsonc: "json",
  json5: "json",
  toml: "ini",
  ps: "powershell",
  ps1: "powershell",
  bat: "dos",
  cmd: "dos",
  text: "plaintext",
  txt: "plaintext",
};

export function isLanguage(lang: string): boolean {
  const l = ALIASES[lang] ?? lang;
  return l === "plaintext" ? false : Boolean(hljs.getLanguage(l));
}

/** Highlight `code` as `lang`. Returns escaped HTML; never throws. */
export function highlight(code: string, lang: string): string {
  const l = ALIASES[lang] ?? lang;
  try {
    if (hljs.getLanguage(l)) return hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
  } catch {
    /* fall through to plain */
  }
  return code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
