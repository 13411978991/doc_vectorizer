"use strict";
// Reproduce EXACTLY how electron/main.cjs spawns the backend, to
// find why Electron-spawned boots hang while manual boots don't.
const { spawn } = require("child_process");
const path = require("path");

const RES = "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources";
const sagPath = path.join(RES, "本地知识检索-后端.exe");
const HTTP_PORT = "4173";

const env = {
  ...process.env,
  SAG_OPEN_BROWSER: "false",
  SAG_LOG_STDERR: "false",
  HTTP_PORT: HTTP_PORT,
  ALLOW_PROD_WATCHER: process.env.ALLOW_PROD_WATCHER || "false",
  SAG_SKIP_NER_CHECK: process.env.SAG_SKIP_NER_CHECK || "1",
};

console.log("spawning:", sagPath);
const t0 = Date.now();
const child = spawn(sagPath, [], {
  cwd: path.dirname(sagPath),
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (c) => console.log(`[+${((Date.now()-t0)/1000).toFixed(1)}s stdout]`, c.toString("utf8").trimEnd().slice(0, 300)));
child.stderr.on("data", (c) => console.log(`[+${((Date.now()-t0)/1000).toFixed(1)}s stderr]`, c.toString("utf8").trimEnd().slice(0, 300)));
child.on("exit", (code, signal) => { console.log("EXIT", code, signal); process.exit(1); });

// Poll health like electron does
const http = require("http");
const poll = setInterval(() => {
  const req = http.get(`http://127.0.0.1:${HTTP_PORT}/health`, { timeout: 2000 }, (res) => {
    console.log(`[+${((Date.now()-t0)/1000).toFixed(1)}s] HEALTH ${res.statusCode}`);
    clearInterval(poll);
    child.kill();
    process.exit(0);
  });
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
}, 1000);

setTimeout(() => {
  console.log(`[+${((Date.now()-t0)/1000).toFixed(1)}s] TIMEOUT — killing child (pid ${child.pid})`);
  console.log("child CPU info:", JSON.stringify(process.cpuUsage()));
  child.kill();
  process.exit(2);
}, 90000);
