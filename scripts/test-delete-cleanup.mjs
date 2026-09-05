// Full flow: create folder → sync → check counts → delete folder → re-check.
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import Database from "better-sqlite3";
import path from "node:path";

const BASE = "http://127.0.0.1:4173";
const TEST_DIR = "E:\\sag\\test\\delete-test-" + Date.now();
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");

async function api(method, url, body) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
  return r.json();
}

function countBySources(table, sourceIds) {
  if (sourceIds.length === 0) return 0;
  // Build a comma-separated list of quoted ids for an IN clause.
  const placeholders = sourceIds.map(() => "?").join(",");
  const stmt = db.prepare(`SELECT count(*) as n FROM ${table} WHERE source_id IN (${placeholders})`);
  return stmt.get(...sourceIds).n;
}

async function main() {
  await fsp.mkdir(TEST_DIR, { recursive: true });
  await fsp.writeFile(path.join(TEST_DIR, "doc1.md"), "# Test 1\n\nThis is test content for delete-folder test.");
  await fsp.writeFile(path.join(TEST_DIR, "doc2.md"), "# Test 2\n\nMore test content.");

  const created = await api("POST", "/api/watched-folders", {
    path: TEST_DIR, displayName: "delete-test", recursive: false
  });
  const folderId = created.folder.id;
  console.log(`created folder ${folderId}`);

  await api("POST", `/api/watched-folders/${folderId}/sync`, {});
  await new Promise((r) => setTimeout(r, 8000));

  const wf = db.prepare("SELECT source_id, json_extract(metadata, '$.formerSourceId') as former FROM watched_folders WHERE id = ?").get(folderId);
  const sources = [...new Set([wf?.source_id, wf?.former].filter(Boolean))];
  console.log(`\nsources: ${sources.map(s => s.slice(0,8)).join(",")}`);
  console.log("=== AFTER sync ===");
  console.log("  documents:", countBySources("documents", sources));
  console.log("  chunks:   ", countBySources("chunks", sources));
  console.log("  events:   ", countBySources("events", sources));
  console.log("  entities: ", countBySources("entities", sources));

  console.log("\n=== DELETE folder ===");
  const dr = await api("DELETE", `/api/watched-folders/${folderId}`);
  console.log(`result:`, dr);

  console.log("\n=== AFTER delete ===");
  console.log("  watched_folders:", db.prepare("SELECT count(*) as n FROM watched_folders WHERE id = ?").get(folderId).n);
  if (sources.length) {
    console.log("  sources:   ", countBySources("sources", sources));
    console.log("  documents: ", countBySources("documents", sources));
    console.log("  chunks:    ", countBySources("chunks", sources));
    console.log("  events:    ", countBySources("events", sources));
    console.log("  entities:  ", countBySources("entities", sources));
  }
  db.close();
  await fsp.rm(TEST_DIR, { recursive: true, force: true });
}

main().catch(e => { console.error(e); db.close(); process.exit(1); });