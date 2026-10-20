/**
 * Standalone vitest config used only to run Plan A + Plan B tests.
 *
 * The repo's default vitest.config.ts wires ./src/test-setup.ts as a
 * globalSetup which unconditionally imports `embedded-postgres`; that
 * optional native dep (@embedded-postgres/windows-x64) is not installed
 * on this verification host, so the full `npm test` command fails before
 * any test runs. Since Plan A/B only touch src/ai/llm-client.ts +
 * src/ai/ner-pipeline-factory.ts and the AI code path never touches
 * Postgres, we can exercise the new tests safely with this minimal
 * config that skips the DB bootstrap.
 *
 * This file is a verification helper, NOT part of the shipped test
 * suite — operators should keep using `npm test` against the real
 * vitest.config.ts in normal development.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/ai/__tests__/llm-client-plan-a.test.ts",
      "src/ai/__tests__/llm-client-repair.test.ts",
      "src/ai/__tests__/llm-client-ner.test.ts",
      "src/ai/__tests__/ner-pipeline-factory.test.ts",
      "src/ai/__tests__/model-path-resolver.test.ts"
    ],
    fileParallelism: false
  }
});