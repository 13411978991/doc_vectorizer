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
    cssMinify: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // NOTE on chunk strategy (2026-09-12):
        // We previously split vendor-react / vendor-misc / vendor-zod
        // by manualChunks, but zustand (and several smaller deps)
        // reach React transitively, producing a circular chunk graph:
        //   vendor-misc -> vendor-react -> vendor-misc
        // When Electron loads these as separate <script type=module>
        // entries the import order is non-deterministic, so React
        // can be undefined at first evaluation of vendor-misc and
        // `useState is undefined` blows up before the app paints.
        // We let Rollup pick boundaries instead of forcing circular
        // ones. chunkSizeWarningLimit: 600 keeps Rollup from warning
        // about the resulting larger vendor entry.
        manualChunks: undefined,
      }
    }
  }
});
