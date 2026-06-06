import { parseEnvInt } from "@constellation/shared";

export const config = {
  port: parseEnvInt("PORT", 3000),
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
  },
  heartbeat: {
    intervalMs: parseEnvInt("HEARTBEAT_INTERVAL_SECONDS", 60) * 1000,
    maxMissed: parseEnvInt("HEARTBEAT_MAX_MISSED", 3),
  },
  ws: {
    maxMessageBytes: parseEnvInt("WS_MAX_MESSAGE_BYTES", 10_485_760),
  },
  rpcTimeoutMs: parseEnvInt("RPC_TIMEOUT_MS", 30_000),
};
