import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: ["./src/test-setup.ts"],
    fileParallelism: false
  }
});
