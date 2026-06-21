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

export const config = {
  port: parseEnvInt("PORT", 3000),
  secureCookies: isRelayUrlSecure(),
  // "local" enables username/password auth with a built-in setup flow; anything
  // else (including unset) runs in OIDC mode against an upstream provider.
  authMode: (process.env["AUTH_MODE"] === "local" ? "local" : "oidc") as "local" | "oidc",
  // Comma-separated list of OIDC claim names to forward in RPC envelopes.
  // Empty = forward all claims from last known session.
  forwardedClaims: process.env["FORWARDED_CLAIMS"]
    ? process.env["FORWARDED_CLAIMS"].split(",").map((s) => s.trim()).filter(Boolean)
    : [] as string[],
  // Comma-separated list of OIDC group names that grant ADMIN role on login.
  // Empty = no OIDC group → role mapping (use CLI promote/demote for bootstrap).
  adminGroups: process.env["ADMIN_GROUPS"]
    ? process.env["ADMIN_GROUPS"].split(",").map((s) => s.trim()).filter(Boolean)
    : [] as string[],
  // How long an elevated session window lasts in milliseconds. Default 1 hour.
  adminSessionDurationMs: parseEnvInt("ADMIN_SESSION_DURATION", 3600) * 1000,
  rateLimits: {
    toolCallsPerMin: parseEnvInt("RATE_LIMIT_TOOL_CALLS_PER_MIN", 60),
    expensiveToolsPerMin: parseEnvInt("RATE_LIMIT_EXPENSIVE_TOOLS_PER_MIN", 20),
    wsReconnectPerMin: parseEnvInt("RATE_LIMIT_WS_RECONNECT_PER_MIN", 10),
    oauthPer15Min: parseEnvInt("RATE_LIMIT_OAUTH_PER_15MIN", 10),
    devicePollPer15Min: parseEnvInt("RATE_LIMIT_DEVICE_POLL_PER_15MIN", 200),
    // The device-authorization consent flow (/activate*) — a human walking through
    // user-code entry, login, and consent. Sized a bit above oauthPer15Min since one
    // flow spans multiple requests/routes.
    deviceAuthPer15Min: parseEnvInt("RATE_LIMIT_DEVICE_AUTH_PER_15MIN", 20),
    // Catch-all for any HTTP route not explicitly classified in app.ts's rate-limit
    // dispatcher. Deliberately the strictest configurable HTTP bucket (same default as
    // oauthPer15Min) — a route added later without updating that dispatcher is
    // rate-limited too aggressively rather than not at all.
    defaultPer15Min: parseEnvInt("RATE_LIMIT_DEFAULT_PER_15MIN", 10),
  },
  heartbeat: {
    intervalMs: parseEnvInt("HEARTBEAT_INTERVAL_SECONDS", 60) * 1000,
    maxMissed: parseEnvInt("HEARTBEAT_MAX_MISSED", 3),
  },
  ws: {
    maxMessageBytes: parseEnvInt("WS_MAX_MESSAGE_BYTES", 10_485_760),
  },
  rpcTimeoutMs: parseEnvInt("RPC_TIMEOUT_MS", 30_000),
  oauthAccessTokenTtlHours: parseEnvInt("OAUTH_ACCESS_TOKEN_TTL_HOURS", 24),
  oauthRefreshTokenTtlDays: parseEnvInt("OAUTH_REFRESH_TOKEN_TTL_DAYS", 30),
  // How long a dynamically registered OAuth client may sit unactivated (no completed auth flow)
  // before it's pruned. Mitigates unbounded growth from the unauthenticated /oauth/register endpoint.
  oauthDynamicClientTtlHours: parseEnvInt("OAUTH_DYNAMIC_CLIENT_TTL_HOURS", 24),
  activityLog: {
    maxEntriesPerUser: parseEnvInt("ACTIVITY_LOG_MAX_ENTRIES", 1000),
    sinks: {
      postgres: process.env["ACTIVITY_SINK_POSTGRES"] !== "false",
      stdout: process.env["ACTIVITY_SINK_STDOUT"] === "true",
      webhookUrl: process.env["ACTIVITY_SINK_WEBHOOK_URL"] ?? null,
    },
  },
};
