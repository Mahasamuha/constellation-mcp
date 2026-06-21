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

function rejected(result: { isError?: boolean; content: unknown }): boolean {
  return result.isError === true && (result.content as { message?: string }).message === "Path rejected";
}

// FileExecutor.execute() is the literal chokepoint for path-traversal/symlink-escape
// enforcement and cross-share resolution — reused by both node and hub. The tests
// above only ever exercise the underlying tool functions with already-resolved
// paths, bypassing this validation entirely. These call execute() directly.
describe("FileExecutor path-traversal/symlink-escape boundary check", () => {
  it("rejects an unregistered share name outright", async () => {
    const executor = new FileExecutor({ docs: root }, 1024);

    const result = await executor.execute("read_file", "nonexistent", { relative_path: "x.txt" });

    expect(rejected(result)).toBe(true);
  });

  it("rejects a relative_path that traverses outside the share root via ../", async () => {
    const executor = new FileExecutor({ docs: root }, 1024);

    const result = await executor.execute("read_file", "docs", { relative_path: "../../etc/passwd" });

    expect(rejected(result)).toBe(true);
  });

  it("rejects a symlink inside the share whose target resolves outside the share root", async () => {
    const outside = await makeTempDir();
    try {
      const executor = new FileExecutor({ docs: root }, 1024);
      await fs.writeFile(join(outside, "secret.txt"), "sensitive", "utf8");
      await fs.symlink(join(outside, "secret.txt"), join(root, "link.txt"));

      const result = await executor.execute("read_file", "docs", { relative_path: "link.txt" });

      expect(rejected(result)).toBe(true);
    } finally {
      await cleanTempDir(outside);
    }
  });

  it("rejects a write targeting the share root itself", async () => {
    const executor = new FileExecutor({ docs: root }, 1024);

    const result = await executor.execute("write_file", "docs", { relative_path: "", content: "x" });

    expect(rejected(result)).toBe(true);
  });

  it("rejects a cross-share move whose dst_relative_path resolves to the destination share's root", async () => {
    const otherRoot = await makeTempDir();
    try {
      const executor = new FileExecutor({ docs: root, other: otherRoot }, 1024);
      await fs.writeFile(join(root, "src.txt"), "hi", "utf8");

      const result = await executor.execute("move", "docs", {
        src_relative_path: "src.txt",
        dst_share: "other",
        dst_relative_path: "",
      });

      expect(rejected(result)).toBe(true);
    } finally {
      await cleanTempDir(otherRoot);
    }
  });

  it("resolves dst_share to a different registered share's root for cross-share copy", async () => {
    const otherRoot = await makeTempDir();
    try {
      const executor = new FileExecutor({ docs: root, other: otherRoot }, 1024);
      await fs.writeFile(join(root, "src.txt"), "hello", "utf8");

      const result = await executor.execute("copy", "docs", {
        src_relative_path: "src.txt",
        dst_share: "other",
        dst_relative_path: "copied.txt",
      });

      expect(result.isError).toBeUndefined();
      await expect(fs.readFile(join(otherRoot, "copied.txt"), "utf8")).resolves.toBe("hello");
    } finally {
      await cleanTempDir(otherRoot);
    }
  });

  it("rejects a dst_share name that isn't in the registry", async () => {
    const executor = new FileExecutor({ docs: root }, 1024);
    await fs.writeFile(join(root, "src.txt"), "hello", "utf8");

    const result = await executor.execute("copy", "docs", {
      src_relative_path: "src.txt",
      dst_share: "nonexistent",
      dst_relative_path: "copied.txt",
    });

    expect(rejected(result)).toBe(true);
  });

  it("resolves a raw dst_root directly when it matches a registered share's root (no dst_share)", async () => {
    const otherRoot = await makeTempDir();
    try {
      const executor = new FileExecutor({ docs: root, other: otherRoot }, 1024);
      await fs.writeFile(join(root, "src.txt"), "hello", "utf8");

      const result = await executor.execute("copy", "docs", {
        src_relative_path: "src.txt",
        dst_root: otherRoot,
        dst_relative_path: "copied.txt",
      });

      expect(result.isError).toBeUndefined();
      await expect(fs.readFile(join(otherRoot, "copied.txt"), "utf8")).resolves.toBe("hello");
    } finally {
      await cleanTempDir(otherRoot);
    }
  });

  it("rejects a dst_root that doesn't resolve to any registered share — a compromised relay can't smuggle in an arbitrary destination", async () => {
    const unregistered = await makeTempDir();
    try {
      const executor = new FileExecutor({ docs: root }, 1024);
      await fs.writeFile(join(root, "src.txt"), "hello", "utf8");

      const result = await executor.execute("copy", "docs", {
        src_relative_path: "src.txt",
        dst_root: unregistered,
        dst_relative_path: "copied.txt",
      });

      expect(rejected(result)).toBe(true);
    } finally {
      await cleanTempDir(unregistered);
    }
  });
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
