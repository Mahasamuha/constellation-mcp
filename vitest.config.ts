import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { version } = JSON.parse(
  readFileSync(new URL("./packages/node/package.json", import.meta.url), "utf8")
) as { version: string };

export default defineConfig({
  resolve: {
    alias: {
      // Point the workspace package at its TypeScript source so tests don't
      // require a prior build of @constellation/shared (dist/ may not exist in CI).
      "@constellation/shared": join(__dirname, "packages/shared/src/index.ts"),
    },
  },
  define: {
    __PKG_VERSION__: JSON.stringify(version),
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    env: { LOG_LEVEL: "silent" },
  },
});
