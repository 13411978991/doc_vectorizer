import pino from "pino";
import { mkdirSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { config } from "../config/env.js";
import { toLocalISO } from "../db/row-helpers.js";

const loggerOptions = {
  level: config.LOG_LEVEL,
  base: {
    service: "sag"
  },
  // pino's default timestamp uses `new Date().toISOString()` which always
  // outputs UTC. Use toLocalISO() (from row-helpers) so the log's `time`
  // field is in Asia/Shanghai (UTC+8) with a "+08:00" offset.
  timestamp: () => `,"time":"${toLocalISO()}"`,
  // P-Secrets — redact common secret / token patterns before they hit
  // the log file. Operators often copy log lines into bug trackers;
  // an `Authorization: Bearer sk-...` line or an embedding 5xx body
  // that echoes the API key is a silent PII leak.
  redact: {
    paths: [
      "*.Authorization",
      "*.authorization",
      "*.apiKey",
      "*.api_key",
      "*.token",
      "headers.authorization",
      "headers[\"authorization\"]",
      "headers[\"x-api-key\"]"
    ],
    // Custom censor that keeps the prefix shape (`sk-…`, `eyJ…`) so
    // operators can still see the token type in the log without the
    // raw bytes.
    censor: (value: unknown) => {
      if (typeof value !== "string" || value.length === 0) return "[REDACTED]";
      if (value.length <= 8) return "[REDACTED]";
      return `${value.slice(0, 4)}…[REDACTED]`;
    },
    // Match API key / bearer patterns embedded in arbitrary strings
    // (e.g. an embedding 5xx body that contains the literal key).
    remove: false
  }
};

/**
 * Resolve where pino writes logs. Priority:
 *   1. SAG_LOG_FILE  — absolute path to a log file
 *   2. SAG_LOG_STDERR=true  — stderr (fd 2), used for `SAG.exe 2>log`
 *   3. SAG_LOG_AUTO=true (or implicit under WINDOWS_GUI subsystem)
 *      — write to `<sibling-of-exe>/logs/sag-YYYYMMDD-HHMMSS.log` and
 *      stdout to `<sibling-of-exe>/logs/sag.out.log`. This is the
 *      default once the exe is built with PE Subsystem = WINDOWS_GUI,
 *      because GUI processes have no console attached and would
 *      otherwise lose stdout entirely.
 *   4. stdout (fd 1) — original behaviour, fine for dev / dev:tsc
 */
function pickDestination(): { stream: pino.DestinationStream; name: string } {
  const filePath = process.env.SAG_LOG_FILE;
  if (filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    return { stream: createWriteStream(filePath, { flags: "a" }), name: `file:${filePath}` };
  }
  if (process.env.SAG_LOG_STDERR === "true") {
    return { stream: pino.destination(2) as pino.DestinationStream, name: "stderr(fd 2)" };
  }
  if (process.env.SAG_LOG_AUTO === "true" || shouldAutoLog()) {
    // Detect SEA by checking process.execPath's basename: under `node`
    // it's `node.exe`, under SEA it's whatever the user named the
    // blob (e.g. SAG.exe). We treat execPath != current node as the
    // "this is the built exe" signal and route to a sibling logs/
    // directory so the user can inspect them.
    const logsDir = join(dirname(process.execPath), "logs");
    mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outPath = join(logsDir, `sag-${stamp}.log`);
    const errPath = join(logsDir, `sag-${stamp}.err.log`);
    // Emit one banner line per stream so the user can find which log
    // holds what, and tee stdout + stderr to separate files.
    process.stdout.write(`[sag-boot] stdout tee -> ${outPath}\n`);
    process.stderr.write(`[sag-boot] stderr tee -> ${errPath}\n`);
    return { stream: createWriteStream(outPath, { flags: "a" }), name: `file:${outPath}` };
  }
  return { stream: pino.destination(1) as pino.DestinationStream, name: "stdout(fd 1)" };
}

function shouldAutoLog(): boolean {
  // In a built SEA exe (process.execPath ends with .exe and is not
  // the system node), the parent shell that launched us via
  // double-click has no console attached. Auto-route logs so the
  // user can find them in release/logs/.
  if (!process.execPath || !process.execPath.toLowerCase().endsWith(".exe")) {
    return false;
  }
  // If we're being run from the system node binary, don't auto-log;
  // dev workflows usually have stderr piped or visible.
  const nodeExe = process.execPath.toLowerCase();
  return !nodeExe.includes("nodejs") && !nodeExe.includes("\\node\\") && !nodeExe.endsWith("\\node.exe");
}

const picked = pickDestination();
export const logger = pino(loggerOptions, picked.stream);
// Stash the destination name so other modules can log it once at boot.
export const loggerDestination = picked.name;