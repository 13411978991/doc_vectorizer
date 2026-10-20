/**
 * office-orphan-sweeper.ts
 *
 * P19 — sweep stale Office processes at startup. After a week of
 * failed DLP-encrypted extracts the audit box has 3× et.exe + 2×
 * WINWORD.exe + several wps.exe lingering, each holding ~50–300 MB
 * of working set. They consume CPU when the OS wakes them for
 * whatever reason and they hold file locks that block re-extract.
 *
 * The sweep runs at every boot:
 *   - WINWORD.exe (Microsoft Word)
 *   - EXCEL.EXE  (Microsoft Excel)
 *   - POWERPNT.EXE (Microsoft PowerPoint)
 *   - et.exe (WPS Spreadsheet)
 *   - wps.exe (WPS Writer)
 *   - wpp.exe (WPS Presentation)
 *
 * Only processes that have been alive for at least `olderThanMs`
 * (default 60s) are killed — this avoids killing the user's
 * interactive Office instance on a fresh boot when their document
 * happens to be open. We never kill any process whose PID exceeds
 * `excludePids` (the bootstrap PID of this process and any spawned
 * children).
 *
 * The implementation mirrors `com-decrypt.ts::killOrphanedExcel` but
 * covers all the COM-process shapes the audit env sees. tasklist /
 * taskkill with a hard 5s timeout, same as the COM helper, to avoid
 * hanging the boot on a stuck wmic / scanner.
 */
import { spawn } from "node:child_process";
import { logger } from "../observability/logger.js";

const TARGETS = [
  "WINWORD.EXE",
  "EXCEL.EXE",
  "POWERPNT.EXE",
  "et.exe",
  "wps.exe",
  "wpp.exe"
];

export async function killOrphanedOfficeProcesses(input: {
  olderThanMs?: number;
  excludePids?: number[];
} = {}): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const olderThanMs = input.olderThanMs ?? 60_000;
  const excludePids = new Set(input.excludePids ?? [process.pid]);
  const killed: string[] = [];

  // tasklist /NH /FO CSV dumps every process with PID + start time.
  // Filter by NAME and START-AGE in JS to avoid spawning one
  // taskkill per candidate process (cheap, but unnecessary churn).
  const csv = await runTasklistCSV();
  if (!csv) return killed;
  const now = Date.now();
  const oldPids: { name: string; pid: number }[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"[^,]*,[^,]*,\s*"([^"]+)"/.exec(line);
    if (!m) continue;
    const name = m[1].toUpperCase();
    const pid = parseInt(m[2], 10);
    if (!TARGETS.includes(name) && !TARGETS.includes(m[1])) continue;
    if (excludePids.has(pid)) continue;
    // m[3] is start time e.g. "9-17-2025 08:34:12 AM"
    const started = parseWindowsStartTime(m[3]);
    if (!started) continue;
    const ageMs = now - started;
    if (ageMs < olderThanMs) continue;
    oldPids.push({ name, pid });
  }

  if (oldPids.length === 0) return killed;
  const args = ["/F"];
  for (const p of oldPids) args.push("/PID", String(p.pid));
  args.push("/T");
  try {
    await runTaskkill(args);
    for (const p of oldPids) killed.push(`${p.name}#${p.pid}`);
    logger.info({ killed, count: killed.length }, "office-orphan-sweeper: reaped orphans");
  } catch (error) {
    logger.warn({ error: (error as Error).message }, "office-orphan-sweeper: taskkill failed");
  }
  return killed;
}

function runTasklistCSV(): Promise<string | null> {
  return new Promise((resolve) => {
    const hard = setTimeout(() => resolve(null), 5_000);
    try {
      hard.unref?.();
    } catch {
      // ignore
    }
    const child = spawn("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true });
    let body = "";
    child.stdout.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    child.on("close", () => {
      clearTimeout(hard);
      resolve(body || null);
    });
    child.on("error", () => {
      clearTimeout(hard);
      resolve(null);
    });
  });
}

function runTaskkill(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const hard = setTimeout(() => resolve(), 10_000);
    try {
      hard.unref?.();
    } catch {
      // ignore
    }
    const child = spawn("taskkill", args, { windowsHide: true });
    child.on("close", () => {
      clearTimeout(hard);
      resolve();
    });
    child.on("error", (err) => {
      clearTimeout(hard);
      reject(err);
    });
  });
}

/**
 * Parse a "M-DD-YYYY HH:MM:SS AM/PM" string from tasklist CSV into
 * a millisecond epoch. Returns null on parse failure (we skip the
 * process rather than risk killing a brand-new one).
 */
function parseWindowsStartTime(s: string): number | null {
  // Try the locale-specific "M/D/YYYY HH:MM:SS AM/PM" form first.
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i.exec(s.trim());
  if (!m) return null;
  let [, mo, da, ye, hh, mm, ss, ampm] = m;
  let h = parseInt(hh, 10);
  if (ampm) {
    if (ampm.toUpperCase() === "PM" && h < 12) h += 12;
    if (ampm.toUpperCase() === "AM" && h === 12) h = 0;
  }
  return new Date(+ye, +mo - 1, +da, h, +mm, +ss).getTime();
}
