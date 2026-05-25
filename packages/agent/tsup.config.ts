import { defineConfig } from "tsup";
import { readFileSync } from "fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  outDir: "dist",
  sourcemap: true,
  // Bundle @constellation/shared since it is a workspace-only package not published to npm.
  noExternal: ["@constellation/shared"],
  esbuildOptions(options) {
    options.define = { ...options.define, __PKG_VERSION__: JSON.stringify(version) };
  },
});
