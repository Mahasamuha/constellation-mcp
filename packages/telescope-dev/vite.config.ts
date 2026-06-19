import { defineConfig } from "vite";

// Own port so `npm run dev` here can run alongside telescope's dev server
// (default 5173) without colliding.
export default defineConfig({
  server: { port: 5174 },
});
