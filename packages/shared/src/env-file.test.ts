import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEnvFileValue, readEnvFileValue, atomicWriteFileSync } from "./env-file.js";

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "env-test-")); file = join(dir, "hub.env"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("writeEnvFileValue", () => {
  it("creates the file with mode 0600", () => {
    writeEnvFileValue(file, "CONSTELLATION_HUB_TOKEN", "abc");
    expect(readFileSync(file, "utf8")).toBe("CONSTELLATION_HUB_TOKEN=abc\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces the key, keeps other lines, and tightens an existing file's mode", () => {
    writeFileSync(file, "# comment\nOTHER=1\nCONSTELLATION_HUB_TOKEN=old\n\nLAST=2\n");
    chmodSync(file, 0o644);
    writeEnvFileValue(file, "CONSTELLATION_HUB_TOKEN", "new");
    expect(readFileSync(file, "utf8")).toBe("# comment\nOTHER=1\nCONSTELLATION_HUB_TOKEN=new\n\nLAST=2\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("appends a missing key", () => {
    writeFileSync(file, "OTHER=1\n");
    writeEnvFileValue(file, "K", "v");
    expect(readFileSync(file, "utf8")).toBe("OTHER=1\nK=v\n");
  });

  it.each(["a\nB=1", "a\rb", "a\0b"])("refuses a value with a line break or NUL (%j)", (value) => {
    writeFileSync(file, "OTHER=1\n");
    expect(() => writeEnvFileValue(file, "K", value)).toThrow(/line break|NUL/);
    expect(readFileSync(file, "utf8")).toBe("OTHER=1\n");
    expect(readdirSync(dir)).toEqual(["hub.env"]);
  });

  it.each(["lower", "1A", "A=B", "A B", ""])("refuses key %j", (key) => {
    expect(() => writeEnvFileValue(file, key, "v")).toThrow(/Invalid env var name/);
  });

  it("leaves no temp file when the write fails", () => {
    expect(() => writeEnvFileValue(join(dir, "missing", "x.env"), "K", "v")).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("atomicWriteFileSync", () => {
  it("removes its temp file when the rename fails", () => {
    // Renaming a file over a non-empty directory fails.
    const target = join(dir, "target");
    require_dir(target);
    expect(() => atomicWriteFileSync(target, "x", { mode: 0o600 })).toThrow();
    expect(readdirSync(dir)).toEqual(["target"]);
  });
});

import { mkdirSync } from "node:fs";
function require_dir(p: string) { mkdirSync(p); writeFileSync(join(p, "f"), ""); }

describe("readEnvFileValue", () => {
  it("reads the last assignment, unquoted, and tolerates a missing file or key", () => {
    expect(readEnvFileValue(file, "K")).toBeUndefined();
    writeFileSync(file, 'K=1\nOTHER=2\nK="two"\n');
    expect(readEnvFileValue(file, "K")).toBe("two");
    expect(readEnvFileValue(file, "MISSING")).toBeUndefined();
  });
});
