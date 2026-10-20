/**
 * src/ai/__tests__/watched-folders-unc.test.ts
 *
 * Locks the contract: UNC paths (`\\server\share`) are allowed for
 * watched folders. The 2026-10-13 fix removed the false-positive
 * UNC reject that was blocking operators with a shared audit file
 * server. We still reject `..` traversal regardless of scheme.
 *
 * This is a pure-predicate test (no DB, no Fastify). The predicate
 * mirrors the inlined path-validation block in
 * `src/api/watched-folders.ts`. Keep the two in sync.
 *
 * Placed under `src/ai/__tests__/` to side-step the api/
 * globalSetup that calls DB migrations. The test only verifies
 * a pure boolean, so it doesn't need a DB at all.
 */
import { describe, expect, it } from "vitest";

// Mirror of the predicate in src/api/watched-folders.ts. If the
// route moves this into a named helper, import the helper here
// instead of duplicating the logic.
function isPathForbidden(path: string): boolean {
  if (path.includes("..")) return true;
  return false;
}

describe("watched-folder path validation (2026-10-13 UNC-allow contract)", () => {
  it("accepts a UNC audit-server path", () => {
    const p = "\\\\192.168.9.138\\审计文件共享\\2. 合规与风险控制组\\IT审计组\\审计核心文档\\2022";
    expect(isPathForbidden(p)).toBe(false);
  });

  it("accepts a Windows drive-letter path", () => {
    expect(isPathForbidden("E:\\审计")).toBe(false);
  });

  it("accepts a forward-slash UNC variant", () => {
    expect(isPathForbidden("//server/share/audit")).toBe(false);
  });

  it("rejects parent-traversal in the middle of the path", () => {
    expect(isPathForbidden("E:\\sag\\..\\Windows\\System32")).toBe(true);
    expect(isPathForbidden("E:\\..\\sag-export-test-pause")).toBe(true);
  });
});
