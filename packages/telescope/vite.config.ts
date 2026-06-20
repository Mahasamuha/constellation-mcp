import { renameSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Vite names the bundled output after the entry HTML file (index.html).
// The relay expects the artifact at dist/app.html — rename it post-build.
function renameToAppHtml(): Plugin {
  return {
    name: "rename-to-app-html",
    closeBundle() {
      renameSync(resolve(__dirname, "dist/index.html"), resolve(__dirname, "dist/app.html"));
    },
  };
}

export default defineConfig({
  plugins: [react(), viteSingleFile(), renameToAppHtml()],
  build: {
    outDir: "dist",
    // style.css uses light-dark() with no static `color-scheme` declaration
    // (the actual scheme is set at runtime by useHostStyleVariables) — there's
    // nothing for lightningcss's older-browser light-dark() polyfill (used by
    // the production CSS minifier) to key off, so it emits references to
    // custom properties it never defines, silently breaking every themed
    // color. Targeting browsers that support light-dark() natively (the only
    // kind of webview an MCP Apps host would embed this in) skips that
    // polyfill and keeps light-dark() native, which is what lets the
    // runtime-set color-scheme drive it correctly in the first place.
    cssTarget: ["chrome123", "edge123", "firefox120", "safari17.5"],
  },
});
