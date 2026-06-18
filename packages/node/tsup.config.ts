import { defineConfig } from "tsup";

export default defineConfig({
  // Library entry points consumed by @mahasamuha/constellation-cli (packages/cli)
  entry: ["src/index.ts", "src/cli.ts", "src/config.ts"],
  format: ["esm"],
  outDir: "dist",
  sourcemap: true,
  dts: true,
  noExternal: ["@constellation/shared"],
});
