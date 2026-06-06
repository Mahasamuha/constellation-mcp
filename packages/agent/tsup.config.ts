import { defineConfig } from "tsup";
import { readFileSync } from "fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig([
  {
    // Main CLI bundle
    entry: ["src/cli.ts"],
    format: ["esm"],
    outDir: "dist",
    sourcemap: true,
    noExternal: ["@constellation/shared"],
    esbuildOptions(options) {
      options.define = { ...options.define, __PKG_VERSION__: JSON.stringify(version) };
    },
  },
  {
    // Subagent worker — CJS so pino's dynamic require('node:*') works without an ESM shim
    entry: { "shared/subagent-worker": "src/shared/subagent-worker.ts" },
    format: ["cjs"],
    outDir: "dist",
    sourcemap: true,
    noExternal: ["@constellation/shared"],
    outExtension: () => ({ js: ".cjs" }),
    banner: {
      js: "// Constellation shared agent subagent worker — do not run directly",
    },
  },
]);
