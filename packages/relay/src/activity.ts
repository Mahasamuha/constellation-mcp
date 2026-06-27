import { createHmac } from "node:crypto";
import { prisma } from "./db.js";
import { createLogger } from "@constellation/shared";
import { config } from "./config.js";

const log = createLogger("activity");

// ---------------------------------------------------------------------------
// Event shape
// ---------------------------------------------------------------------------

export type ActivityEventType =
  | "tool_call"
  | "tool_error"
  | "rate_limited"
  | "executor_connect"
  | "executor_disconnect";

/** Canonical activity event emitted by the relay routing and hub layers. */
export interface ActivityEvent {
  /** Null for events with no associated user — e.g. hub connect/disconnect. */
  userId: string | null;
  eventType: ActivityEventType;
  host?: string;
  tool?: string;
  share?: string;
  requestId?: string;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Sink registry
// ---------------------------------------------------------------------------

/**
 * A sink receives every activity event synchronously. Async work (network,
 * disk, DB) must be fire-and-forget within the sink; throwing is caught and
 * logged as a warning.
 */
export type ActivitySink = (event: ActivityEvent) => void;

const sinks: ActivitySink[] = [];

/** Register an additional sink. Must be called before the relay starts accepting traffic. */
export function registerActivitySink(sink: ActivitySink): void {
  sinks.push(sink);
}

/** Remove all registered sinks. Intended for use in tests. */
export function clearActivitySinks(): void {
  sinks.length = 0;
}

// ---------------------------------------------------------------------------
// Generator — called from router and hub
// ---------------------------------------------------------------------------

/** Emit an activity event to all registered sinks. */
export function logEvent(event: ActivityEvent): void {
  for (const sink of sinks) {
    try {
      sink(event);
    } catch (err) {
      log.warn({ err }, "Activity sink threw synchronously");
    }
  }
}

// ---------------------------------------------------------------------------
// Built-in sink implementations
// ---------------------------------------------------------------------------

function postgresSink(event: ActivityEvent): void {
  prisma.activityLog.create({ data: event }).catch((err) => {
    log.warn({ err }, "Failed to write activity log entry");
  });
}

function stdoutSink(event: ActivityEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function makeWebhookSink(url: string, secret: string | null): ActivitySink {
  return (event: ActivityEvent) => {
    const body = JSON.stringify(event);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) {
      const sig = createHmac("sha256", secret).update(body).digest("hex");
      headers["X-Constellation-Signature"] = `sha256=${sig}`;
    }
    fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    }).catch((err) => {
      log.warn({ err, url }, "Activity webhook sink failed");
    });
  };
}

// ---------------------------------------------------------------------------
// Sink initialisation — called once from index.ts at startup
// ---------------------------------------------------------------------------

/**
 * Register sinks according to configuration. Must be called before the relay
 * begins accepting traffic. Controlled by:
 *   ACTIVITY_SINK_POSTGRES   — default true; set "false" to disable
 *   ACTIVITY_SINK_STDOUT     — default false; set "true" to emit NDJSON to stdout
 *   ACTIVITY_SINK_WEBHOOK_URL — URL to POST each event to as JSON
 */
export function initActivitySinks(): void {
  const cfg = config.activityLog.sinks;

  if (cfg.postgres) {
    registerActivitySink(postgresSink);
    log.info("Activity sink: postgres enabled");
  }

  if (cfg.stdout) {
    registerActivitySink(stdoutSink);
    log.info("Activity sink: stdout enabled");
  }

  if (cfg.webhookUrl) {
    registerActivitySink(makeWebhookSink(cfg.webhookUrl, cfg.webhookSecret));
    log.info({ url: cfg.webhookUrl, signed: !!cfg.webhookSecret }, "Activity sink: webhook enabled");
  }
}

// ---------------------------------------------------------------------------
// Postgres sink maintenance
// ---------------------------------------------------------------------------

/** Delete rows beyond the per-user cap. Called periodically from index.ts. */
export async function pruneActivityLog(): Promise<void> {
  const max = config.activityLog.maxEntriesPerUser;
  const deleted = await prisma.$executeRaw`
    DELETE FROM "activity_logs"
    WHERE "id" IN (
      SELECT "id" FROM (
        SELECT "id",
               ROW_NUMBER() OVER (PARTITION BY "user_id" ORDER BY "created_at" DESC) AS rn
        FROM "activity_logs"
      ) ranked
      WHERE rn > ${max}
    )
  `;
  if (deleted > 0) {
    log.info({ deleted }, "Pruned activity log entries");
  }
}
