// Snapshot current DB state: stuck sync runs, count of EXCEL-like orphans
// in the process list, recent ingest failures, busy timeout.
import Database from "better-sqlite3";
import { execSync } from "node:child_process";

const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });

console.log("=== stuck sync runs ===");
try {
  const runs = db.prepare(`
    SELECT id, watched_folder_id, trigger_kind, status, started_at
    FROM watched_folder_runs
    WHERE status = 'running'
    ORDER BY started_at DESC
  `).all();
  console.log(`count: ${runs.length}`);
  for (const r of runs.slice(0, 10)) {
    console.log(`  ${r.id.slice(0,8)} folder=${r.watched_folder_id.slice(0,8)} trigger=${r.trigger_kind} started=${r.started_at}`);
  }
} catch (e) {
  console.log("(table not found or schema different)");
}

console.log("\n=== recent ingest errors ===");
try {
  const errs = db.prepare(`
    SELECT folder_id, rel_path, last_error, last_status, updated_at
    FROM watched_folder_manifests
    WHERE last_status = 'failed' AND updated_at > datetime('now', '-1 day')
    ORDER BY updated_at DESC LIMIT 10
  `).all();
  for (const r of errs) {
    console.log(`  ${r.folder_id.slice(0,8)} ${r.rel_path} - ${(r.last_error || "").slice(0, 60)}`);
  }
} catch (e) {
  console.log("(manifest table different)");
}

console.log("\n=== sqlite config ===");
console.log("journal_mode:", db.prepare("PRAGMA journal_mode").get());
console.log("busy_timeout:", db.prepare("PRAGMA busy_timeout").get());

console.log("\n=== process snapshot ===");
try {
  const procs = execSync('powershell -NoProfile -Command "Get-Process excel,powershell,黑洞 -ErrorAction SilentlyContinue | Select-Object Name, Id, StartTime | Format-Table -AutoSize"').toString();
  console.log(procs);
} catch (e) { console.log("proc lookup failed"); }
db.close();