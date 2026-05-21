import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  outDir: "dist",
  // Bundle @constellation/shared since it is a workspace-only package not published to npm.
  // All other dependencies are left external and installed from the registry normally.
  noExternal: ["@constellation/shared"],
  banner: { js: "#!/usr/bin/env node" },
});
