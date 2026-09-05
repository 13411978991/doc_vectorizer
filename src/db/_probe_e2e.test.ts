// Probe: trace folder.sourceId vs document.sourceId.
import { describe, it, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("probe", () => {
  it("logs sourceId flow", async () => {
    const { pool } = await import("./pool.js");
    const { createFolder, getManifest } = await import("../watcher/manifest-store.js");
    const { WatcherManager } = await import("../watcher/index.js");

    const TENANT = "probe-tenant";
    await pool.query("delete from watched_folders where tenant_id = $1", [TENANT]);

    const dir = mkdtempSync(join(tmpdir(), "probe-"));
    const folder = await createFolder({
      tenantId: TENANT,
      path: dir,
      displayName: "probe",
      recursive: true,
      metadata: { skipExtraction: true }
    });
    console.log("FOLDER_ID", folder.id, "SOURCE_ID", folder.sourceId);

    const manager = new WatcherManager({ debounceMs: 100 });
    await manager.startOne(folder);
    await new Promise(r => setTimeout(r, 200));
    writeFileSync(join(dir, "test.txt"), "hi");

    // Wait 5s
    await new Promise(r => setTimeout(r, 5000));

    const docCount = await pool.query("select count(*)::int as count from documents where source_id = $1", [folder.sourceId]);
    console.log("DOC_COUNT", docCount.rows[0]);
    const allDocs = await pool.query("select id, source_id, title from documents where source_id in (select source_id from watched_folders where id = $1)", [folder.id]);
    console.log("ALL_DOCS", allDocs.rows);

    await manager.stopAll();
  }, 60000);
});