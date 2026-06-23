import { configDir, loadNodeConfig, loadPathsConfig } from "./config.js";
import { NodeConnection } from "./connection.js";
import { createLogger, startControlServer } from "@constellation/shared";

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
  const controlServer = startControlServer(dir, conn);
  log.info({ host: config.host, relay: config.relay_url }, "Node started");

  const shutdown = () => {
    conn.stop();
    controlServer.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
