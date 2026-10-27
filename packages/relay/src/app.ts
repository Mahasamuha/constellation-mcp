import express, { Express, NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { mcpRouter } from "./mcp.js";
import { apiRouter } from "./api.js";
import { setupRouter } from "./setup.js";
import { discoveryRouter } from "./discovery.js";
import { clientMetadataRouter } from "./client-metadata.js";
import { executorsRouter } from "./executors.js";
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

// MCP, discovery and API endpoints must be reachable from browser-based MCP clients
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
  exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
  credentials: true,
}));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

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
  // The relay serves only JSON; no scripts, styles or other resources are needed.
  res.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  if (config.secureCookies) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});


// Discovery and client metadata documents are cheap static GETs that clients re-fetch
// routinely (and hit in bursts during connect), so they get a generous bucket.
export const staticLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.rateLimits.staticPer15Min,
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
  const bucket = classifyHttpRoute(req.path);
  switch (bucket) {
    case "exempt": return next();
    case "static": return staticLimiter(req, res, next);
    case "default": return defaultLimiter(req, res, next);
  }
});

// /healthz is after the rate-limit dispatcher (not before it) so it can't be used
// to exhaust the PG connection pool unchecked. It gets its own generous bucket
// (120/min) to avoid breaking load-balancer health checks.
const healthzLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate_limit_exceeded" },
});
app.get("/healthz", healthzLimiter, async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "error", reason: "database_unavailable" });
  }
});

app.use("/", setupRouter);
app.use("/", discoveryRouter);
app.use("/", clientMetadataRouter);
app.use("/", mcpRouter);
// executorsRouter applies its own bearer auth, so it must be mounted before apiRouter
// (whose router-level requireBearerAuth would otherwise see this route first).
app.use("/", executorsRouter);
app.use("/", apiRouter);

// Must be last — 4-argument signature is how Express identifies error handlers.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.error({ err }, "Unhandled request error");
  if (!res.headersSent) {
    res.status(500).json({ error: "internal_server_error" });
  }
});
