import { createServer, createConnection, type Server, type Socket } from "node:net";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createLogger, generateToken, safeEqual } from "@constellation/shared";

const log = createLogger("node:control");

/** The slice of NodeConnection's surface the control server actually drives. */
export interface RotatableConnection {
  rotateToken(): Promise<void>;
}

/** How long the CLI waits for a response before treating the daemon as unreachable
 * and falling back to a direct relay connection of its own. */
const CONTROL_TIMEOUT_MS = 30_000;

interface ControlFile {
  port: number;
  auth: string;
}

function controlFilePath(dir: string): string {
  return join(dir, "control.json");
}

/**
 * Starts a loopback-only control channel the CLI can use to ask the *running* daemon to
 * act on its live relay connection — today, just token rotation — instead of the CLI
 * opening a second WebSocket of its own. A second connection authenticated with the same
 * (not-yet-rotated) token would otherwise evict the daemon's connection outright, since
 * the relay allows only one live connection per executor.
 *
 * The bound port and a per-process random auth token are written to a 0600 file in
 * configDir, the same trust model already used for node.yaml/paths.yaml: any local
 * process that can read that file already has full access to the live node token, so
 * gating this channel on the same file permission adds no new exposure. The auth token
 * exists only to stop a *different* local user from finding the port via a loopback scan
 * and triggering a rotation without being able to read the file at all.
 */
export function startControlServer(dir: string, conn: RotatableConnection): Server {
  const auth = generateToken();

  const server = createServer((socket: Socket) => {
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      void handleRequest(line, socket, conn, auth);
    });
    socket.on("error", (err) => log.warn({ err }, "Control connection error"));
  });

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    writeFileSync(controlFilePath(dir), JSON.stringify({ port, auth }), { mode: 0o600 });
    log.info({ port }, "Control channel listening");
  });

  server.on("close", () => {
    try { unlinkSync(controlFilePath(dir)); } catch { /* already gone, or never written */ }
  });

  return server;
}

async function handleRequest(line: string, socket: Socket, conn: RotatableConnection, auth: string): Promise<void> {
  let req: Record<string, unknown>;
  try {
    req = JSON.parse(line) as Record<string, unknown>;
  } catch {
    socket.end(JSON.stringify({ ok: false, error: "Invalid request" }) + "\n");
    return;
  }

  const reqAuth = req["auth"];
  if (typeof reqAuth !== "string" || !safeEqual(reqAuth, auth)) {
    socket.end(JSON.stringify({ ok: false, error: "Unauthorized" }) + "\n");
    return;
  }

  if (req["type"] === "rotate_token") {
    try {
      await conn.rotateToken();
      socket.end(JSON.stringify({ ok: true }) + "\n");
    } catch (err) {
      socket.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n");
    }
    return;
  }

  socket.end(JSON.stringify({ ok: false, error: "Unknown request type" }) + "\n");
}

export type ControlResult = { ok: true } | { ok: false; error: string };

/**
 * Asks a running daemon (if any) to rotate its own token on its live connection.
 * Returns null if no daemon appears to be reachable — the control file is missing,
 * unreadable, or nothing answers on the recorded port — in which case the caller should
 * fall back to rotating directly (safe when no daemon is running: there's no live
 * connection for a second WebSocket to evict).
 */
export function requestRotateViaControlChannel(dir: string): Promise<ControlResult | null> {
  let control: ControlFile;
  try {
    const raw = JSON.parse(readFileSync(controlFilePath(dir), "utf8")) as Partial<ControlFile>;
    if (typeof raw.port !== "number" || typeof raw.auth !== "string") return Promise.resolve(null);
    control = { port: raw.port, auth: raw.auth };
  } catch {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ControlResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const socket = createConnection({ host: "127.0.0.1", port: control.port }, () => {
      socket.write(JSON.stringify({ type: "rotate_token", auth: control.auth }) + "\n");
    });

    const timeout = setTimeout(() => { socket.destroy(); finish(null); }, CONTROL_TIMEOUT_MS);

    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      try {
        finish(JSON.parse(buf.slice(0, nl)) as ControlResult);
      } catch {
        finish(null);
      }
      socket.end();
    });
    socket.on("error", () => finish(null));
  });
}
