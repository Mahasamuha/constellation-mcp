import { open, type FileHandle } from "node:fs/promises";
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

/**
 * Async, ordered, fire-and-forget audit log writer. `write()` enqueues and returns
 * immediately — callers never await it, so a slow/contended log volume never adds
 * latency to the RPC it's auditing. A single file handle is opened lazily on first
 * write and reused for every entry after that, instead of reopening logPath on every
 * call. Writes are serialized through an internal promise chain: concurrent unawaited
 * fs.promises writes to the same handle are not safe to interleave otherwise.
 *
 * Matches this codebase's documented fail-open philosophy for the audit log (see
 * docs/operations.md's Log rotation section): a write failure is logged to stderr and
 * otherwise swallowed — it must never affect, delay, or retry the tool call it's
 * auditing. If opening or writing fails, the cached handle is dropped so the next
 * write retries opening fresh, rather than caching a permanent failure.
 */
export class AuditWriter {
  private handle: Promise<FileHandle> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly logPath: string) {}

  write(entry: AuditEntry): void {
    this.queue = this.queue.then(() => this.append(entry));
  }

  /** Resolves once every write() call made so far has completed (or failed and been
   * logged) — call before exiting so the process doesn't cut off a write in flight. */
  flush(): Promise<void> {
    return this.queue;
  }

  /** Closes the underlying file handle, if one was ever successfully opened. Call
   * after flush() during shutdown — otherwise the process exits still holding an fd
   * open, which Node flags as a deprecated reliance on GC to close it. */
  async close(): Promise<void> {
    if (!this.handle) return;
    const fh = await this.handle;
    this.handle = null;
    await fh.close();
  }

  private async append(entry: AuditEntry): Promise<void> {
    try {
      this.handle ??= open(this.logPath, "a", 0o600);
      const fh = await this.handle;
      await fh.appendFile(JSON.stringify(entry) + "\n");
    } catch (err) {
      this.handle = null;
      process.stderr.write(`[audit] Failed to write audit entry to '${this.logPath}': ${(err as Error).message}\n`);
    }
  }
}
