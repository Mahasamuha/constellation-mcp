import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { makeTempDir, cleanTempDir } from "../test/fixtures.js";
import { FileExecutor } from "./index.js";

let root: string;

beforeEach(async () => {
  root = await makeTempDir();
});

afterEach(async () => {
  await cleanTempDir(root);
});

describe("FileExecutor error sanitization", () => {
  it("strips the absolute path and raw fs message from an uncaught errno error", async () => {
    const executor = new FileExecutor({ docs: root }, 1024);

    // read_file on a relative_path that resolves under root but doesn't exist
    // on disk hits a raw, uncaught fs.stat ENOENT inside readFile() — not one
    // of the deliberately-constructed KNOWN_CODES errors.
    const result = await executor.execute("read_file", "docs", { relative_path: "missing.txt" });

    expect(result.isError).toBe(true);
    const content = result.content as { message: string; code?: string; path?: string };

    expect(content.code).toBe("ENOENT");
    expect(content.message).not.toContain(root);
    expect(content.message).toBe("Operation failed");
    expect(content.path).toBeUndefined();
  });

  it("still passes through the safe relative path for a deliberately-constructed KNOWN_CODES error", async () => {
    const executor = new FileExecutor({ docs: root }, 1024);

    await fs.writeFile(join(root, "existing.txt"), "hi", "utf8");
    await fs.writeFile(join(root, "src.txt"), "hi", "utf8");

    // copy into a destination that already exists — assertNotExists throws a
    // deliberately-constructed DEST_EXISTS error carrying the client-supplied
    // relative path (never the resolved absolute path).
    const result = await executor.execute("copy", "docs", {
      src_relative_path: "src.txt",
      dst_relative_path: "existing.txt",
    });

    expect(result.isError).toBe(true);
    const content = result.content as { message: string; code?: string; path?: string };

    expect(content.code).toBe("DEST_EXISTS");
    expect(content.path).toBe("existing.txt");
    expect(content.message).not.toContain(root);
  });

  it("strips detail fields from a non-KNOWN_CODES error even if coincidentally present", async () => {
    const executor = new FileExecutor({ docs: root }, 1024);

    // file_info on a relative path with no entry resolves to a raw fs.lstat
    // ENOENT (uncaught, not KNOWN_CODES) inside fileInfo().
    const result = await executor.execute("file_info", "docs", { relative_path: "nope.txt" });

    expect(result.isError).toBe(true);
    const content = result.content as Record<string, unknown>;

    expect(content["message"]).toBe("Operation failed");
    expect(content["path"]).toBeUndefined();
    expect(content["edit_index"]).toBeUndefined();
    expect(content["match_count"]).toBeUndefined();
  });

  it("passes through the MOVE_INCOMPLETE message for a failed cross-device move fallback", async () => {
    const executor = new FileExecutor({ docs: root }, 1024);
    await fs.writeFile(join(root, "src.txt"), "hi", "utf8");

    const fsPromises = (await import("node:fs")).promises;
    vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(
      Object.assign(new Error("cross-device link"), { code: "EXDEV" })
    );
    vi.spyOn(fsPromises, "copyFile").mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));

    const result = await executor.execute("move", "docs", {
      src_relative_path: "src.txt",
      dst_relative_path: "dst.txt",
    });
    vi.restoreAllMocks();

    expect(result.isError).toBe(true);
    const content = result.content as { message: string; code?: string; path?: string };

    // Unlike a raw, uncaught fs error, this message is deliberately constructed and safe to
    // show as-is — the model needs the specifics to tell the user the move didn't fully land.
    expect(content.code).toBe("MOVE_INCOMPLETE");
    expect(content.path).toBe("dst.txt");
    expect(content.message).toContain("partial copy");
    expect(content.message).not.toContain(root);
  });
});
