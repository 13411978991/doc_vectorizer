import { defineConfig } from "vitest/config";

// Use this config when the test is a pure-predicate test that does
// not need DB / migrations / ai-services. Skips the globalSetup
// migration step that would otherwise try to connect to
// ./data/sag.db (which the test-setup.ts guard now refuses to do).
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false
  }
});
