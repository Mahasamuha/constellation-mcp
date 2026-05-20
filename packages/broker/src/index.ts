import { createServer } from "node:http";
import { app } from "./app.js";
import { attachHub, pruneReconnectTimestamps } from "./hub.js";
import { pruneDeviceCodes } from "./device.js";
import { pruneRateLimits } from "./router.js";
import { createLogger } from "@constellation/shared";

const log = createLogger("broker");

const port = parseInt(process.env["PORT"] ?? "3000", 10);
const server = createServer(app);

attachHub(server);

// Prune all in-memory sliding-window and TTL stores every 5 minutes.
setInterval(() => {
  pruneDeviceCodes();
  pruneRateLimits();
  pruneReconnectTimestamps();
}, 5 * 60 * 1000).unref();

server.listen(port, () => {
  log.info({ port }, "Broker listening");
});
