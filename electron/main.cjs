// electron/main.js — SAG desktop shell. Spawns the SEA-built
// `SAG-backend.exe` and wraps it in a chromium window.
//
// Architecture
// ------------
// Electron is the GUI shell. On boot it spawns the SEA-built `SAG-backend.exe`
// as a child process. That binary is the existing Fastify HTTP server
// (port 4173 by default). Electron then opens a native window pointing
// at `http://127.0.0.1:4173`. End users get one icon, one taskbar entry,
// one window — no browser involved.
//
// Why child_process, not require(): Electron's node side can't `require`
// a SEA-injected .exe, and even if it could, the server has its own
// Fastify + DB pool lifecycle that must outlive any in-process state.
// Spawning it as a separate OS process gives clean lifecycle semantics:
//   * user closes window  ->  we SIGTERM the child
//   * child crashes        ->  main.js surfaces the error and exits
//   * window opens before  ->  we wait for /health before showing UI
//     child is ready         (avoids "ERR_CONNECTION_REFUSED" flash)
//
// Where the .exe lives
// -------------------
// During development (running via `electron .`), we look for it in
// repo/release/SAG-backend.exe. In a packaged build (`electron-builder`),
// extraResources places it in process.resourcesPath/SAG-backend.exe so the
// app stays self-contained.
//
// Logging
// -------
// Electron GUI process has no console by default (GUI subsystem on
// Windows). We forward child-process stdout/stderr and the main process
// logger to <exe-dir>/logs/desktop-<timestamp>.log so the user can
// inspect them in the same place as the SEA server's logs.

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { createWriteStream, mkdirSync } = require("node:fs");

// Read port from either SAG_HTTP_PORT (preferred, lets you point
// at a non-default backend) or HTTP_PORT (matches the SAG backend's
// own env var name so a `set HTTP_PORT=4174 && start SAG 桌面版.exe`
// workflow works as expected).
const HTTP_PORT = process.env.SAG_HTTP_PORT || process.env.HTTP_PORT || "4173";
// SAG_URL is dynamic: when the backend falls back from 4173 to 4174+,
// Electron needs to follow. The port is read from `effectivePort`
// which is updated by the SAG_BOUND_PORT= parser in the child
// stdout handler. Initial value matches what we'll pass to spawn.
function sagUrl() {
  return `http://127.0.0.1:${getEffectivePort()}`;
}
// First boot after any upgrade forces a full native-cache unpack
// (300+ MB of .node/.dll files copied out of the SEA sidecar, often
// through an AV scan) PLUS the migration run before /health answers.
// Measured on a mid-range Windows box: ~35-50 s end to end. 30 s
// killed the backend mid-unpack, leaving a half-populated cache dir
// and a boot loop. 120 s covers the worst case; the poll loop
// returns early the moment /health answers, so warm boots are
// unaffected.
const READY_TIMEOUT_MS = Number(process.env.SAG_READY_TIMEOUT_MS || 120000);
const READY_POLL_INTERVAL_MS = 250;

// Resolve where to find the backend .exe (SAG-backend.exe).
//   * packaged: process.resourcesPath/SAG-backend.exe (electron-builder default)
//   * dev:      <repo>/release/SAG-backend.exe
function resolveSagBinaryPath() {
  // Packaged build: <resourcesPath>/SAG-backend.exe (we copy it there in
  // scripts/build-desktop-manual.mjs so the runtime doesn't need to
  // know whether we're running in dev or production).
  const packagedCandidate = path.join(process.resourcesPath || "", "SAG-backend.exe");
  if (fs.existsSync(packagedCandidate)) {
    return packagedCandidate;
  }
  // Dev: <repo>/release/SAG-backend.exe (built via npm run build:windows).
  const repoRoot = path.resolve(__dirname, "..", "..");
  const devCandidate = path.join(repoRoot, "release", "SAG-backend.exe");
  if (fs.existsSync(devCandidate)) {
    return devCandidate;
  }
  return null;
}

