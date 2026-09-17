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
  },
  preview: {
    port: 5173,
  },
});
