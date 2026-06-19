import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { version } = JSON.parse(
  readFileSync(new URL("./packages/cli/package.json", import.meta.url), "utf8")
) as { version: string };

export default defineConfig({
  resolve: {
    alias: {
      // Point workspace packages at their TypeScript source so tests don't
      // require a prior build (dist/ may not exist in CI).
      "@constellation/shared": join(__dirname, "packages/shared/src/index.ts"),
      "@constellation/node/cli": join(__dirname, "packages/node/src/cli.ts"),
      "@constellation/node/config": join(__dirname, "packages/node/src/config.ts"),
      "@constellation/hub/cli": join(__dirname, "packages/hub/src/cli.ts"),
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
