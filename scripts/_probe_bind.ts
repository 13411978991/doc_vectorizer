// Probe pg-node param binding for arrays.
process.env.DATABASE_URL = "postgres://sag_test:sag_test@127.0.0.1:54329/sag_test";
process.env.SAG_WATCHER_SKIP_PREFLIGHT = "1";
process.env.PG_DATA_DIR = "./data/pg-test";
process.env.EMBEDDING_PROVIDER = "local";
process.env.LC_ALL = "C";
process.env.LANG = "C";

import { setup } from "../src/test-setup.js";
import pg from "pg";
await setup();

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  // First, create a sources row to query against.
  await c.query("delete from sources");
  const id = "00000000-0000-0000-0000-000000000001";
  await c.query(
    `insert into sources (id, tenant_id, kind, name, description, metadata)
     values ($1, 't', 'audit_project', 's', null, '{}'::jsonb)`,
    [id]
  );

  console.log("--- JS array ---");
  let r = await c.query("select name from sources where id = any($1::uuid[])", [[id]]);
  console.log("rows:", r.rowCount);

  console.log("--- JSON stringified array ---");
  r = await c.query("select name from sources where id = any($1::text[])", [JSON.stringify([id])]);
  console.log("rows:", r.rowCount);

  console.log("--- text[] literal ---");
  r = await c.query("select name from sources where id = any('{00000000-0000-0000-0000-000000000001}'::uuid[])");
  console.log("rows:", r.rowCount);
} finally {
  await c.end();
}
process.exit(0);