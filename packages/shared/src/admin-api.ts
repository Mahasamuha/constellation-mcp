export interface ExecutorShare {
  share: string;
  reported_path: string;
}

/**
 * The shape /api/executors actually returns. Declared here and used as the real,
 * checked return type of relay's own handler (not just assumed by a consumer-side
 * guess) so a future field rename is caught by tsc at its res.json() call site,
 * instead of silently going unnoticed through the rest of the chain — the CLI's
 * --json output, node-gui's Rust layer, and node-gui's frontend all read these same
 * field names without this type's protection.
 */
export interface ExecutorEntry {
  id: string;
  host: string;
  registered_at: string;
  last_heartbeat_at: string | null;
  last_disconnect_reason: "clean" | "timeout" | "error" | null;
  online: boolean;
  connected: boolean;
  token_id: string;
  token_last_used_at: string | null;
  shares: ExecutorShare[];
}
