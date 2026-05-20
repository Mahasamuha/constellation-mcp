#!/usr/bin/env node
import { Command } from "commander";
import { configDir } from "./config.js";
import { registerAgentCommands } from "./cli/agent.js";

const program = new Command();

program
  .name("constellation")
  .description("Constellation MCP file broker CLI")
  .version("0.1.0")
  .option("--config <dir>", "Override config directory");

// Resolve the config dir once, respecting --config flag.
// Commander parses global options before subcommand actions fire.
function getConfigDir(): string {
  return configDir(
    (program.opts() as { config?: string }).config ??
    process.env["CONSTELLATION_CONFIG_DIR"]
  );
}

registerAgentCommands(program, getConfigDir);

// broker subcommands are registered in section 10
program
  .command("broker", { hidden: false })
  .description("Manage the remote broker (see: constellation broker --help)")
  .allowUnknownOption(true)
  .action(() => {
    console.error("constellation broker commands are not yet implemented.");
    process.exit(1);
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
