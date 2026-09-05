import { spawn } from "node:child_process";

const EXE = "E:\\sag\\dist\\builds\\sag-20260813-171645\\黑洞-mcp.exe";
const HUIJI1 = "76b1753c-ea18-480e-8b8f-82625dd9afa5";

const proc = spawn(EXE, [], {
  env: { ...process.env, DEFAULT_TENANT_ID: "default", SAG_MCP_SOURCE_ID: HUIJI1 },
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

proc.stderr.on("data", () => {});

function send(method, params) {
  const _id = ++id;
  return new Promise((resolveFn) => {
    pending.set(_id, resolveFn);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: _id, method, params }) + "\n");
  });
}

async function main() {
  await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "trae-verify", version: "0" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const r = await send("tools/call", { name: "sag_search", arguments: { query: "速博达", topK: 3 } });
  const text = r.result?.content?.[0]?.text ?? r.error?.message ?? JSON.stringify(r);
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  console.log(`hits: ${parsed?.sections?.length ?? 0}`);
  for (const s of (parsed?.sections ?? []).slice(0, 3)) {
    console.log(`  [${s.score?.toFixed(3)}] ${(s.content ?? "").slice(0, 100)}`);
  }
  if (r.error) console.log("error:", r.error.message);
  proc.kill();
}

main().catch(e => { console.error(e); proc.kill(); process.exit(1); });