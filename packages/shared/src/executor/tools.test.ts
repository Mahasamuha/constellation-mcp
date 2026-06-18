import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { makeTempDir, cleanTempDir } from "../test/fixtures.js";
import { listDirectory, fileInfo, readFile } from "./tools/fs-read.js";
import { writeFile, createDirectory, deletePath, movePath, copyPath } from "./tools/fs-write.js";
import { findFiles, grepFiles } from "./tools/fs-search.js";
import { editFile } from "./tools/fs-edit.js";

let root: string;

beforeEach(async () => {
  root = await makeTempDir();
});

afterEach(async () => {
  await cleanTempDir(root);
});

// ---------------------------------------------------------------------------
// listDirectory
// ---------------------------------------------------------------------------

describe("listDirectory", () => {
  it("lists flat directory contents with correct types", async () => {
    await fs.writeFile(join(root, "a.txt"), "");
    await fs.writeFile(join(root, "b.txt"), "");
    await fs.mkdir(join(root, "sub"));

    const result = await listDirectory(root, root, {});
    const names = result.nodes.map((n) => n.path);

    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
    expect(names).toContain("sub");
    expect(result.nodes.find((n) => n.path === "sub")?.type).toBe("directory");
    expect(result.nodes.find((n) => n.path === "a.txt")?.type).toBe("file");
    expect(result.truncated).toBe(false);
  });

  it("lists recursively", async () => {
    await fs.mkdir(join(root, "sub"));
    await fs.writeFile(join(root, "sub", "deep.ts"), "");

    const result = await listDirectory(root, root, { recursive: true });
    const paths = result.nodes.map((n) => n.path);

    expect(paths).toContain("sub");
    expect(paths).toContain(join("sub", "deep.ts"));
  });

  it("respects max_depth", async () => {
    await fs.mkdir(join(root, "a"));
    await fs.mkdir(join(root, "a", "b"));
    await fs.writeFile(join(root, "a", "b", "deep.txt"), "");

    const result = await listDirectory(root, root, { recursive: true, max_depth: 1 });
    const paths = result.nodes.map((n) => n.path);

    expect(paths).toContain("a");
    expect(paths).toContain(join("a", "b"));
    // depth-2 file is beyond max_depth=1 so the recursion into 'b' is skipped
    expect(paths).not.toContain(join("a", "b", "deep.txt"));
    expect(result.truncated).toBe(true);
    expect(result.truncated_by).toBe("max_depth");
  });

  it("excludes matching names", async () => {
    await fs.mkdir(join(root, "node_modules"));
    await fs.writeFile(join(root, "index.ts"), "");

    const result = await listDirectory(root, root, { exclude: ["node_modules"] });
    const paths = result.nodes.map((n) => n.path);

    expect(paths).not.toContain("node_modules");
    expect(paths).toContain("index.ts");
  });

  it("truncates at limit and sets truncated_by=limit", async () => {
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(join(root, `file${i}.txt`), "");
    }

    const result = await listDirectory(root, root, { limit: 3 });
    expect(result.nodes.length).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.truncated_by).toBe("limit");
  });

  it("limit:0 uses hard cap (does not error on normal-sized dirs)", async () => {
    await fs.writeFile(join(root, "a.txt"), "");
    const result = await listDirectory(root, root, { limit: 0 });
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it("scopes to relative_path subdirectory", async () => {
    await fs.mkdir(join(root, "sub"));
    await fs.writeFile(join(root, "sub", "nested.txt"), "");
    await fs.writeFile(join(root, "other.txt"), "");

    const result = await listDirectory(root, join(root, "sub"), {});
    const paths = result.nodes.map((n) => n.path);

    expect(paths).toContain(join("sub", "nested.txt"));
    expect(paths).not.toContain("other.txt");
  });
});

// ---------------------------------------------------------------------------
// fileInfo
// ---------------------------------------------------------------------------

