import express, { Express } from "express";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { oauthRouter } from "./oauth.js";
import { deviceRouter } from "./device.js";
import { mcpRouter } from "./mcp.js";
import { apiRouter } from "./api.js";

export const app: Express = express();

const trustProxyRaw = process.env["TRUST_PROXY"];
if (!trustProxyRaw) throw new Error("TRUST_PROXY is required. Set to a comma-separated list of trusted proxy IP addresses or CIDR ranges (e.g. 127.0.0.1,10.0.0.0/8).");
if (/^\d+$/.test(trustProxyRaw) || trustProxyRaw === "true" || trustProxyRaw === "false") {
  throw new Error("TRUST_PROXY must be a comma-separated list of IP addresses or CIDR ranges, not a number or boolean.");
}
app.set("trust proxy", trustProxyRaw);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: () => parseInt(process.env["RATE_LIMIT_OAUTH_PER_15MIN"] ?? "10", 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate_limit_exceeded" },
});

app.use("/oauth/token", oauthLimiter);
app.use("/oauth/register", oauthLimiter);

app.use("/", oauthRouter);
app.use("/", deviceRouter);
app.use("/", mcpRouter);
app.use("/", apiRouter);
