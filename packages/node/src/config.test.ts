import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { writeNodeConfig, writeNodeToken, clearPreviousToken, loadNodeConfig, nodeYamlPath, cachedByMtime } from "./config.js";
import { makeTempDir, cleanTempDir } from "./test/fixtures.js";

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir();
  writeNodeConfig(dir, { relay_url: "https://relay.example.com", node_token: "tok-original", host: "test-host" });
});

afterEach(async () => {
  await cleanTempDir(dir);
});

describe("writeNodeToken", () => {
  it("retains the displaced token as previous_node_token", () => {
    writeNodeToken(dir, "tok-rotated");

    expect(loadNodeConfig(dir).node_token).toBe("tok-rotated");
    expect(loadNodeConfig(dir).previous_node_token).toBe("tok-original");
  });

  it("rolls previous_node_token forward across a second rotation rather than keeping the oldest one", () => {
    writeNodeToken(dir, "tok-rotated-1");
    writeNodeToken(dir, "tok-rotated-2");

    expect(loadNodeConfig(dir).node_token).toBe("tok-rotated-2");
    expect(loadNodeConfig(dir).previous_node_token).toBe("tok-rotated-1");
  });
});

describe("clearPreviousToken", () => {
  it("removes previous_node_token once the new one is confirmed", () => {
    writeNodeToken(dir, "tok-rotated");
    expect(loadNodeConfig(dir).previous_node_token).toBe("tok-original");

    clearPreviousToken(dir);

    expect(loadNodeConfig(dir).previous_node_token).toBeUndefined();
    expect(loadNodeConfig(dir).node_token).toBe("tok-rotated");
  });

  it("is a no-op when there is nothing to clear", () => {
    expect(() => clearPreviousToken(dir)).not.toThrow();
    expect(loadNodeConfig(dir).node_token).toBe("tok-original");
  });
});

describe("atomic writes", () => {
  it("leaves no leftover temp file behind after writeNodeToken", () => {
    writeNodeToken(dir, "tok-rotated");

    expect(readdirSync(dir)).toEqual(["node.yaml"]);
  });
});

// Regression test for the per-RPC reload fix: the daemon's hot path needs every
// RPC to see a config change made via `node rotate`/`node paths add|remove`, but
// without redoing the actual read+parse when nothing has changed in between.
describe("cachedByMtime", () => {
  it("only reloads when the file's mtime has changed", () => {
    let calls = 0;
    const cached = cachedByMtime(nodeYamlPath(dir), () => {
      calls++;
      return loadNodeConfig(dir);
    });

    utimesSync(nodeYamlPath(dir), new Date(1000), new Date(1000));
    expect(cached().node_token).toBe("tok-original");
    expect(cached().node_token).toBe("tok-original");
    expect(calls).toBe(1);

    writeNodeToken(dir, "tok-rotated");
    utimesSync(nodeYamlPath(dir), new Date(2000), new Date(2000));
    expect(cached().node_token).toBe("tok-rotated");
    expect(calls).toBe(2);

    expect(cached().node_token).toBe("tok-rotated");
    expect(calls).toBe(2);
  });

  it("falls through to load() on every call when the file can't be stat'd", () => {
    let calls = 0;
    const cached = cachedByMtime(join(dir, "does-not-exist.yaml"), () => {
      calls++;
      return "value";
    });

    expect(cached()).toBe("value");
    expect(cached()).toBe("value");
    expect(calls).toBe(2);
  });
});
