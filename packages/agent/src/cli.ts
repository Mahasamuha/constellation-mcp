#!/usr/bin/env node
import { Command } from "commander";
import { registerAgentCommands } from "./cli/agent.js";
import { registerBrokerCommands } from "./cli/broker.js";
import { registerSharedAgentCommands } from "./cli/shared-agent.js";

declare const __PKG_VERSION__: string;

const program = new Command();

program
  .name("constellation")
  .description("Constellation MCP file broker CLI")
  .version(__PKG_VERSION__);

registerAgentCommands(program);
registerBrokerCommands(program);
registerSharedAgentCommands(program);

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
