export type RateLimitBucket = "exempt" | "oauth" | "device-poll" | "device-auth" | "default";

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
 * (/healthz needs no entry here at all — its route is registered in app.ts before
 * the rate-limit dispatcher is mounted, so it never reaches this function at all.)
 */
export function classifyHttpRoute(path: string, grantType?: unknown): RateLimitBucket {
  if (path === "/mcp") return "exempt";

  if (path === "/oauth/token") {
    return grantType === "urn:ietf:params:oauth:grant-type:device_code" ? "device-poll" : "oauth";
  }
  if (path === "/oauth/register" || path === "/oauth/device/code" || path === "/setup" || path === "/auth/login") {
    return "oauth";
  }
  if (path.startsWith("/activate")) {
    return "device-auth";
  }

  return "default";
}
