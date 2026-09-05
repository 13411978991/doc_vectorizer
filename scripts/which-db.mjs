import Database from "better-sqlite3";
import * as fs from "node:fs";

// Check EXE's db by file size and path
const exeDb = "E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db";
console.log("EXE db size:", fs.statSync(exeDb).size);

const db = new Database(exeDb, { readonly: true });
const r = db.prepare("SELECT tenant_id, COUNT(*) as cnt FROM sources GROUP BY tenant_id").all();
console.log("EXE db tenants:");
for (const x of r) console.log("  -", x.tenant_id, x.cnt);
db.close();

// dev db
const devDb = "E:\\sag\\export\\data\\sag.db";
console.log("dev db size:", fs.statSync(devDb).size);
const db2 = new Database(devDb, { readonly: true });
const r2 = db2.prepare("SELECT tenant_id, COUNT(*) as cnt FROM sources GROUP BY tenant_id").all();
console.log("dev db tenants:");
for (const x of r2) console.log("  -", x.tenant_id, x.cnt);
db2.close();