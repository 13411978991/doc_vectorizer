/**
 * src/api/__tests__/mcp-session-routes.test.ts
 *
 * Locks in the "non-UUID projectId returns empty sessions" contract.
 * Regression: legacy seed rows (e.g. `src-debug-179163...` fixtures)
 * have non-UUID primary keys but are still surfaced by listProjects()
 * because they're not archived. The SPA polls
 * /api/projects/:projectId/mcp/sessions every 5s, and a 400 here
 * pops a "Invalid uuid" toast on every tick. Returning an empty
 * sessions array is silent and correct: the row isn't a real project,
 * so by definition it has no linked sessions.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// We need a fastify instance + the route registered. Stub out
// mcpAgentService and repositories so the route handler runs without
// touching the real DB. vi.mock() factories are hoisted above all
// top-level code, so the mock-fn references must be hoisted with
// vi.hoisted() (otherwise the factory hits a TDZ on the variable).
const { listSessionsMock, getLinkedSourceIdsMock } = vi.hoisted(() => ({
  // listSessions returns a typed array; without the explicit generic
  // TS infers `never[]` from the vi.fn(async () => []) literal and
  // the test's `mockResolvedValueOnce([{ id: "s1" }])` fails to
  // assign. Spelling out the shape keeps the mock honest.
  listSessionsMock: vi.fn(async (): Promise<Array<{ id: string; title?: string; updatedAt?: string }>> => []),
  getLinkedSourceIdsMock: vi.fn(async () => ["linked-id"])
}));

vi.mock("../../services/mcp-agent-service.js", () => ({
  mcpAgentService: {
    listSessions: listSessionsMock
  }
}));

vi.mock("../../db/repositories.js", () => ({
  getLinkedSourceIds: getLinkedSourceIdsMock
}));

import Fastify from "fastify";
import { registerMcpSessionRoutes } from "../mcp-session-routes.js";

async function buildApp() {
  const app = Fastify();
  registerMcpSessionRoutes(app);
  await app.ready();
  return app;
}

describe("GET /api/projects/:projectId/mcp/sessions", () => {
  beforeEach(() => {
    listSessionsMock.mockClear();
    getLinkedSourceIdsMock.mockClear();
  });

  it("returns empty sessions for a non-UUID projectId (no 400, no DB call)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/src-debug-1791631384090/mcp/sessions"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessions: [] });
    // Critical: we should NOT have hit the DB or the agent service.
    // The whole point of the early return is to avoid surfacing a 400
    // to the SPA's polling loop.
    expect(getLinkedSourceIdsMock).not.toHaveBeenCalled();
    expect(listSessionsMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns empty sessions for any malformed projectId", async () => {
    const app = await buildApp();
    for (const bad of ["", "abc", "not-a-uuid", "123", "foo/bar"]) {
      const encoded = encodeURIComponent(bad);
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${encoded}/mcp/sessions`
      });
      expect(res.statusCode, `bad id: ${JSON.stringify(bad)}`).toBe(200);
      expect(res.json()).toEqual({ sessions: [] });
    }
    expect(getLinkedSourceIdsMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("proceeds to DB lookup for a well-formed UUID", async () => {
    const app = await buildApp();
    getLinkedSourceIdsMock.mockResolvedValueOnce(["uuid-id"]);
    listSessionsMock.mockResolvedValueOnce([{ id: "s1" }]);
    const uuid = "47c3ef14-5c15-4f45-8c2d-d7d16325014b";
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${uuid}/mcp/sessions`
    });
    expect(res.statusCode).toBe(200);
    expect(getLinkedSourceIdsMock).toHaveBeenCalledWith({
      sourceId: uuid,
      tenantId: expect.any(String)
    });
    expect(listSessionsMock).toHaveBeenCalledWith({ sourceIds: ["uuid-id"] });
    expect(res.json()).toEqual({ sessions: [{ id: "s1" }] });
    await app.close();
  });
});
