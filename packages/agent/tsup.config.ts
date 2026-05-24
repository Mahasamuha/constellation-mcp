import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  outDir: "dist",
  sourcemap: true,
  // Bundle @constellation/shared since it is a workspace-only package not published to npm.
  noExternal: ["@constellation/shared"],
});
