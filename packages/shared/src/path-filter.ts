import { RE2JS } from "re2js";

/**
 * Relay path filters (`/api/filters`): deny patterns a user sets on their shares. The relay
 * stores each one, compiles it with `filterSource` once at creation, and sends the sources
 * in every RPC envelope (`path_filters`). The executor enforces them against resolved real
 * paths with `createPathFilter`. Matching is RE2 (re2js), which runs in linear time, so a
 * user-supplied pattern can't stall the relay or an executor.
 */

export type FilterPatternType = "glob" | "regex";

export const MAX_FILTER_PATTERN_LENGTH = 1000;

export class InvalidFilterError extends Error {}

/**
 * Translates a glob into an anchored RE2 source. `**` matches across `/`, `*` and `?` stay
 * within one path segment, `[...]` is a character class, `{a,b}` is an alternation. Dotfiles
 * match like any other name. Everything else is literal.
 */
export function globToRe2Source(glob: string): string {
  let out = "";
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` also matches zero segments, so `a/**/b` matches `a/b`.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) throw new InvalidFilterError("Unclosed [ in glob");
      let body = glob.slice(i + 1, end);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      out += `[${negate ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
      i = end;
    } else if (c === "{") {
      braceDepth++;
      out += "(?:";
    } else if (c === "}" && braceDepth > 0) {
      braceDepth--;
      out += ")";
    } else if (c === "," && braceDepth > 0) {
      out += "|";
    } else {
      out += c.replace(/[.+^$()|\\{}[\]]/g, "\\$&");
    }
  }
  if (braceDepth !== 0) throw new InvalidFilterError("Unclosed { in glob");
  return `^${out}$`;
}

/**
 * The RE2 source stored for a filter. Throws InvalidFilterError when the pattern is empty,
 * too long, or not valid RE2 (lookarounds and backreferences are not supported).
 */
export function filterSource(pattern: string, type: FilterPatternType): string {
  if (!pattern || pattern.length > MAX_FILTER_PATTERN_LENGTH) {
    throw new InvalidFilterError(`pattern must be 1-${MAX_FILTER_PATTERN_LENGTH} characters`);
  }
  // A glob that isn't absolute matches at any depth, as in .gitignore: `*.env` is `**/*.env`.
  const glob = pattern.startsWith("/") || pattern.startsWith("**") ? pattern : `**/${pattern}`;
  const source = type === "glob" ? globToRe2Source(glob) : pattern;
  try {
    RE2JS.compile(source);
  } catch (err) {
    throw new InvalidFilterError(`pattern is not valid RE2: ${(err as Error).message}`);
  }
  return source;
}

/**
 * A matcher over compiled filter sources. `blocks(path)` is true when the absolute path, or
 * any of its ancestors, matches a filter, so a filter on a directory covers everything in it.
 * A source that fails to compile blocks everything: an unenforceable filter must not widen
 * access.
 */
export function createPathFilter(sources: readonly string[]): { readonly active: boolean; blocks(path: string): boolean } {
  let compiled: RE2JS[] | null = [];
  for (const s of sources) {
    try {
      compiled.push(RE2JS.compile(s));
    } catch {
      compiled = null;
      break;
    }
  }
  const regexes = compiled;
  return {
    active: sources.length > 0,
    blocks(path: string): boolean {
      if (regexes === null) return true;
      if (regexes.length === 0) return false;
      for (let p = path; ; ) {
        // find(), not matches(): a regex filter matches anywhere in the path, as it always has
        // (`\.env$`). Globs carry their own ^...$ anchors.
        if (regexes.some((re) => re.matcher(p).find())) return true;
        const cut = p.lastIndexOf("/");
        if (cut <= 0) return false;
        p = p.slice(0, cut);
      }
    },
  };
}