// Resolve where desktop-shell logs go. Same directory as the SAG exe
// itself so the user has one place to look. If the exe location is
// unknown (very early failure), fall back to <userData>/logs/.
function resolveLogsDir() {
  const sagPath = resolveSagBinaryPath();
  const baseDir = sagPath ? path.dirname(sagPath) : app.getPath("userData");
  const logsDir = path.join(baseDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

const logsDir = resolveLogsDir();
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const logFile = path.join(logsDir, `desktop-${stamp}.log`);
const logStream = createWriteStream(logFile, { flags: "a" });
function logLine(stream, label, msg) {
  const line = `${new Date().toISOString()} ${label} ${msg}\n`;
  stream.write(line);
}

// Global state
let sagProcess = null;
let sagProcessSpawnedByUs = false; // true if we own the child (and must kill it on exit)
let mainWindow = null;
let shuttingDown = false;
// The SAG backend's HTTP server may have fallen back from 4173 to
// 4174..4183 (see src/api/server.ts:226-267) when its preferred port
// was held by an unrelated process. Electron doesn't know about
// the fallback — the backend's only signal to us is a stdout line
// `SAG_BOUND_PORT=<N>` printed right after `app.listen()` succeeds.
// We default to HTTP_PORT (4173) and update the moment we see the
// marker. `waitForBackendReady` and `BrowserWindow.loadURL` both
// read this, so a 4173-occupied case boots the UI on the actual
// chosen port instead of timing out at 120s.
let effectivePort = Number(process.env.SAG_HTTP_PORT || process.env.HTTP_PORT || 4173);
// Kept in module scope rather than as a property hung off the promise:
// `waitForEffectivePort()` can be entered twice before the first call
// finishes assigning `effectivePortPromise`, and the stdout handler
// then tries to write `_resolve` onto a still-null value — which
// surfaced as "Cannot set properties of null (setting '_resolve')"
// and aborted startup even though the backend came up fine.
let effectivePortPromise = null;
let publishEffectivePort = null; // (port) => void, set while the promise is pending
function getEffectivePort() {
  return effectivePort;
}
function waitForEffectivePort(timeoutMs = 30000) {
  if (effectivePortPromise) return effectivePortPromise;
  effectivePortPromise = new Promise((resolve) => {
    const t = setTimeout(() => {
      publishEffectivePort = null;
      logLine(logStream, "[main]", `no SAG_BOUND_PORT marker within ${timeoutMs}ms; assuming default ${effectivePort}`);
      resolve(effectivePort);
    }, timeoutMs);
    publishEffectivePort = (port) => {
      clearTimeout(t);
      publishEffectivePort = null;
      effectivePort = port;
      resolve(port);
    };
  });
  return effectivePortPromise;
}

/**
 * Probe the SAG HTTP port BEFORE we spawn anything. Two scenarios:
 *
 *   (a) Port is closed (ECONNREFUSED)        → spawn SAG.exe ourselves.
 *   (b) Port is open AND /health returns 200 → an existing SAG
 *       backend is already running. Adopt it: don't spawn, don't
 *       kill, just point the window at it. This fixes the "flash
 *       crash" where a previous run was still alive (its SAG.exe
 *       bound 4173); a fresh double-click would have its own child
 *       die with EADDRINUSE within ~100 ms and tear the window
 *       down with it.
 *   (c) Port is open but /health doesn't SAG → something else is
 *       squatting on the port. Refuse to start (avoid clobbering an
 *       unrelated service the user actually wants to keep).
 *
 * Returns the action we should take: "spawn", "reuse", "wedged", or
 * "abort".
 */
async function probeBackendPort() {
  const url = `${sagUrl()}/health`;
  // A single 2 s probe is too fragile: on a busy machine (e.g. an
  // existing backend mid-ingest doing CPU-bound ONNX work) a healthy
  // backend can miss the window, and misreading that as "port free"
  // made us SPAWN A DUPLICATE backend — two ~97-minute ONNX ingest
  // jobs on one box, the new one port-hopping to 4174 while the old
  // one held 4173 (2026-10-28 incident: with the CPU saturated the
  // window's first loadURL then died with ERR_FAILED and the app
  // became an invisible zombie that swallowed every relaunch via the
  // single-instance lock).
  //
  // Distinguish the failure modes:
  //   ECONNREFUSED   → nothing is listening → safe to spawn right away.
  //   timeout / else → SOMETHING is holding the port but not answering
  //                    → retry a few times; if it never answers, call
  //                    it "wedged" and let the caller tell the user to
  //                    kill the stale process — never spawn a duplicate.
  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    logLine(logStream, "[main]", `probe: ${url} (attempt ${attempt}/${ATTEMPTS})`);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        let body = null;
        try {
          body = await r.json();
        } catch {
          /* not JSON — still ok */
        }
        // The SAG /health endpoint returns either `{status:"ok"}` (older)
        // or `{ok:true, sag:{...}}` (newer). Either is fine; the only
        // rejection criterion is a 200 that's not from us. We can't
        // 100% fingerprint the response, but the SAG server always
        // returns JSON. A non-JSON 200 is something else on the port.
        if (body && typeof body === "object") {
          logLine(logStream, "[main]", `probe: reuse existing backend at ${url}`);
          return "reuse";
        }
        logLine(logStream, "[main]", `probe: 200 but non-JSON, treating as foreign`);
        return "abort";
      }
      // 5xx etc — assume foreign
      logLine(logStream, "[main]", `probe: ${url} returned ${r.status}, treating as foreign`);
      return "abort";
    } catch (err) {
      // Node fetch (undici) reports connection failures as
      // `TypeError: fetch failed` with the real reason on err.cause.code;
      // a timeout surfaces as TimeoutError/AbortError instead.
      const code = err && err.cause && err.cause.code;
      if (code === "ECONNREFUSED" || code === "ECONNRESET") {
        logLine(logStream, "[main]", `probe: ${url} refused (${code}) — port free`);
        return "spawn";
      }
      logLine(
        logStream,
        "[main]",
        `probe: ${url} no answer (${err.name || ""}: ${err.message ?? err}) — something is listening but busy`
      );
      if (attempt < ATTEMPTS) {
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
  }
  logLine(logStream, "[main]", `probe: ${url} never answered after ${ATTEMPTS} attempts — wedged`);
  return "wedged";
}

function startSagBackend() {
  const sagPath = resolveSagBinaryPath();
  if (!sagPath) {
    logLine(logStream, "[main]", "FATAL: SAG-backend.exe not found in release/ or resources/");
    dialog.showErrorBox(
      "SAG 启动失败",
      "找不到 SAG-backend.exe。\n\n期望位置：\n  " +
        path.join(process.resourcesPath || "", "SAG-backend.exe") +
        "\n  " +
        path.resolve(__dirname, "..", "release", "SAG-backend.exe") +
        "\n\n请确认 release/ 目录里有 SAG-backend.exe，或重新构建桌面版。"
    );
    app.quit();
    return null;
  }
  logLine(logStream, "[main]", `starting SAG backend: ${sagPath}`);
  logLine(logStream, "[main]", `  cwd: ${path.dirname(sagPath)}`);
  logLine(logStream, "[main]", `  port: ${HTTP_PORT}`);

  // Spawn the SEA-built SAG-backend.exe. We deliberately do NOT pass
  // SAG_OPEN_BROWSER=true because that would launch a browser
  // (defeating the entire point of the desktop shell). The SEA
  // server's GUI-subsystem exe does NOT pop a console, and stdout
  // goes to release/logs/sag-*.log via its own logger auto-detect.
  // We still pipe it here for the desktop log file.
  const env = {
    ...process.env,
    SAG_OPEN_BROWSER: "false",
    SAG_LOG_STDERR: "false", // GUI subsystem; logger auto-routes to file
    HTTP_PORT: HTTP_PORT,
    ALLOW_PROD_WATCHER: process.env.ALLOW_PROD_WATCHER || "false",
    SAG_SKIP_NER_CHECK: process.env.SAG_SKIP_NER_CHECK || "1",
  };
  const child = spawn(sagPath, [], {
    cwd: path.dirname(sagPath),
    env,
    windowsHide: true, // critical: don't let SEA's stderr re-attach a console
    stdio: ["ignore", "pipe", "pipe"],
  });
  sagProcessSpawnedByUs = true;
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    logLine(logStream, "[sag/stdout]", text.trimEnd());
    // Backend publishes its actually-bound port as a parseable
    // stdout line right after app.listen() succeeds. We use this
    // to follow a 4173→4174 fallback instead of polling the wrong
    // port and timing out. The marker is exactly
    //   SAG_BOUND_PORT=<integer>
    // — anything else is left untouched and goes to the log only.
    for (const line of text.split(/\r?\n/)) {
      const m = /^SAG_BOUND_PORT=(\d+)\s*$/.exec(line);
      if (m) {
        const port = Number(m[1]);
        if (Number.isFinite(port) && port > 0 && port < 65536) {
          logLine(logStream, "[main]", `backend reports SAG_BOUND_PORT=${port} (effectivePort was ${effectivePort})`);
          if (typeof publishEffectivePort === "function") {
            publishEffectivePort(port);
          }
        }
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    logLine(logStream, "[sag/stderr]", chunk.toString("utf8").trimEnd());
  });
  child.on("exit", (code, signal) => {
    logLine(logStream, "[sag]", `exit code=${code} signal=${signal}`);
    sagProcess = null;
    sagProcessSpawnedByUs = false;
    if (!shuttingDown) {
      // Backend died while user was using the app — surface the error
      // and close the window so they're not staring at a stale UI.
      dialog.showErrorBox(
        "SAG-backend 已退出",
        `SAG-backend.exe 进程意外终止（code=${code}, signal=${signal}）。\n\n` +
          `日志位置：\n${logsDir}\n\n请查看日志后重新启动。`
      );
      app.quit();
    }
  });
  sagProcess = child;
  return child;
}

async function waitForBackendReady() {
  // Wait for the backend to publish its actual bound port (in case
  // it fell back from 4173 to 4174+). Without this, the first
  // /health fetch below would point at 4173 — the wrong port if
  // the backend is actually on 4174. The 30s marker timeout is
  // a safety net; in practice the marker is published within 100ms
  // of app.listen() succeeding.
  await waitForEffectivePort(30_000);
  const url = sagUrl();
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (sagProcess && sagProcess.exitCode !== null) {
      throw new Error("SAG backend exited before becoming ready");
    }
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        logLine(logStream, "[main]", `backend ready: ${url}/health ${r.status}`);
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((res) => setTimeout(res, READY_POLL_INTERVAL_MS));
  }
  throw new Error(`SAG backend did not become ready within ${READY_TIMEOUT_MS}ms on ${url}`);
}

