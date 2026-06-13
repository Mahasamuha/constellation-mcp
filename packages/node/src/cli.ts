#!/usr/bin/env node
import { Command } from "commander";
import { registerNodeCommands } from "./cli/node.js";
import { registerRelayCommands } from "./cli/relay.js";
import { registerHubCommands } from "@constellation/hub/cli";

declare const __PKG_VERSION__: string;

const program = new Command();

program
  .name("constellation")
  .description("Constellation MCP file relay CLI")
  .version(__PKG_VERSION__);

registerNodeCommands(program);
registerRelayCommands(program);
registerHubCommands(program);

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
