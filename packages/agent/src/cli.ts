#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { configDir } from "./config.js";
import { registerAgentCommands } from "./cli/agent.js";
import { registerBrokerCommands } from "./cli/broker.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();

program
  .name("constellation")
  .description("Constellation MCP file broker CLI")
  .version(version)
  .option("--config <dir>", "Override config directory");

function getConfigDir(): string {
  return configDir(
    (program.opts() as { config?: string }).config ??
    process.env["CONSTELLATION_CONFIG_DIR"]
  );
}

registerAgentCommands(program, getConfigDir);
registerBrokerCommands(program, getConfigDir);

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
