import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import react from "@vitejs/plugin-react";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { version } = JSON.parse(
  readFileSync(new URL("./packages/cli/package.json", import.meta.url), "utf8")
) as { version: string };

export default defineConfig({
  // Only transforms .jsx/.tsx files (telescope's component tests) — a no-op for every
  // other package's plain .ts files, so this is safe to apply repo-wide rather than
  // scoping it, which Vite's plugin system doesn't support per-glob anyway.
  plugins: [react()],
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
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx"],
    // Default stays plain "node" for every package's fast, DOM-free unit tests.
    // telescope's component tests render real React components and need a DOM —
    // opt into it per file with a `// @vitest-environment jsdom` docblock comment
    // instead of a global override here. (Vitest 3's environmentMatchGlobs, which
    // did this at the config level, was removed in Vitest 4.)
    environment: "node",
    env: { LOG_LEVEL: "silent" },
  },
});
