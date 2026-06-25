import { configDir, loadNodeConfig, loadPathsConfig, nodeYamlPath, pathsYamlPath, cachedByMtime } from "./config.js";
import { NodeConnection } from "./connection.js";
import { createLogger, startControlServer } from "@constellation/shared";

export function runDaemon(configDirOverride?: string): void {
  const log = createLogger("node");
  const dir = configDir(configDirOverride);
  const config = loadNodeConfig(dir);

  const conn = new NodeConnection({
    configDir: dir,
    // mtime-gated: every RPC needs current config/paths, but node.yaml/paths.yaml
    // only actually change on an explicit `node rotate`/`node paths add|remove` —
    // see cachedByMtime's doc comment for why a blind per-RPC reread was a problem.
    getConfig: cachedByMtime(nodeYamlPath(dir), () => loadNodeConfig(dir)),
    getPaths: cachedByMtime(pathsYamlPath(dir), () => loadPathsConfig(dir).paths),
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

  // Last-resort safety net for this long-running unattended process — mirrors relay's
  // index.ts. Most config-load throws are already caught at their call sites (e.g.
  // connection.ts's onMessage), but RelaySocket's onOpen/connect paths have no
  // surrounding try/catch, so a throw there would otherwise be a silent, traceless crash.
  process.on("unhandledRejection", (err) => { log.error({ err }, "Unhandled rejection"); process.exit(1); });
  process.on("uncaughtException", (err) => { log.error({ err }, "Uncaught exception"); process.exit(1); });
}
