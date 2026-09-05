import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4173",
      "/health": "http://127.0.0.1:4173",
      "/sources": "http://127.0.0.1:4173",
      "/ingest": "http://127.0.0.1:4173",
      "/search": "http://127.0.0.1:4173",
      "/events": "http://127.0.0.1:4173"
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssMinify: false
  }
});
