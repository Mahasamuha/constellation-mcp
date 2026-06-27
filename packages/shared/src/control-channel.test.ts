import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConnection, type Server } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startControlServer, requestRotateViaControlChannel, type RotatableConnection } from "./control-channel.js";
import { makeTempDir, cleanTempDir } from "./test/fixtures.js";

let dir: string;
let server: Server | undefined;

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await cleanTempDir(dir);
});

function controlFilePath(): string {
  return join(dir, "control.json");
}

async function waitForListening(s: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    if (s.listening) resolve();
    else s.once("listening", resolve);
  });
}

describe("control channel", () => {
  it("round-trips a successful rotation request from the CLI client to the daemon's connection", async () => {
    const rotateToken = vi.fn().mockResolvedValue(undefined);
    const stub: RotatableConnection = { rotateToken };
    server = startControlServer(dir, stub);
    await waitForListening(server);

    const result = await requestRotateViaControlChannel(dir);

    expect(result).toEqual({ ok: true });
    expect(rotateToken).toHaveBeenCalledTimes(1);
  });

  it("surfaces a rotation failure from the connection back to the client", async () => {
    const stub: RotatableConnection = { rotateToken: vi.fn().mockRejectedValue(new Error("Timed out waiting for rotation to complete")) };
    server = startControlServer(dir, stub);
    await waitForListening(server);

    const result = await requestRotateViaControlChannel(dir);

    expect(result).toEqual({ ok: false, error: "Timed out waiting for rotation to complete" });
  });

  it("rejects a request with the wrong auth token", async () => {
    const rotateToken = vi.fn().mockResolvedValue(undefined);
    const stub: RotatableConnection = { rotateToken };
    server = startControlServer(dir, stub);
    await waitForListening(server);

    const { port } = JSON.parse(readFileSync(controlFilePath(), "utf8")) as { port: number };

    const result = await new Promise<unknown>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () => {
        socket.write(JSON.stringify({ type: "rotate_token", auth: "wrong-token" }) + "\n");
      });
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        resolve(JSON.parse(buf.slice(0, nl)));
        socket.end();
      });
    });

    expect(result).toEqual({ ok: false, error: "Unauthorized" });
    expect(rotateToken).not.toHaveBeenCalled();
  });

  it("returns null when no control file exists (no daemon running)", async () => {
    const result = await requestRotateViaControlChannel(dir);
    expect(result).toBeNull();
  });

  it("returns null when the control file points at a port nothing is listening on", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(controlFilePath(), JSON.stringify({ port: 1, auth: "whatever" }), { mode: 0o600 });

    const result = await requestRotateViaControlChannel(dir);
    expect(result).toBeNull();
  });
});
