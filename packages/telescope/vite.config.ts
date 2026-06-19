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
  },
});
