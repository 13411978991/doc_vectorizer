/**
 * Standalone vitest config for Plan B NER + resolver tests.
 *
 * Mirrors `vitest.plan-a.config.ts` — skips the embedded-postgres
 * globalSetup that the default vitest.config.ts wires in, because
 * that optional native dep (@embedded-postgres/windows-x64) is not
 * installed on this verification host. The Plan B tests never touch
 * Postgres so this minimal config is safe.
 *
 * Includes Plan A's `llm-client-plan-a.test.ts` so we can confirm
 * no regression after switching `extractNamedEntities` from regex
 * to NER.
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
      "src/ai/__tests__/ner-pipeline-factory.test.ts",
      "src/ai/__tests__/model-path-resolver.test.ts",
      "src/ai/__tests__/llm-client-ner.test.ts"
    ],
    fileParallelism: false
  }
});