import express, { Express, NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { oauthRouter } from "./oauth.js";
import { deviceRouter } from "./device.js";
import { mcpRouter } from "./mcp.js";
import { apiRouter, adminTokenRouter } from "./api.js";
import { setupRouter, setupMiddleware } from "./setup.js";
import { prisma } from "./db.js";
import { createLogger } from "@constellation/shared";
import { config } from "./config.js";
import { classifyHttpRoute } from "./rate-limit-classify.js";

const log = createLogger("app");

export const app: Express = express();

const preset = process.env["TRUST_PROXY_PRESET"];
if (preset === "railway") {
  app.set("trust proxy", 1);
} else if (preset === "fly") {
  app.set("trust proxy", 1);
} else if (preset === "cloudflare-tunnel") {
  app.set("trust proxy", "127.0.0.1");
} else {
  const trustProxyRaw = process.env["TRUST_PROXY"];
  if (!trustProxyRaw) throw new Error("TRUST_PROXY or TRUST_PROXY_PRESET is required. Set TRUST_PROXY_PRESET to railway, fly, or cloudflare-tunnel, or set TRUST_PROXY to a comma-separated list of trusted proxy IPs/CIDRs.");
  if (/^\d+$/.test(trustProxyRaw) || trustProxyRaw === "true" || trustProxyRaw === "false") {
    throw new Error("TRUST_PROXY must be a comma-separated list of IP addresses or CIDR ranges, not a number or boolean.");
  }
  app.set("trust proxy", trustProxyRaw);
}

// MCP and OAuth endpoints must be reachable from browser-based MCP clients
// (Claude.ai, Cursor web, etc.) which send CORS preflight requests.
// Set ALLOWED_ORIGINS to a comma-separated list of trusted origins (e.g. "https://claude.ai").
// Defaults to no cross-origin access if unset.
const _allowedOrigins = (process.env["ALLOWED_ORIGINS"] ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: _allowedOrigins.length > 0
    ? (origin, cb) => cb(null, !origin || _allowedOrigins.includes(origin))
    : false,
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id"],
  exposedHeaders: ["Mcp-Session-Id"],
  credentials: true,
}));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

app.use((req, res, next) => {
  const raw = req.headers["x-request-id"] as string | undefined;
  // Strip non-printable ASCII and clamp length to prevent log injection.
  const id = raw ? raw.replace(/[^\x20-\x7E]/g, "").slice(0, 64) || randomUUID() : randomUUID();
  (req as Request & { id: string }).id = id;
  res.set("X-Request-Id", id);
  next();
});

app.use((_req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // Inline styles are used in server-rendered auth/setup pages; no JS or external resources.
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  next();
});

app.get("/healthz", async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "error", reason: "database_unavailable" });
  }
});

export const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.rateLimits.oauthPer15Min,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate_limit_exceeded" },
});

// Device code polling is high-frequency by design (5s interval, 15min TTL ≈ 180 polls).
// Give it a separate, higher-capacity bucket so it doesn't exhaust the strict OAuth limit.
// On trip, this bucket alone emits RFC 8628 §3.5's "slow_down" token-error response
// (400 + {error: "slow_down"}) instead of a generic 429 — it's the only bucket whose
// traffic is exclusively device-flow polling, so existing pollers that already
// understand authorization_pending/access_denied can back off instead of hard-failing.
export const devicePollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.rateLimits.devicePollPer15Min,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  statusCode: 400,
  message: { error: "slow_down" },
});

// The device-authorization consent flow (/activate*) — a separate bucket from
// oauthLimiter since one flow spans several requests (code entry, login or OIDC
// callback, consent), not the single round-trip oauthPer15Min is sized for.
export const deviceAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.rateLimits.deviceAuthPer15Min,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate_limit_exceeded" },
});

// Catch-all for any route not explicitly classified in the dispatcher below.
export const defaultLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.rateLimits.defaultPer15Min,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate_limit_exceeded" },
});

/** Single rate-limit dispatcher — every request that reaches this point hits exactly
 * one bucket, decided by classifyHttpRoute() (rate-limit-classify.ts). See that
 * function for the exemptions and the unclassified-falls-through-to-strict rule. */
app.use((req: Request, res: Response, next: NextFunction) => {
  const bucket = classifyHttpRoute(req.path, (req.body as Record<string, unknown> | undefined)?.["grant_type"]);
  switch (bucket) {
    case "exempt": return next();
    case "oauth": return oauthLimiter(req, res, next);
    case "device-poll": return devicePollLimiter(req, res, next);
    case "device-auth": return deviceAuthLimiter(req, res, next);
    case "default": return defaultLimiter(req, res, next);
  }
});

app.use(setupMiddleware);

app.use("/", setupRouter);
app.use("/", oauthRouter);
app.use("/", deviceRouter);
app.use("/", mcpRouter);
if (process.env["RELAY_ADMIN_TOKEN"]) {
  app.use("/", adminTokenRouter);
}
app.use("/", apiRouter);

// Must be last — 4-argument signature is how Express identifies error handlers.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.error({ err }, "Unhandled request error");
  if (!res.headersSent) {
    res.status(500).json({ error: "internal_server_error" });
  }
});
