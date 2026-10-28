import { RE2JS } from "re2js";
import { globToRe2Source, MAX_FILTER_PATTERN_LENGTH, InvalidFilterError } from "../../path-filter.js";

/**
 * The only place the executor compiles a caller-supplied pattern. Everything runs on RE2
 * (re2js), which matches in linear time, so no pattern can stall the node. Globs are
 * translated with globToRe2Source (anchored; match them with `.matcher(name).matches()`),
 * regexes are used as written (search them with `.matcher(text).find()`).
 */
export type ToolPatternType = "glob" | "regex";

export function compileToolPattern(pattern: string, type: ToolPatternType, label = "pattern"): RE2JS {
  if (pattern.length === 0 || pattern.length > MAX_FILTER_PATTERN_LENGTH) {
    throw invalid(`${label} must be 1-${MAX_FILTER_PATTERN_LENGTH} characters`);
  }
  try {
    return RE2JS.compile(type === "glob" ? globToRe2Source(pattern) : pattern);
  } catch (err) {
    if (err instanceof InvalidFilterError) throw invalid(`${label} is not a valid glob: ${err.message}`);
    throw invalid(
      `${label} is not valid RE2 syntax (lookarounds and backreferences are not supported): ${(err as Error).message}`
    );
  }
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "INVALID_PATTERN" });
}
