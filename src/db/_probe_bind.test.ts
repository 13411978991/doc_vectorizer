// Probe pg array binding inside vitest context.
import { describe, it } from "vitest";

describe("probe pg array binding", () => {
  it("checks what happens with arrays", async () => {
    const pg = await import("pg");
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query("delete from sources");
      const id = "00000000-0000-0000-0000-000000000001";
      await c.query(
        `insert into sources (id, tenant_id, kind, name, description, metadata)
         values ($1, 't', 'audit_project', 's', null, '{}'::jsonb)`,
        [id]
      );
      console.log("--- JS array ---");
      try {
        const r = await c.query("select name from sources where id = any($1::uuid[])", [[id]]);
        console.log("rows:", r.rowCount);
      } catch (e) { console.log("ERR:", (e as Error).message); }

      console.log("--- JS array without cast ---");
      try {
        const r = await c.query("select name from sources where id = any($1)", [[id]]);
        console.log("rows:", r.rowCount);
      } catch (e) { console.log("ERR:", (e as Error).message); }

      console.log("--- JSON-stringified array ---");
      try {
        const r = await c.query("select name from sources where id = any($1::uuid[])", [JSON.stringify([id])]);
        console.log("rows:", r.rowCount);
      } catch (e) { console.log("ERR:", (e as Error).message); }

      console.log("--- text array literal cast ---");
      try {
        const r = await c.query(`select name from sources where id = any($1::uuid[])`, [`{${id}}`]);
        console.log("rows:", r.rowCount);
      } catch (e) { console.log("ERR:", (e as Error).message); }
    } finally {
      await c.end();
    }
  });
});