describe("fileInfo", () => {
  it("returns correct metadata for a regular file", async () => {
    await fs.writeFile(join(root, "hello.txt"), "hello");
    const info = await fileInfo(join(root, "hello.txt"));

    expect(info.type).toBe("file");
    expect(info.size).toBe(5);
    expect(typeof info.mtime).toBe("string");
    expect(info.target).toBeUndefined();
  });

  it("returns type:directory for a directory", async () => {
    await fs.mkdir(join(root, "mydir"));
    const info = await fileInfo(join(root, "mydir"));
    expect(info.type).toBe("directory");
  });

  it("returns type:symlink and target for a symlink", async () => {
    await fs.writeFile(join(root, "real.txt"), "content");
    await fs.symlink(join(root, "real.txt"), join(root, "link.txt"));

    const info = await fileInfo(join(root, "link.txt"));
    expect(info.type).toBe("symlink");
    expect(info.target).toBe(join(root, "real.txt"));
  });

  it("throws when path does not exist", async () => {
    await expect(fileInfo(join(root, "nope.txt"))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// findFiles
// ---------------------------------------------------------------------------

describe("findFiles", () => {
  it("matches files by glob pattern", async () => {
    await fs.writeFile(join(root, "a.ts"), "");
    await fs.writeFile(join(root, "b.js"), "");
    await fs.mkdir(join(root, "sub"));
    await fs.writeFile(join(root, "sub", "c.ts"), "");

    const result = await findFiles(root, root, { pattern: "*.ts" });
    const names = result.matches.map((m) => m.replace(/\\/g, "/"));

    expect(names).toContain("a.ts");
    expect(names).toContain("sub/c.ts");
    expect(names).not.toContain("b.js");
    expect(result.truncated).toBe(false);
  });

  it("matches files by regex pattern", async () => {
    await fs.writeFile(join(root, "config.test.ts"), "");
    await fs.writeFile(join(root, "index.ts"), "");

    const result = await findFiles(root, root, { pattern: "\\.test\\.", type: "regex" });
    expect(result.matches.some((m) => m.includes("config.test.ts"))).toBe(true);
    expect(result.matches.some((m) => m.includes("index.ts"))).toBe(false);
  });

  it("scopes search to relative_path", async () => {
    await fs.mkdir(join(root, "src"));
    await fs.writeFile(join(root, "root.ts"), "");
    await fs.writeFile(join(root, "src", "inner.ts"), "");

    const result = await findFiles(root, join(root, "src"), { pattern: "*.ts" });
    expect(result.matches.some((m) => m.includes("inner.ts"))).toBe(true);
    expect(result.matches.some((m) => m === "root.ts")).toBe(false);
  });

  it("returns no matches for unmatched pattern", async () => {
    await fs.writeFile(join(root, "a.ts"), "");
    const result = await findFiles(root, root, { pattern: "*.py" });
    expect(result.matches).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it("truncates at 200 results", async () => {
    for (let i = 0; i < 201; i++) {
      await fs.writeFile(join(root, `file${i}.ts`), "");
    }
    const result = await findFiles(root, root, { pattern: "*.ts" });
    expect(result.matches).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

describe("readFile", () => {
  it("reads full file content under cap", async () => {
    await fs.writeFile(join(root, "hello.txt"), "line1\nline2\nline3");
    const result = await readFile(join(root, "hello.txt"), {
      max_file_size_kb: 100,
    });

    expect(result.content).toBe("line1\nline2\nline3");
    expect(result.total_lines).toBe(3);
  });

  it("throws FILE_TOO_LARGE for full read over cap", async () => {
    await fs.writeFile(join(root, "big.txt"), "x".repeat(2048));

    const err = await readFile(join(root, "big.txt"), {
      max_file_size_kb: 1,
    }).catch((e) => e);

    expect(err.code).toBe("FILE_TOO_LARGE");
  });

  it("reads a line range from a small file", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    await fs.writeFile(join(root, "multi.txt"), lines.join("\n"));

    const result = await readFile(join(root, "multi.txt"), {
      start_line: 3,
      end_line: 5,
      max_file_size_kb: 100,
    });

    expect(result.content).toBe("line3\nline4\nline5");
    expect(result.total_lines).toBe(10);
  });

  it("reads to EOF when end_line is omitted", async () => {
    await fs.writeFile(join(root, "f.txt"), "a\nb\nc");
    const result = await readFile(join(root, "f.txt"), {
      start_line: 2,
      max_file_size_kb: 100,
    });
    expect(result.content).toBe("b\nc");
  });

  it("uses streamed path for range read on oversized file", async () => {
    // File > 1KB so stat.size > capBytes, range read triggers streamed path
    const line = "x".repeat(20);
    const content = Array.from({ length: 60 }, () => line).join("\n");
    await fs.writeFile(join(root, "large.txt"), content);

    const result = await readFile(join(root, "large.txt"), {
      start_line: 1,
      end_line: 3,
      max_file_size_kb: 1,
    });

    expect(result.content).toBe([line, line, line].join("\n"));
    expect(result.total_lines).toBe(60);
  });

  it("throws READ_TOO_LARGE from streamed path when range exceeds cap", async () => {
    // File > 1KB, request all lines (exceeds 1KB cap)
    const line = "x".repeat(40);
    const content = Array.from({ length: 60 }, () => line).join("\n");
    await fs.writeFile(join(root, "large.txt"), content);

    const err = await readFile(join(root, "large.txt"), {
      start_line: 1,
      end_line: 60,
      max_file_size_kb: 1,
    }).catch((e) => e);

    expect(err.code).toBe("READ_TOO_LARGE");
  });
});

// ---------------------------------------------------------------------------
// grepFiles
// ---------------------------------------------------------------------------

describe("grepFiles", () => {
  it("finds literal matches across files", async () => {
    await fs.writeFile(join(root, "a.txt"), "hello world\nfoo bar");
    await fs.writeFile(join(root, "b.txt"), "no match here");

    const result = await grepFiles(root, root, { pattern: "hello" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.file).toContain("a.txt");
    expect(result.results[0]!.matches[0]!.line).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("finds regex matches", async () => {
    await fs.writeFile(join(root, "code.ts"), "const foo = 1;\nlet bar = 2;");

    const result = await grepFiles(root, root, { pattern: "^(const|let)", type: "regex" });
    expect(result.results[0]!.matches).toHaveLength(2);
  });

  it("scopes search with file_glob", async () => {
    await fs.writeFile(join(root, "a.ts"), "TARGET");
    await fs.writeFile(join(root, "a.js"), "TARGET");

    const result = await grepFiles(root, root, { pattern: "TARGET", file_glob: "*.ts" });
    expect(result.results.every((r) => r.file.endsWith(".ts"))).toBe(true);
  });

  it("searches a single file when relative_path is a file", async () => {
    await fs.writeFile(join(root, "only.txt"), "found it");
    await fs.writeFile(join(root, "other.txt"), "found it too");

    const result = await grepFiles(root, join(root, "only.txt"), {
      pattern: "found it",
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.file).toContain("only.txt");
  });

  it("truncates at 50 matches", async () => {
    const lines = Array.from({ length: 51 }, () => "MATCH").join("\n");
    await fs.writeFile(join(root, "dense.txt"), lines);

    const result = await grepFiles(root, root, { pattern: "MATCH" });
    const total = result.results.reduce((s, r) => s + r.matches.length, 0);

    expect(total).toBe(50);
    expect(result.truncated).toBe(true);
  });

  it("groups matches by file", async () => {
    await fs.writeFile(join(root, "x.txt"), "hit\nhit\nhit");

    const result = await grepFiles(root, root, { pattern: "hit" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.matches).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// writeFile
// ---------------------------------------------------------------------------

describe("writeFile", () => {
  it("creates a new file with content", async () => {
    await writeFile(join(root, "new.txt"), { content: "hello" });
    expect(await fs.readFile(join(root, "new.txt"), "utf8")).toBe("hello");
  });

  it("overwrites existing file content", async () => {
    await fs.writeFile(join(root, "existing.txt"), "old");
    await writeFile(join(root, "existing.txt"), { content: "new" });
    expect(await fs.readFile(join(root, "existing.txt"), "utf8")).toBe("new");
  });

  it("appends to existing file", async () => {
    await fs.writeFile(join(root, "log.txt"), "line1\n");
    await writeFile(join(root, "log.txt"), {
      content: "line2\n",
      mode: "append",
    });
    expect(await fs.readFile(join(root, "log.txt"), "utf8")).toBe("line1\nline2\n");
  });

  it("creates parent directories on write", async () => {
    await writeFile(join(root, "deep", "nested", "file.txt"), { content: "x" });
    expect(await fs.readFile(join(root, "deep", "nested", "file.txt"), "utf8")).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// editFile
// ---------------------------------------------------------------------------

describe("editFile", () => {
  it("applies a single edit", async () => {
    await fs.writeFile(join(root, "f.txt"), "hello world");
    await editFile(join(root, "f.txt"), "f.txt", {
      edits: [{ old_text: "hello", new_text: "goodbye" }],
    });
    expect(await fs.readFile(join(root, "f.txt"), "utf8")).toBe("goodbye world");
  });

  it("applies multiple edits in order", async () => {
    await fs.writeFile(join(root, "f.txt"), "aaa bbb ccc");
    await editFile(join(root, "f.txt"), "f.txt", {
      edits: [
        { old_text: "aaa", new_text: "AAA" },
        { old_text: "bbb", new_text: "BBB" },
      ],
    });
    expect(await fs.readFile(join(root, "f.txt"), "utf8")).toBe("AAA BBB ccc");
  });

  it("throws EDIT_NO_MATCH when old_text not found", async () => {
    await fs.writeFile(join(root, "f.txt"), "original content");
    const err = await editFile(join(root, "f.txt"), "f.txt", {
      edits: [{ old_text: "NOTFOUND", new_text: "x" }],
    }).catch((e) => e);

    expect(err.code).toBe("EDIT_NO_MATCH");
    expect(err.edit_index).toBe(0);
  });

  it("throws EDIT_AMBIGUOUS when old_text matches multiple times", async () => {
    await fs.writeFile(join(root, "f.txt"), "foo bar foo");
    const err = await editFile(join(root, "f.txt"), "f.txt", {
      edits: [{ old_text: "foo", new_text: "baz" }],
    }).catch((e) => e);

    expect(err.code).toBe("EDIT_AMBIGUOUS");
    expect(err.match_count).toBe(2);
  });

  it("leaves file untouched when a later edit fails", async () => {
    await fs.writeFile(join(root, "f.txt"), "aaa bbb ccc");
    await editFile(join(root, "f.txt"), "f.txt", {
      edits: [
        { old_text: "aaa", new_text: "AAA" },
        { old_text: "NOTFOUND", new_text: "x" },
      ],
    }).catch(() => {});

    // File must be unchanged
    expect(await fs.readFile(join(root, "f.txt"), "utf8")).toBe("aaa bbb ccc");
  });

  it("dry_run returns diff without writing", async () => {
    await fs.writeFile(join(root, "f.txt"), "before");
    const result = await editFile(join(root, "f.txt"), "f.txt", {
      edits: [{ old_text: "before", new_text: "after" }],
      dry_run: true,
    });

    expect(result.diff).toContain("-before");
    expect(result.diff).toContain("+after");
    expect(await fs.readFile(join(root, "f.txt"), "utf8")).toBe("before");
  });

  it("returns a unified diff on successful edit", async () => {
    await fs.writeFile(join(root, "f.txt"), "original");
    const result = await editFile(join(root, "f.txt"), "f.txt", {
      edits: [{ old_text: "original", new_text: "modified" }],
    });
    expect(typeof result.diff).toBe("string");
    expect(result.diff.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// copyPath
// ---------------------------------------------------------------------------

describe("copyPath", () => {
  it("copies a file", async () => {
    await fs.writeFile(join(root, "src.txt"), "content");
    await copyPath(join(root, "src.txt"), join(root, "dst.txt"), { dst_relative_path: "dst.txt" });

    expect(await fs.readFile(join(root, "dst.txt"), "utf8")).toBe("content");
    // Source still exists
    await expect(fs.access(join(root, "src.txt"))).resolves.toBeUndefined();
  });

  it("copies a directory recursively", async () => {
    await fs.mkdir(join(root, "srcdir"));
    await fs.writeFile(join(root, "srcdir", "a.txt"), "a");
    await fs.writeFile(join(root, "srcdir", "b.txt"), "b");

    await copyPath(join(root, "srcdir"), join(root, "dstdir"), { dst_relative_path: "dstdir" });

    expect(await fs.readFile(join(root, "dstdir", "a.txt"), "utf8")).toBe("a");
    expect(await fs.readFile(join(root, "dstdir", "b.txt"), "utf8")).toBe("b");
  });

  it("throws DEST_EXISTS when destination already exists", async () => {
    await fs.writeFile(join(root, "src.txt"), "a");
    await fs.writeFile(join(root, "dst.txt"), "b");

    const err = await copyPath(join(root, "src.txt"), join(root, "dst.txt"), {
      dst_relative_path: "dst.txt",
    }).catch((e) => e);

    expect(err.code).toBe("DEST_EXISTS");
  });

  it("skips symlinks found during a recursive directory copy", async () => {
    await fs.mkdir(join(root, "secret"));
    await fs.writeFile(join(root, "secret", "id_rsa"), "private-key-contents");
    await fs.mkdir(join(root, "srcdir"));
    await fs.writeFile(join(root, "srcdir", "a.txt"), "a");
    await fs.symlink(join(root, "secret", "id_rsa"), join(root, "srcdir", "link.txt"));

    await copyPath(join(root, "srcdir"), join(root, "dstdir"), { dst_relative_path: "dstdir" });

    expect(await fs.readFile(join(root, "dstdir", "a.txt"), "utf8")).toBe("a");
    await expect(fs.access(join(root, "dstdir", "link.txt"))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// movePath
// ---------------------------------------------------------------------------

describe("movePath", () => {
  it("moves a file", async () => {
    await fs.writeFile(join(root, "src.txt"), "data");
    await movePath(join(root, "src.txt"), join(root, "dst.txt"), { dst_relative_path: "dst.txt" });

    expect(await fs.readFile(join(root, "dst.txt"), "utf8")).toBe("data");
    await expect(fs.access(join(root, "src.txt"))).rejects.toThrow();
  });

  it("throws DEST_EXISTS when destination already exists", async () => {
    await fs.writeFile(join(root, "src.txt"), "a");
    await fs.writeFile(join(root, "dst.txt"), "b");

    const err = await movePath(join(root, "src.txt"), join(root, "dst.txt"), {
      dst_relative_path: "dst.txt",
    }).catch((e) => e);

    expect(err.code).toBe("DEST_EXISTS");
  });

  it("creates destination parent directories", async () => {
    await fs.writeFile(join(root, "file.txt"), "x");
    const dstRelativePath = join("deep", "nested", "file.txt");
    await movePath(join(root, "file.txt"), join(root, dstRelativePath), {
      dst_relative_path: dstRelativePath,
    });
    expect(
      await fs.readFile(join(root, "deep", "nested", "file.txt"), "utf8")
    ).toBe("x");
  });
});

describe("movePath EXDEV fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports MOVE_INCOMPLETE when the cross-filesystem copy fails partway through", async () => {
    await fs.writeFile(join(root, "src.txt"), "data");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("cross-device link"), { code: "EXDEV" }));
    vi.spyOn(fs, "copyFile").mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));

    const err = await movePath(join(root, "src.txt"), join(root, "dst.txt"), {
      dst_relative_path: "dst.txt",
    }).catch((e) => e);

    expect(err.code).toBe("MOVE_INCOMPLETE");
    expect(err.message).toContain("partial copy");
    // Source untouched, destination never created — we don't try to clean up after a
    // failed step, so the filesystem should be left exactly where the failure left it.
    expect(await fs.readFile(join(root, "src.txt"), "utf8")).toBe("data");
    await expect(fs.access(join(root, "dst.txt"))).rejects.toThrow();
  });

  it("reports MOVE_INCOMPLETE when removing the original after a successful copy fails", async () => {
    await fs.writeFile(join(root, "src.txt"), "data");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("cross-device link"), { code: "EXDEV" }));
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("EBUSY: resource busy or locked"));

    const err = await movePath(join(root, "src.txt"), join(root, "dst.txt"), {
      dst_relative_path: "dst.txt",
    }).catch((e) => e);

    expect(err.code).toBe("MOVE_INCOMPLETE");
    expect(err.message).toContain("Both now exist");
    // Copy already succeeded before the delete failed, so both copies legitimately exist now.
    expect(await fs.readFile(join(root, "src.txt"), "utf8")).toBe("data");
    expect(await fs.readFile(join(root, "dst.txt"), "utf8")).toBe("data");
  });
});

// ---------------------------------------------------------------------------
// createDirectory
// ---------------------------------------------------------------------------

describe("createDirectory", () => {
  it("creates a single directory", async () => {
    await createDirectory(join(root, "newdir"));
    const stat = await fs.stat(join(root, "newdir"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("creates nested directories", async () => {
    await createDirectory(join(root, "a", "b", "c"));
    const stat = await fs.stat(join(root, "a", "b", "c"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("does not throw if directory already exists", async () => {
    await fs.mkdir(join(root, "exists"));
    await expect(createDirectory(join(root, "exists"))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deletePath
// ---------------------------------------------------------------------------

describe("deletePath", () => {
  it("deletes a file", async () => {
    await fs.writeFile(join(root, "del.txt"), "x");
    await deletePath(join(root, "del.txt"), { relative_path: "del.txt" });
    await expect(fs.access(join(root, "del.txt"))).rejects.toThrow();
  });

  it("returns confirmation summary for directory without recursive flag", async () => {
    await fs.mkdir(join(root, "mydir"));
    await fs.writeFile(join(root, "mydir", "a.txt"), "hello");
    await fs.writeFile(join(root, "mydir", "b.txt"), "world");

    const result = await deletePath(join(root, "mydir"), { relative_path: "mydir" });

    expect(result).toMatchObject({
      requires_confirmation: true,
      path: "mydir",
      file_count: 2,
    });
    // Directory is still there
    await expect(fs.access(join(root, "mydir"))).resolves.toBeUndefined();
  });

  it("deletes directory with recursive:true", async () => {
    await fs.mkdir(join(root, "mydir"));
    await fs.writeFile(join(root, "mydir", "file.txt"), "x");

    await deletePath(join(root, "mydir"), { relative_path: "mydir", recursive: true });
    await expect(fs.access(join(root, "mydir"))).rejects.toThrow();
  });
});
