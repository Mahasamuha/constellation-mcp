import { configDir, loadAgentConfig, loadPathsConfig } from "./config.js";
import { AgentConnection } from "./connection.js";
import { createLogger } from "@constellation/shared";

export function runDaemon(configDirOverride?: string): void {
  const log = createLogger("agent");
  const dir = configDir(configDirOverride);
  const config = loadAgentConfig(dir);

  const conn = new AgentConnection({
    configDir: dir,
    getConfig: () => loadAgentConfig(dir),
    getPaths: () => loadPathsConfig(dir).paths,
  });

  conn.start();
  log.info({ host: config.host, broker: config.broker_url }, "Agent started");

  process.on("SIGTERM", () => { conn.stop(); process.exit(0); });
  process.on("SIGINT",  () => { conn.stop(); process.exit(0); });
}

// Run when executed directly as the daemon entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  runDaemon(process.env["CONSTELLATION_CONFIG_DIR"]);
}
