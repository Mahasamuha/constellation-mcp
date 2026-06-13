import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "constellation-test-"));
}

export async function cleanTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
