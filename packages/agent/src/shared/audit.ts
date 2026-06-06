import { appendFileSync } from "node:fs";

export type AuditOutcome = "ok" | "identity_error" | "permission_denied" | "exec_error";

export interface AuditEntry {
  ts: string;
  agent_name: string;
  request_id: string;
  user_oidc_sub: string | null;
  local_username: string | null;
  label: string;
  tool: string;
  outcome: AuditOutcome;
  error: string | null;
}

export function writeAuditEntry(logPath: string, entry: AuditEntry): void {
  try {
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort: don't crash the agent if the audit log is temporarily unavailable.
    // The caller should log a warning separately if this is critical.
  }
}
