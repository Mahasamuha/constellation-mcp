import express, { Express, Request, Response } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { oauthRouter } from "./oauth.js";
import { deviceRouter } from "./device.js";
import { mcpRouter } from "./mcp.js";
import { apiRouter } from "./api.js";
import { setupRouter, setupMiddleware } from "./setup.js";

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

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

export const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: () => parseInt(process.env["RATE_LIMIT_OAUTH_PER_15MIN"] ?? "10", 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate_limit_exceeded" },
});

// Device code polling is high-frequency by design (5s interval, 15min TTL ≈ 180 polls).
// Give it a separate, higher-capacity bucket so it doesn't exhaust the strict OAuth limit.
export const devicePollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: () => parseInt(process.env["RATE_LIMIT_DEVICE_POLL_PER_15MIN"] ?? "200", 10),
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
app.use("/setup", oauthLimiter);
app.use("/auth/login", oauthLimiter);

app.use(setupMiddleware);

app.use("/", setupRouter);
app.use("/", oauthRouter);
app.use("/", deviceRouter);
app.use("/", mcpRouter);
app.use("/", apiRouter);
