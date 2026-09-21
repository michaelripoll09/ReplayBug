import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Production source maps stay enabled (RS-11): the production build
    // emits per-asset sibling `.map` files next to the hashed JS assets in
    // `dist`. The maps are build outputs for CLI upload only (RS-06/RS-07
    // upload path) — the browser never fetches them and the worker never
    // fetches remote maps, preserving existing privacy behavior. Maps are
    // external sibling files, never inlined into the served bundle.
    sourcemap: true,
  },
  server: {
    port: 5173,
    // Relative API calls from the demo (e.g. the intentional 500 endpoint)
    // are proxied to the local API server.
    proxy: {
      "/api": {
        target: "http://localhost:4001",
        changeOrigin: false,
      },
    },
  },
  preview: {
    port: 5173,
  },
});
