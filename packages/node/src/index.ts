import { configDir, loadNodeConfig, loadPathsConfig } from "./config.js";
import { NodeConnection } from "./connection.js";
import { createLogger } from "@constellation/shared";

export function runDaemon(configDirOverride?: string): void {
  const log = createLogger("node");
  const dir = configDir(configDirOverride);
  const config = loadNodeConfig(dir);

  const conn = new NodeConnection({
    configDir: dir,
    getConfig: () => loadNodeConfig(dir),
    getPaths: () => loadPathsConfig(dir).paths,
  });

  conn.start();
  log.info({ host: config.host, relay: config.relay_url }, "Node started");

  process.on("SIGTERM", () => { conn.stop(); process.exit(0); });
  process.on("SIGINT",  () => { conn.stop(); process.exit(0); });
}
