import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { RpcEnvelope } from "@constellation/shared";
import { handleRpc, ShareRegistryCache } from "./rpc.js";
import type { NodeConfig } from "./config.js";
import { makeTempDir, cleanTempDir } from "./test/fixtures.js";

let root: string;
beforeEach(async () => { root = await fs.realpath(await makeTempDir()); });
afterEach(async () => { await cleanTempDir(root); });

const config = { relay_url: "https://r", node_token: "t", host: "h", max_file_size_kb: 100 } as NodeConfig;

function envelope(extra: Record<string, unknown>): RpcEnvelope {
  return {
    request_id: "r1", tool: "read_file", absolute_root: root, share: "docs",
    params: { relative_path: "secret.txt" }, ...extra,
  } as unknown as RpcEnvelope;
}

async function run(extra: Record<string, unknown>) {
  await fs.writeFile(join(root, "secret.txt"), "hidden", "utf8");
  return handleRpc(envelope(extra), [{ share: "docs", path: root }] as never, config, new ShareRegistryCache());
}

describe("handleRpc path_filters", () => {
  it("enforces the envelope's filters", async () => {
    const res = await run({ path_filters: ["^(?:.*/)?secret\\.txt$"] });
    expect((res.error as { code?: string }).code).toBe("PATH_FILTERED");
    expect(res.result).toBeUndefined();
  });

  it("runs when the filters allow the path", async () => {
    const res = await run({ path_filters: [] });
    expect(res.error).toBeUndefined();
  });

  it.each([
    ["missing", {}],
    ["not an array", { path_filters: "x" }],
    ["non-string entry", { path_filters: [1] }],
    ["more than 100", { path_filters: Array(101).fill("a") }],
  ])("refuses an envelope whose path_filters is %s", async (_n, extra) => {
    const res = await run(extra);
    expect((res.error as { message: string }).message).toMatch(/Malformed request: path_filters/);
    expect(res.result).toBeUndefined();
  });
});
