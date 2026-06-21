import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeNodeConfig, writeNodeToken, clearPreviousToken, loadNodeConfig } from "./config.js";
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
