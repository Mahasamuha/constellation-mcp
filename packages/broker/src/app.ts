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
  const id = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
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
export const devicePollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.rateLimits.devicePollPer15Min,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate_limit_exceeded" },
});

app.use("/oauth/token", (req, res, next) => {
  const grant = (req.body as Record<string, unknown>)?.["grant_type"];
  if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
    devicePollLimiter(req, res, next);
  } else {
    oauthLimiter(req, res, next);
  }
});
app.use("/oauth/register", oauthLimiter);
app.use("/oauth/device/code", oauthLimiter);
app.use("/setup", oauthLimiter);
app.use("/auth/login", oauthLimiter);

app.use(setupMiddleware);

app.use("/", setupRouter);
app.use("/", oauthRouter);
app.use("/", deviceRouter);
app.use("/", mcpRouter);
if (process.env["BROKER_ADMIN_TOKEN"]) {
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
