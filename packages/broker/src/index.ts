import { createServer } from "node:http";
import { app } from "./app.js";
import { attachHub, closeHub, pruneReconnectTimestamps, revokeOrphanedTokens } from "./hub.js";
import { pruneDeviceCodes } from "./device.js";
import { pruneAuthCodes } from "./oauth.js";
import { pruneRateLimits } from "./router.js";
import { pruneLoginFailures } from "./local-auth.js";
import { prisma } from "./db.js";
import { createLogger } from "@constellation/shared";

const log = createLogger("broker");

const port = parseInt(process.env["PORT"] ?? "3000", 10);
const server = createServer(app);

attachHub(server);

revokeOrphanedTokens().catch((err) => log.warn({ err }, "revokeOrphanedTokens failed"));

// Prune all TTL stores every 5 minutes.
setInterval(() => {
  pruneDeviceCodes().catch((err) => log.warn({ err }, "pruneDeviceCodes failed"));
  pruneAuthCodes().catch((err) => log.warn({ err }, "pruneAuthCodes failed"));
  pruneRateLimits();
  pruneReconnectTimestamps();
  pruneLoginFailures().catch((err) => log.warn({ err }, "pruneLoginFailures failed"));
}, 5 * 60 * 1000).unref();

server.setTimeout(60_000);

server.listen(port, () => {
  log.info({ port }, "Broker listening");
});

async function shutdown(): Promise<void> {
  log.info("Shutting down");
  server.closeIdleConnections();
  const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  await closeHub();
  await serverClosed;
  await prisma.$disconnect();
  log.info("Shutdown complete");
}

process.once("SIGTERM", () => shutdown().catch((err) => { log.error({ err }, "Error during shutdown"); process.exit(1); }));
process.once("SIGINT", () => shutdown().catch((err) => { log.error({ err }, "Error during shutdown"); process.exit(1); }));

process.on("unhandledRejection", (err) => { log.error({ err }, "Unhandled rejection"); process.exit(1); });
process.on("uncaughtException", (err) => { log.error({ err }, "Uncaught exception"); process.exit(1); });
