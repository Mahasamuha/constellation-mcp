import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    env: { LOG_LEVEL: "silent" },
  },
});
