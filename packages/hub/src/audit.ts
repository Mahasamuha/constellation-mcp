import { appendFileSync } from "node:fs";
import type { DispatchError } from "./subnode.js";

/**
 * "exec_error" remains the generic bucket for execution-path failures that aren't a
 * dispatch failure — a malformed request rejected before dispatch even runs, or the
 * underlying tool call itself returning an error after dispatch already succeeded.
 * A DispatchError's own kind is included directly (not collapsed into "exec_error")
 * so an operator can filter/alert on "policy rejection" vs. "capacity" vs.
 * "infra failure" without string-matching the free-text error message.
 */
export type AuditOutcome = "ok" | "identity_error" | "permission_denied" | "exec_error" | DispatchError["kind"];

export interface AuditEntry {
  ts: string;
  hub_name: string;
  request_id: string;
  user_oidc_sub: string | null;
  local_username: string | null;
  share: string;
  tool: string;
  outcome: AuditOutcome;
  error: string | null;
}

export function writeAuditEntry(logPath: string, entry: AuditEntry): void {
  try {
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch (err) {
    process.stderr.write(`[audit] Failed to write audit entry to '${logPath}': ${(err as Error).message}\n`);
  }
}
