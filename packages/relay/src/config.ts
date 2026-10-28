import { parseEnvInt } from "@constellation/shared";

// Cookies should only lack the Secure flag when RELAY_URL is explicitly http://
// (e.g. local development behind no TLS). Anything unset or unparsable defaults
// to secure rather than trusting NODE_ENV, which a non-Docker deploy may leave unset.
function isRelayUrlSecure(): boolean {
  const relayUrl = process.env["RELAY_URL"];
  if (!relayUrl) return true;
  try {
    return new URL(relayUrl).protocol !== "http:";
  } catch {
    return true;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

/**
 * Throws if RELAY_URL is set to anything other than a bare origin (no path, query,
 * fragment, or trailing slash). Every well-known URL and OAuth endpoint is built as
 * `${RELAY_URL}/...`, which only matches RFC 8414 §3.1 / RFC 9728 §3.1 placement (and
 * yields an exact `issuer` match) when RELAY_URL is an origin.
 */
export function assertRelayUrlIsOrigin(): void {
  const relayUrl = process.env["RELAY_URL"];
  if (!relayUrl) return;
  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    throw new Error("RELAY_URL is not a valid URL");
  }
  if (parsed.origin !== relayUrl) {
    throw new Error(`RELAY_URL must be a bare origin with no path or trailing slash (e.g. ${parsed.origin})`);
  }
  // It is the token audience and the base of every client_id and redirect: plaintext
  // would let a network attacker rewrite them. http: is for local development only.
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new Error("RELAY_URL must be an https: URL (http: is allowed only on a loopback host)");
  }
}

/**
 * Throws unless ASTERISM_ISSUER is a valid https: URL (http: is allowed on a loopback host,
 * for development) and RELAY_URL is set. Tokens must carry that issuer and the audience
 * `${RELAY_URL}/mcp`, so the relay cannot verify anything without both.
 */
export function assertAsterismConfig(): void {
  const issuer = process.env["ASTERISM_ISSUER"];
  if (!issuer) throw new Error("ASTERISM_ISSUER is required (asterism's issuer URL)");
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new Error("ASTERISM_ISSUER is not a valid URL");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new Error("ASTERISM_ISSUER must be an https: URL (http: is allowed only on a loopback host)");
  }
  if (!process.env["RELAY_URL"]) throw new Error("RELAY_URL is required (the token audience is its /mcp URL)");
}

export const config = {
  port: parseEnvInt("PORT", 3000),
  // asterism's ISSUER_URL, exactly as asterism publishes it. Access tokens must carry this `iss`.
  // Required at startup (assertAsterismConfig); the token audience is `${RELAY_URL}/mcp`.
  asterismIssuer: process.env["ASTERISM_ISSUER"] ?? "",
  // The group an account must belong to, besides holding the `admin` scope, to use admin routes.
  adminGroup: process.env["ADMIN_GROUP"]?.trim() || "constellation-admins",
  secureCookies: isRelayUrlSecure(),
  // Comma-separated list of token claim names to forward in RPC envelopes.
  // Empty = forward all claims from the access token.
  forwardedClaims: process.env["FORWARDED_CLAIMS"]
    ? process.env["FORWARDED_CLAIMS"].split(",").map((s) => s.trim()).filter(Boolean)
    : [] as string[],
  rateLimits: {
    toolCallsPerMin: parseEnvInt("RATE_LIMIT_TOOL_CALLS_PER_MIN", 60),
    expensiveToolsPerMin: parseEnvInt("RATE_LIMIT_EXPENSIVE_TOOLS_PER_MIN", 20),
    wsReconnectPerMin: parseEnvInt("RATE_LIMIT_WS_RECONNECT_PER_MIN", 10),
    // Discovery metadata and /clients/*.json documents: cheap static GETs.
    staticPer15Min: parseEnvInt("RATE_LIMIT_STATIC_PER_15MIN", 300),
    // Catch-all for any HTTP route not explicitly classified in app.ts's rate-limit
    // dispatcher. Deliberately strict — a route added later without updating that dispatcher is
    // rate-limited too aggressively rather than not at all.
    defaultPer15Min: parseEnvInt("RATE_LIMIT_DEFAULT_PER_15MIN", 10),
    // Authenticated /api requests, counted per user (sub) after authentication.
    apiPerUserPer15Min: parseEnvInt("RATE_LIMIT_API_PER_USER_PER_15MIN", 600),
    // Unauthenticated or failed /mcp requests per IP. Generous: Claude.ai's egress IPs are shared.
    mcpFailedPer15Min: parseEnvInt("RATE_LIMIT_MCP_FAILED_PER_15MIN", 300),
    // Every authenticated /mcp request per user, tool calls or not (they have tighter limits of their own).
    mcpRequestsPerMin: parseEnvInt("RATE_LIMIT_MCP_REQUESTS_PER_MIN", 300),
  },
  heartbeat: {
    intervalMs: parseEnvInt("HEARTBEAT_INTERVAL_SECONDS", 60) * 1000,
    maxMissed: parseEnvInt("HEARTBEAT_MAX_MISSED", 3),
  },
  ws: {
    maxMessageBytes: parseEnvInt("WS_MAX_MESSAGE_BYTES", 10_485_760),
  },
  rpcTimeoutMs: parseEnvInt("RPC_TIMEOUT_MS", 30_000),
  activityLog: {
    maxEntriesPerUser: parseEnvInt("ACTIVITY_LOG_MAX_ENTRIES", 1000),
    sinks: {
      postgres: process.env["ACTIVITY_SINK_POSTGRES"] !== "false",
      stdout: process.env["ACTIVITY_SINK_STDOUT"] === "true",
      webhookUrl: process.env["ACTIVITY_SINK_WEBHOOK_URL"] ?? null,
      webhookSecret: process.env["ACTIVITY_SINK_WEBHOOK_SECRET"] ?? null,
    },
  },
};
