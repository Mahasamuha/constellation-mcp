#!/usr/bin/env node
import { Command } from "commander";
import { configDir } from "./config.js";
import { registerAgentCommands } from "./cli/agent.js";
import { registerBrokerCommands } from "./cli/broker.js";
import { registerSharedAgentCommands } from "./cli/shared-agent.js";

declare const __PKG_VERSION__: string;

const program = new Command();

program
  .name("constellation")
  .description("Constellation MCP file broker CLI")
  .version(__PKG_VERSION__)
  .option("--config <dir>", "Override config directory");

function getConfigDir(): string {
  return configDir(
    (program.opts() as { config?: string }).config ??
    process.env["CONSTELLATION_CONFIG_DIR"]
  );
}

registerAgentCommands(program, getConfigDir);
registerBrokerCommands(program, getConfigDir);
registerSharedAgentCommands(program, getConfigDir);

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
