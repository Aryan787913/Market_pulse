import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite configuration.
 *
 * The dev server proxies /api to the Express backend on port 5000. This means
 * the browser only ever talks to one origin (localhost:5173) during
 * development, so there are no CORS preflight requests to debug while building
 * the UI. In production the frontend is built to static files and served behind
 * the same host as the API.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
