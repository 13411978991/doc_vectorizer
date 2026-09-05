// Probe pg-node array binding behavior.
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
  console.log("--- array of strings as JS ---");
  let r = await c.query("SELECT $1::jsonb AS x", [['a','b','c']]);
  console.log(JSON.stringify(r.rows));
  console.log("--- string '[\"a\",\"b\"]' ---");
  r = await c.query("SELECT $1::jsonb AS x", ['["a","b","c"]']);
  console.log(JSON.stringify(r.rows));
  console.log("--- json_each on string ---");
  r = await c.query("SELECT * FROM json_each($1::jsonb)", ['["a","b","c"]']);
  console.log(JSON.stringify(r.rows));
} finally {
  await c.end();
}
process.exit(0);