/**
 * Subnode worker — runs under the target user's OS identity.
 *
 * Started by the hub parent process via child_process.fork().
 * Reads CONSTELLATION_TARGET_USER / _UID / _GID from env, drops privileges
 * (initgroups → setgid → setuid), then enters the IPC message loop.
 *
 * IPC protocol:
 *   Parent → Worker:  SubnodeInit (once), then SubnodeRequest (many)
 *   Worker → Parent:  SubnodeReady (once after init), then SubnodeResponse
 *
 * Message types and the request/response handling logic live in
 * subnode-worker-logic.ts so they can be unit tested directly — everything
 * below is the privilege-drop and IPC-wiring bootstrap, which is only safe to
 * run when this file is actually forked as a worker.
 */

import { FileExecutor, createLogger } from "@constellation/shared";
import {
  isValidMessage,
  handleRequest,
  type SubnodeInit,
  type SubnodeRequest,
  type SubnodeReady,
  type SubnodeResponse,
} from "./subnode-worker-logic.js";

const log = createLogger("hub:subnode-worker");

// ---------------------------------------------------------------------------
// Privilege drop — must happen before any file operations
// ---------------------------------------------------------------------------

if (!process.send) {
  process.stderr.write("subnode-worker: must be run as a forked child process\n");
  process.exit(1);
}

if (process.platform !== "linux") {
  process.stderr.write("subnode-worker: hub requires Linux\n");
  process.exit(1);
}

const targetUser = process.env["CONSTELLATION_TARGET_USER"] ?? "";
const targetUid = parseInt(process.env["CONSTELLATION_TARGET_UID"] ?? "", 10);
const targetGid = parseInt(process.env["CONSTELLATION_TARGET_GID"] ?? "", 10);

if (!targetUser || isNaN(targetUid) || isNaN(targetGid)) {
  process.stderr.write("subnode-worker: missing CONSTELLATION_TARGET_USER/UID/GID\n");
  process.exit(1);
}

if (targetUid === 0) {
  process.stderr.write("subnode-worker: refusing to run as root (uid 0)\n");
  process.exit(1);
}

// initgroups → setgid → setuid (must be in this order to preserve CAP_SETGID for initgroups)
// process.initgroups is available on Linux but not in all @types/node versions
type ProcessWithPrivileges = typeof process & {
  initgroups?: (user: string, extraGroup: number) => void;
};
const proc = process as ProcessWithPrivileges;

try {
  if (typeof proc.initgroups === "function") {
    proc.initgroups(targetUser, targetGid);
  }
  process.setgid!(targetGid);
  process.setuid!(targetUid);
} catch (err) {
  process.stderr.write(`subnode-worker: failed to drop privileges: ${(err as Error).message}\n`);
  process.exit(1);
}

log.info({ username: targetUser, uid: targetUid, gid: targetGid }, "Subnode worker started");

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let executor: FileExecutor | null = null;
let initialized = false;
let shuttingDown = false;
let inFlight = 0;

function send(msg: SubnodeReady | SubnodeResponse): void {
  process.send!(msg);
}

function fatal(msg: string): never {
  log.error(msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Message loop
// ---------------------------------------------------------------------------

process.on("message", (rawMsg: unknown) => {
  if (shuttingDown) {
    // Respond immediately so the parent doesn't wait for a full RPC timeout.
    if (typeof rawMsg === "object" && rawMsg !== null) {
      const m = rawMsg as Record<string, unknown>;
      if (typeof m["request_id"] === "string") {
        send({ type: "response", request_id: m["request_id"], error: { message: "SUBNODE_SHUTTING_DOWN" } });
      }
    }
    return;
  }

  if (!isValidMessage(rawMsg)) {
    fatal(`Received invalid message from parent: ${JSON.stringify(rawMsg)}`);
  }

  const msg = rawMsg as SubnodeInit | SubnodeRequest;

  if (msg.type === "init") {
    if (initialized) fatal("Received duplicate init message");
    executor = new FileExecutor(msg.labels, msg.max_file_size_kb);
    initialized = true;
    send({ type: "ready" });
    return;
  }

  if (msg.type === "request") {
    if (!initialized || !executor) fatal("Received request before init");

    inFlight++;
    handleRequest(executor, msg, send).finally(() => {
      inFlight--;
      if (shuttingDown && inFlight === 0) process.exit(0);
    });
  }
});

process.on("SIGTERM", () => {
  shuttingDown = true;
  if (inFlight === 0) process.exit(0);
  // Otherwise wait for in-flight execute() calls to finish
});
