"use strict";
const fs = require("fs");
const path = require("path");

const entry = `"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

function unpackOnce() {
  const exeDir = path.dirname(process.execPath);
  const exeBase = path.basename(process.execPath, ".exe");
  const manifestPath = path.join(exeDir, exeBase + ".native-map.manifest.json");
  const sourceCacheDir = path.join(exeDir, "native-cache");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      exeBase + ".native-map.manifest.json is missing next to " + path.basename(process.execPath) + " " +
      "(and native-cache/ dir is also expected next to the exe). " +
      "Expected at: " + manifestPath,
    );
  }
  if (!fs.existsSync(sourceCacheDir)) {
    throw new Error(
      "native-cache/ dir is missing next to " + path.basename(process.execPath) + ". " +
      "Expected at: " + sourceCacheDir,
    );
  }
  const manifestJson = fs.readFileSync(manifestPath, "utf8");
  const MANIFEST = JSON.parse(manifestJson);
  const sig = crypto
    .createHash("sha256")
    .update(manifestJson)
    .digest("hex")
    .slice(0, 12);
  let baseDir;
  const envOverride = process.env.SAG_NATIVE_CACHE_DIR;
  const candidates = [];
  if (envOverride) candidates.push(path.join(envOverride, "sag-sea-native-" + sig));
  candidates.push(path.join(exeDir, "native-cache", sig));
  candidates.push(path.join(os.tmpdir(), "sag-sea-native-" + sig));
  for (const c of candidates) {
    try {
      fs.mkdirSync(c, { recursive: true });
      const probe = path.join(c, ".sag-write-probe");
      fs.writeFileSync(probe, "1");
      fs.unlinkSync(probe);
      baseDir = c;
      break;
    } catch (err) {
      // Try the next candidate.
    }
  }
  if (!baseDir) {
    throw new Error(
      "could not find a writable native-cache directory. Tried: " +
        candidates.join(", ") +
        ". Set SAG_NATIVE_CACHE_DIR to override."
    );
  }
  const nodeModulesDir = path.join(baseDir, "node_modules");
  const bundleDir = path.join(baseDir, "__bundle__");
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  fs.mkdirSync(bundleDir, { recursive: true });
  for (const [pkg, files] of Object.entries(MANIFEST.packages || {})) {
    const pkgDir = path.join(nodeModulesDir, pkg);
    fs.mkdirSync(pkgDir, { recursive: true });
    for (const [rel, cachedRel] of Object.entries(files)) {
      const out = path.join(pkgDir, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      if (fs.existsSync(out)) continue;
      const src = path.join(sourceCacheDir, pkg, cachedRel);
      try {
        fs.copyFileSync(src, out);
      } catch (err) {
        throw new Error(
          "failed to copy " + src + " -> " + out + ": " + err.message +
          " (This usually means Windows AV or SmartScreen is locking the .node/.dll file. " +
          "Add the native-cache/ dir to your AV exclusion list and try again.)"
        );
      }
    }
    if (!fs.existsSync(path.join(pkgDir, "package.json"))) {
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: pkg, version: "0.0.0", main: "index.js", type: "commonjs" }, null, 2),
      );
    }
  }
  if (MANIFEST.__bundle__) {
    const bundleSrc = path.join(sourceCacheDir, MANIFEST.__bundle__);
    const bundleDst = path.join(bundleDir, "sag.bundle.cjs");
    try {
      fs.copyFileSync(bundleSrc, bundleDst);
    } catch (err) {
      throw new Error(
        "failed to refresh __bundle__/sag.bundle.cjs: " + err.message +
        " (This usually means Windows AV is locking the file. " +
        "Add the native-cache/ dir to your AV exclusion list.)"
      );
    }
  }
  // The embedding worker is a separate bundle: it runs in a
  // worker_thread and must be loadable as a FILE next to the main
  // bundle, not as a package inside node_modules. Copy it into the
  // per-machine cache so the runtime can spawn it from a stable path.
  if (MANIFEST.__embeddingWorker__) {
    const workerSrc = path.join(sourceCacheDir, MANIFEST.__embeddingWorker__);
    const workerDst = path.join(bundleDir, "sag.embedding-worker.cjs");
    try {
      fs.copyFileSync(workerSrc, workerDst);
    } catch (err) {
      throw new Error(
        "failed to refresh __bundle__/sag.embedding-worker.cjs: " + err.message +
        " (This usually means Windows AV is locking the file. " +
        "Add the native-cache/ dir to your AV exclusion list.)"
      );
    }
  }
  // Same for the DB-write worker: it is spawned as a child process
  // and the pool resolves it from <base>/__bundle__/. Without this
  // copy the pool can only look for the dev-mode .ts source, so in a
  // packaged build every document write fell back to the main thread
  // (2026-10-29: "db-write-worker entry not found" per document).
  if (MANIFEST.__dbWriteWorker__) {
    const dbWriteSrc = path.join(sourceCacheDir, MANIFEST.__dbWriteWorker__);
    const dbWriteDst = path.join(bundleDir, "sag.db-write-worker.cjs");
    try {
      fs.copyFileSync(dbWriteSrc, dbWriteDst);
    } catch (err) {
      throw new Error(
        "failed to refresh __bundle__/sag.db-write-worker.cjs: " + err.message +
        " (This usually means Windows AV is locking the file. " +
        "Add the native-cache/ dir to your AV exclusion list.)"
      );
    }
  }
  return baseDir;
}

const NATIVE_DIR = unpackOnce();

if (typeof globalThis.DOMMatrix === "undefined") {
  class DOMMatrix {
    constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
    multiplySelf() { return this; }
    preMultiplySelf() { return this; }
    translate() { return this; }
    scale() { return this; }
    invertSelf() { return this; }
  }
  globalThis.DOMMatrix = DOMMatrix;
}
if (typeof globalThis.Path2D === "undefined") {
  globalThis.Path2D = class Path2D {};
}

const Module = require("module");

(function setupLogTees() {
  const EXE_DIR_LOGS = path.dirname(process.execPath);
  const outLogPath = path.join(EXE_DIR_LOGS, "sd-out.log");
  const errLogPath = path.join(EXE_DIR_LOGS, "sd-err.log");
  try {
    const isRedirected = (fd) => {
      try {
        const s = fs.fstatSync(fd);
        return s.isFile();
      } catch {
        return false;
      }
    };
    if (!isRedirected(1)) {
      const outFd = fs.openSync(outLogPath, "a");
      const origStdoutWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...rest) => {
        try { fs.writeSync(outFd, chunk); } catch {}
        return origStdoutWrite(chunk, ...rest);
      };
      try {
        origStdoutWrite(
          "[sag-boot] stdout tee -> " + outLogPath + " (pid=" + process.pid + ")" + String.fromCharCode(10)
        );
      } catch {}
    }
    if (!isRedirected(2)) {
      const errFd = fs.openSync(errLogPath, "a");
      const origStderrWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk, ...rest) => {
        try { fs.writeSync(errFd, chunk); } catch {}
        return origStderrWrite(chunk, ...rest);
      };
      try {
        process.stderr.write(
          "[sag-boot] stderr tee -> " + errLogPath + " (pid=" + process.pid + ")" + String.fromCharCode(10)
        );
      } catch {}
    }
  } catch (err) {
    try {
      process.stdout.write(
        "[sag-boot] log tee setup failed: " + err.message + String.fromCharCode(10)
      );
    } catch {}
  }
})();

const SCRIPTS_DIR = path.join(unpackOnce(), "scripts");
fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
{
  const EXE_BASE_FOR_SCRIPTS = path.basename(process.execPath, ".exe");
  const scriptsMapPath = path.join(path.dirname(process.execPath), EXE_BASE_FOR_SCRIPTS + ".scripts.json");
  if (!fs.existsSync(scriptsMapPath)) {
    throw new Error(
      EXE_BASE_FOR_SCRIPTS + ".scripts.json is missing next to " + path.basename(process.execPath) + "." + String.fromCharCode(10) +
      "Expected at: " + scriptsMapPath
    );
  }
  const scriptsJson = fs.readFileSync(scriptsMapPath, "utf8");
  const scriptsMap = JSON.parse(scriptsJson);
  for (const [name, b64] of Object.entries(scriptsMap)) {
    const out = path.join(SCRIPTS_DIR, name);
    if (fs.existsSync(out)) continue;
    fs.writeFileSync(out, Buffer.from(b64, "base64"));
  }
}
process.env.SAG_SCRIPTS_DIR = SCRIPTS_DIR;
globalThis.SAG_SCRIPTS_DIR = SCRIPTS_DIR;
try {
  require("fs").writeFileSync(
    path.join(path.dirname(process.execPath), "sd-scripts-dir.txt"),
    SCRIPTS_DIR + String.fromCharCode(10),
    "utf8"
  );
} catch (err) {
  try { process.stderr.write("[sag-boot] sd-scripts-dir.txt write failed: " + err.message + String.fromCharCode(10)); } catch {}
}

const EXE_DIR = path.dirname(process.execPath);
const EXE_BASE = path.basename(process.execPath, ".exe");
const MIGRATIONS_DIR = path.join(EXE_DIR, "migrations");
const migrationsMapPath = path.join(EXE_DIR, EXE_BASE + ".migrations.json");
if (!fs.existsSync(migrationsMapPath)) {
  throw new Error(
    EXE_BASE + ".migrations.json is missing next to " + path.basename(process.execPath) + "." + String.fromCharCode(10) +
    "Expected at: " + migrationsMapPath,
  );
}
fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
const migrationsJson = fs.readFileSync(migrationsMapPath, "utf8");
const migrationsMap = JSON.parse(migrationsJson);
for (const [name, b64] of Object.entries(migrationsMap)) {
  fs.writeFileSync(path.join(MIGRATIONS_DIR, name), Buffer.from(b64, "base64"));
}
process.env.MIGRATIONS_DIR = MIGRATIONS_DIR;
process.env.SAG_NATIVE_CACHE_DIR = NATIVE_DIR;

const BUNDLE_PATH = path.join(NATIVE_DIR, "__bundle__", "sag.bundle.cjs");
const bundleSource = fs.readFileSync(BUNDLE_PATH, "utf8");

const bundleModule = new Module(BUNDLE_PATH, module);
bundleModule.filename = BUNDLE_PATH;
bundleModule.paths = [path.join(NATIVE_DIR, "node_modules")];
Module._cache[bundleModule.filename] = bundleModule;

bundleModule._compile(bundleSource, BUNDLE_PATH);
if (typeof bundleModule.exports === "function") module.exports = bundleModule.exports;
`;

const outPath = path.join(__dirname, "..", "dist", "sag.entry.cjs");
fs.writeFileSync(outPath, entry);
console.log("Written: " + outPath + " (" + fs.statSync(outPath).size + " bytes)");