function createMainWindow() {
  // Window icon — same asset as the desktop exe / in-app logo. The
  // SHELL EXE's icon (visible in Explorer / taskbar / shortcut) is set
  // by electron-packager / electron-builder from scripts/icon.ico at
  // package time, and the SEA-backend exe's icon is set by rcedit
  // from scripts/icosag.ico after build:windows-exe. All three icons
  // come from web/public/favicon.ico so the brand is unified.
  const windowIconPath = path.join(__dirname, "..", "scripts", "icon.ico");
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "SAG 知识库",
    backgroundColor: "#0f172a",
    autoHideMenuBar: true,
    show: false, // show after ready-to-show so no white flash
    icon: fs.existsSync(windowIconPath) ? windowIconPath : undefined,
    webPreferences: {
      // Sandbox the renderer; we don't need Node access in the UI.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  win.removeMenu();

  // Forward renderer console + load failures to the desktop log so
  // we can debug "white screen" reports from the field without
  // asking the user to open DevTools.
  win.webContents.on("console-message", (_event, level, message, line, source) => {
    const lvl = ["DEBUG", "INFO", "WARN", "ERROR"][level] || `L${level}`;
    logLine(logStream, "[renderer/" + lvl + "]", `${source}:${line} ${message}`);
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    logLine(logStream, "[main]", `did-fail-load code=${errorCode} desc="${errorDescription}" url=${validatedURL}`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    logLine(logStream, "[main]", `render-process-gone reason=${details.reason} exit=${details.exitCode}`);
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    logLine(logStream, "[main]", `preload-error path=${preloadPath} error=${error && error.stack || error}`);
  });

  win.once("ready-to-show", () => win.show());
  // loadURL gets multiple chances: right after a cold boot the box can
  // be saturated (backend SEA unpack + AV scanning the freshly
  // extracted tree + an existing ingest run), and Chromium's first
  // navigation can then die with a generic ERR_FAILED even though the
  // backend is healthy. A one-shot failure used to leave an INVISIBLE
  // ZOMBIE app: ready-to-show never fired so the window never
  // appeared, and the single-instance lock turned every subsequent
  // double-click into a no-op — "死活没运行起来" (2026-10-28). Retry a
  // few times, then fail loudly AND quit so the next launch is a real
  // fresh start instead of a handoff to the zombie.
  void loadUrlWithRetry(win);
  win.on("closed", () => {
    mainWindow = null;
  });
  mainWindow = win;
  return win;
}

async function loadUrlWithRetry(win) {
  const ATTEMPTS = 5;
  const RETRY_DELAY_MS = 10_000;
  let lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (win.isDestroyed()) return;
    const url = sagUrl();
    try {
      await win.loadURL(url);
      if (attempt > 1) {
        logLine(logStream, "[main]", `loadURL(${url}) succeeded on attempt ${attempt}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      logLine(logStream, "[main]", `failed to loadURL(${url}) attempt ${attempt}/${ATTEMPTS}: ${err}`);
      if (attempt < ATTEMPTS) {
        await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
      }
    }
  }
  const url = sagUrl();
  dialog.showErrorBox(
    "无法加载 SAG 界面",
    `后端已就绪但 Electron 窗口多次加载失败：${lastErr && lastErr.message}\n\n` +
      `可以先用浏览器打开 ${url} 验证后端是否正常。\n\n请查看日志：\n${logFile}`
  );
  // Quit instead of lingering windowless while holding the
  // single-instance lock. before-quit kills our spawned backend
  // child, so the next double-click gets a genuinely fresh start.
  app.quit();
}

// IPC handlers exposed to the renderer via preload.js.
// These let the UI open the logs folder, restart the backend, etc.
// without giving the renderer direct Node access.
ipcMain.handle("sag:get-logs-dir", () => logsDir);
ipcMain.handle("sag:open-logs-dir", async () => {
  await shell.openPath(logsDir);
  return logsDir;
});
ipcMain.handle("sag:open-data-dir", async () => {
  const sagPath = resolveSagBinaryPath();
  const dir = sagPath ? path.dirname(sagPath) : app.getPath("userData");
  await shell.openPath(dir);
  return dir;
});
ipcMain.handle("sag:restart-backend", async () => {
  if (sagProcess) {
    logLine(logStream, "[main]", "restart requested: killing child");
    sagProcess.kill();
    sagProcess = null;
  }
  startSagBackend();
  await waitForBackendReady();
  if (mainWindow) mainWindow.reload();
  return { ok: true };
});
ipcMain.handle("sag:get-version", () => app.getVersion());

// Single-instance lock so launching SAG.exe twice just
// focuses the existing window instead of opening a duplicate.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // First: check if a SAG backend is already running on our port.
    // If yes, ADOPT it — don't spawn a second SAG-backend.exe (it would fail
    // to bind the port and exit immediately, which used to manifest
    // as "open the app → flash → gone"). The pre-existing backend
    // could be:
    //   - a previous SAG.exe run the user forgot to close
    //   - a standalone SAG-backend.exe they launched directly from a shell
    //   - a system service wrapper (future)
    // In all three cases the right behaviour is: open the window,
    // point it at the running port, leave the existing process
    // alone. Only on full Electron exit do we kill OUR child (and
    // only if we spawned it).
    const probe = await probeBackendPort();
    if (probe === "abort") {
      logLine(logStream, "[main]", `port ${HTTP_PORT} is held by something that isn't SAG`);
      dialog.showErrorBox(
        "端口被占用",
        `端口 ${HTTP_PORT} 已被其他进程占用，但响应不像 SAG-backend。\n\n` +
          `请关闭占用该端口的程序后重新启动 SAG。\n\n` +
          `日志：${logFile}`
      );
      app.quit();
      return;
    }
    if (probe === "wedged") {
      // Something holds the port but won't answer /health. Usually a
      // leftover SAG-backend.exe whose event loop is wedged, or an old
      // version still busy with a long ingest. Spawning anyway would
      // make the new backend port-hop and run TWO CPU-heavy instances
      // at once — the exact mess we refuse to repeat.
      logLine(logStream, "[main]", `port ${HTTP_PORT} is wedged (listening but not answering)`);
      dialog.showErrorBox(
        "端口被占用且无响应",
        `端口 ${HTTP_PORT} 上有进程在监听，但多次探测 /health 都没有回应。\n\n` +
          `通常是还残留着一个旧的 SAG-backend.exe（可能正在跑大批量入库）。\n` +
          `请在任务管理器里结束所有 SAG-backend.exe 后重新启动；\n` +
          `如果你知道那是正在运行的旧版本，也可以等它闲下来再试。\n\n` +
          `日志：${logFile}`
      );
      app.quit();
      return;
    }
    if (probe === "spawn") {
      startSagBackend();
      try {
        await waitForBackendReady();
      } catch (err) {
        logLine(logStream, "[main]", `backend failed to become ready: ${err.message}`);
        dialog.showErrorBox(
          "SAG-backend 未就绪",
          `等待 SAG-backend.exe 就绪超时（${READY_TIMEOUT_MS}ms）。\n\n` +
            `可能原因：端口 ${HTTP_PORT} 附近被其他进程占用，或后端启动报错。\n` +
            `（后端在 ${HTTP_PORT}~${Number(HTTP_PORT) + 10} 范围内会自动选可用端口；` +
            `如果全部被占，后端会启动失败。）\n\n` +
            `日志：\n${logFile}`
        );
        app.quit();
        return;
      }
    } else {
      // probe === "reuse" — sagProcess stays null, sagProcessSpawnedByUs false.
      // We do NOT kill the existing backend on exit either; that's the
      // user's process to manage.
      logLine(logStream, "[main]", `reusing existing backend at ${sagUrl()}`);
    }
    createMainWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on("before-quit", () => {
    shuttingDown = true;
    // Only kill the SAG child if WE spawned it. If we adopted an
    // existing backend (a previous SAG run still alive, a standalone
    // SAG-backend.exe the user started from a shell, etc.) — leave it
    // alone. That process belongs to the user; we have no way to
    // know if they want it kept running for a different consumer.
    if (sagProcess && sagProcessSpawnedByUs) {
      logLine(logStream, "[main]", "before-quit: killing SAG child we spawned");
      try {
        sagProcess.kill();
      } catch (e) {
        logLine(logStream, "[main]", `failed to kill child: ${e}`);
      }
    } else if (sagProcessSpawnedByUs === false) {
      logLine(logStream, "[main]", "before-quit: leaving external SAG-backend.exe running (we did not spawn it)");
    }
    try {
      logStream.end();
    } catch {}
  });

  app.on("window-all-closed", () => {
    // On all platforms (including macOS), close the app when the
    // user closes the window. The desktop shell is a single-window
    // tool, not a doc-style app.
    app.quit();
  });
}