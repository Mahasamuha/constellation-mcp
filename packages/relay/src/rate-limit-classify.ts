export type RateLimitBucket = "exempt" | "static" | "default";

/**
 * Pure HTTP route → rate-limit-bucket classification, kept dependency-free (no env
 * vars, no Express, no other relay modules) so it's directly unit-testable without
 * dragging in app.ts's full import graph.
 *
 * A route gets a named bucket only by being listed explicitly here; anything not
 * listed falls through to "default", the strictest configured HTTP bucket (see
 * app.ts's defaultLimiter). A route added later without updating this function ends
 * up rate-limited too aggressively rather than not at all — the same
 * "unclassified = strict" rule checkToolRateLimit (router.ts) applies to MCP tool
 * calls.
 *
 * "exempt" is for /mcp specifically, and is deliberate, not an oversight: every MCP
 * tool call already goes through checkToolRateLimit, a per-user limiter suited to
 * that traffic shape — a normal session legitimately makes far more requests to
 * this one endpoint than the default bucket allows for an arbitrary route.
 * (/healthz has its own dedicated limiter mounted after this dispatcher — it gets
 * a generous per-minute cap rather than the strict default bucket.)
 *
 * "static" is for the unauthenticated, cheap, cacheable GETs: RFC 9728 discovery
 * metadata and the /clients/*.json client metadata documents.
 *
 * /api/executors/register is authenticated (bearer token) but deliberately left to
 * the strict default: it is called once per executor setup, never in a loop.
 */
export function classifyHttpRoute(path: string): RateLimitBucket {
  if (path === "/mcp") return "exempt";

  if (path.startsWith("/.well-known/oauth-protected-resource")) return "static";
  if (/^\/clients\/[a-z0-9-]+\.json$/.test(path)) return "static";

  return "default";
}
