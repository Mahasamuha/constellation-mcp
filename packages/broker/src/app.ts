import express, { Express } from "express";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { oauthRouter } from "./oauth.js";
import { deviceRouter } from "./device.js";

export const app: Express = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: () => parseInt(process.env["RATE_LIMIT_OAUTH_PER_15MIN"] ?? "10", 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ?? "unknown",
  message: { error: "rate_limit_exceeded" },
});

app.use("/oauth/token", oauthLimiter);
app.use("/oauth/register", oauthLimiter);

app.use("/", oauthRouter);
app.use("/", deviceRouter);
