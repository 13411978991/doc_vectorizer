// Spawn 黑洞-mcp.exe with a non-existent SAG_MCP_SOURCE_ID to test the
// new "did you mean..." error message.
import { spawn } from "node:child_process";

const EXE = "E:\\sag\\dist\\builds\\sag-20260813-171645\\黑洞-mcp.exe";
const BAD_ID = "fe6568e5-8800-439e-8b66-c7417754fa52";

const proc = spawn(EXE, [], {
  env: { ...process.env, SAG_MCP_SOURCE_ID: BAD_ID },
  stdio: ["pipe", "pipe", "pipe"]
});

let buf = "";
let id = 0;
const pending = new Map();

proc.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

proc.stderr.on("data", (d) => process.stderr.write("stderr: " + d));

function send(method, params) {
  const _id = ++id;
  return new Promise((resolveFn) => {
    pending.set(_id, resolveFn);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: _id, method, params }) + "\n");
  });
}

async function main() {
  await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  console.log("=== Search with bogus SAG_MCP_SOURCE_ID ===");
  const r = await send("tools/call", {
    name: "sag_search",
    arguments: { query: "test", topK: 3 }
  });
  const text = r.result?.content?.[0]?.text ?? r.error?.message ?? JSON.stringify(r);
  console.log(text);
  proc.kill();
}

main().catch(e => { console.error(e); proc.kill(); process.exit(1); });