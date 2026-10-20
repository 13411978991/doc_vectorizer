import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: ["./src/test-setup.ts"],
    // P-Tier3-#T3d-testfix — runs in the test worker's V8 isolate
    // so initPool() wires the lazy pool proxy in the same module
    // graph that the test imports. globalSetup runs in a separate
    // parent process and its _pool value is invisible to workers.
    setupFiles: ["./src/test-setup-runtime.ts"],
    fileParallelism: false
  }
});
