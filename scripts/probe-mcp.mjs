import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

const env = {
  ...process.env,
  DEFAULT_TENANT_ID: "default",
  SAG_MCP_SOURCE_ID: "d65db8c0-a432-43e9-8262-2e52895f5764",
  DATABASE_FILE: "E:\\sag\\export\\data\\sag.db",
  SAG_API_URL: "http://127.0.0.1:4173"
};

const proc = spawn(
  "E:\\sag\\dist\\builds\\sag-20260813-171645\\黑洞-mcp.exe",
  [], { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true }
);

let out = "", err = "";
proc.stdout.on("data", (c) => out += c.toString());
proc.stderr.on("data", (c) => err += c.toString());
proc.on("exit", (code) => console.log("EXIT code=" + code));

proc.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {},
            clientInfo: { name: "probe", version: "0.1" } }
}) + "\n");
await wait(2500);

proc.stdin.write(JSON.stringify({
  jsonrpc: "2.0", method: "notifications/initialized"
}) + "\n");
await wait(500);

proc.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 2, method: "tools/call",
  params: { name: "sag_list_projects", arguments: {} }
}) + "\n");
await wait(2500);

proc.stdin.end();
await wait(500);

console.log("=== STDOUT ===");
console.log(out);
console.log("=== STDERR (last 500) ===");
console.log(err.slice(-500));