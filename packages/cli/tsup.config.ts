import { defineConfig } from "tsup";
import { readFileSync } from "fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  // Main CLI bundle
  entry: ["src/cli.ts"],
  format: ["esm"],
  outDir: "dist",
  sourcemap: true,
  noExternal: ["@constellation/shared", "@constellation/node", "@constellation/hub"],
  esbuildOptions(options) {
    options.define = { ...options.define, __PKG_VERSION__: JSON.stringify(version) };
  },
});
