import { createServer } from "node:http";
import { app } from "./app.js";
import { attachHub } from "./hub.js";
import { createLogger } from "@constellation/shared";

const log = createLogger("broker");

const port = parseInt(process.env["PORT"] ?? "3000", 10);
const server = createServer(app);

attachHub(server);

server.listen(port, () => {
  log.info({ port }, "Broker listening");
});
