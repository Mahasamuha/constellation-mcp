import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("./packages/agent/package.json", import.meta.url), "utf8")
) as { version: string };

export default defineConfig({
  define: {
    __PKG_VERSION__: JSON.stringify(version),
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    env: { LOG_LEVEL: "silent" },
  },
});
