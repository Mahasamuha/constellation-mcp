import { createServer } from "node:http";
import { app } from "./app.js";
import { attachHub, closeHub, pruneReconnectTimestamps, pruneExpiredOrphanedTokens } from "./hub.js";
import { pruneRateLimits } from "./router.js";
import { initActivitySinks, pruneActivityLog } from "./activity.js";
import { prisma } from "./db.js";
import { createLogger } from "@constellation/shared";
import { assertAsterismConfig, assertRelayUrlIsOrigin, config } from "./config.js";

const log = createLogger("relay");

assertRelayUrlIsOrigin();
assertAsterismConfig();

const port = config.port;
const server = createServer(app);

initActivitySinks();
attachHub(server);

pruneExpiredOrphanedTokens().catch((err) => log.warn({ err }, "pruneExpiredOrphanedTokens failed"));

// Prune all TTL stores every 5 minutes.
setInterval(() => {
  pruneExpiredOrphanedTokens().catch((err) => log.warn({ err }, "pruneExpiredOrphanedTokens failed"));
  pruneRateLimits();
  pruneReconnectTimestamps();
  pruneActivityLog().catch((err) => log.warn({ err }, "pruneActivityLog failed"));
}, 5 * 60 * 1000).unref();

server.setTimeout(60_000);

server.listen(port, () => {
  log.info({ port }, "Relay listening");
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
