import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Production source maps stay enabled so the future source-map
    // symbolication flow can be exercised against this app.
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
