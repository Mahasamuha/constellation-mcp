import Prism from "prismjs";

// Components with cross-language dependencies must load after the language
// they extend (markup-templating before php, c before cpp). The rest have no
// inter-dependencies. javascript, clike, and markup ship in prismjs core.
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-php";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-go";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-python";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-toml";

export { Prism };

// Maps file extensions (lowercase, no dot) to Prism language ids. Not
// exhaustive — covers the most common languages across Constellation hosts.
// See docs/adr/0015-bundle-prism-syntax-highlighting.md for the rationale and
// how to add more.
const EXTENSION_LANGUAGE: Record<string, string> = {
  py: "python",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  cs: "csharp",
  php: "php",
  rs: "rust",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  go: "go",
  toml: "toml",
};

function fileName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** Returns a Prism language id for a file path, or null if none is registered. */
export function languageForPath(path: string): string | null {
  const name = fileName(path);
  if (/^dockerfile(\..+)?$/i.test(name)) return "docker";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXTENSION_LANGUAGE[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Highlights `text` for `path`'s language, or — if no grammar is registered for
 * that language — just HTML-escapes it. Both branches go through Prism.highlight():
 * the no-grammar case passes an empty grammar object, which makes tokenize() a
 * no-op and falls through to Prism's own internal escaping. That keeps this to
 * exactly one escaping codepath rather than two that could silently diverge.
 */
export function highlightForPath(text: string, path: string | null): { html: string; language: string } {
  const language = path ? languageForPath(path) : null;
  const grammar = language ? Prism.languages[language] : undefined;
  if (!language || !grammar) return { html: Prism.highlight(text, {}, "none"), language: "none" };
  return { html: Prism.highlight(text, grammar, language), language };
}
