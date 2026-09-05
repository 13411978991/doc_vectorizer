import { spawn } from "node:child_process";

const proc = spawn(
  "E:\\sag\\dist\\builds\\sag-20260813-171645\\黑洞-mcp.exe",
  [], { stdio: ["pipe", "pipe", "pipe"], env: {
    ...process.env,
    DEFAULT_TENANT_ID: "default",
    SAG_MCP_SOURCE_ID: "59bfcc4d-2da3-43b1-a539-9fe605ad0d36"
  }, windowsHide: true }
);

let out = "", err = "";
proc.stdout.on("data", (c) => out += c.toString());
proc.stderr.on("data", (c) => err += c.toString());

proc.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {},
            clientInfo: { name: "test", version: "0.1" } }
}) + "\n");
await new Promise(r => setTimeout(r, 2500));

proc.stdin.end();
await new Promise(r => setTimeout(r, 500));

console.log("=== STDOUT ===");
console.log(out.slice(0, 2000));
console.log("=== STDERR (first 800) ===");
console.log(err.slice(0, 800));