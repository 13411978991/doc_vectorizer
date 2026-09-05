// Wipe and rebuild chunk_vec0 / entity_vec0 / event_title_vec0 / event_content_vec0
// to use FLOAT[4096] for qwen3-embedding-8b.
//
// We must DROP and recreate vec0 virtual tables; you can't ALTER their columns.
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const dbPath = process.env.DATABASE_FILE ?? "E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db";
const db = new Database(dbPath);
sqliteVec.load(db);

console.log("Dropping old FLOAT[1024] vec0 tables...");
db.exec("drop table if exists chunk_vec0;");
db.exec("drop table if exists entity_vec0;");
db.exec("drop table if exists event_title_vec0;");
db.exec("drop table if exists event_content_vec0;");

console.log("Creating FLOAT[4096] vec0 tables...");
db.exec("create virtual table chunk_vec0 using vec0(chunk_id text primary key, embedding float[4096]);");
db.exec("create virtual table entity_vec0 using vec0(entity_id text primary key, embedding float[4096]);");
db.exec("create virtual table event_title_vec0 using vec0(event_id text primary key, embedding float[4096]);");
db.exec("create virtual table event_content_vec0 using vec0(event_id text primary key, embedding float[4096]);");

console.log("Done. Schema: vec0 = float[4096]");
db.close();