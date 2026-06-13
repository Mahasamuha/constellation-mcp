import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Library entry points consumed by @constellation/node
    entry: ["src/index.ts", "src/cli.ts"],
    format: ["esm"],
    outDir: "dist",
    sourcemap: true,
    dts: true,
    noExternal: ["@constellation/shared"],
  },
  {
    // Subnode worker — CJS so pino's dynamic require('node:*') works without an ESM shim
    entry: { "subnode-worker": "src/subnode-worker.ts" },
    format: ["cjs"],
    outDir: "dist",
    sourcemap: true,
    noExternal: ["@constellation/shared"],
    outExtension: () => ({ js: ".cjs" }),
    banner: {
      js: "// Constellation hub subnode worker — do not run directly",
    },
  },
]);
