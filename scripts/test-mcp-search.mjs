// Spawn 黑洞-mcp.exe via stdio MCP protocol and call the search tool.
// The MCP server is locked to 汇集功能 (env SAG_MCP_SOURCE_ID=59bfcc4d-...).
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const EXE = "E:\\sag\\dist\\builds\\sag-20260813-171645\\黑洞-mcp.exe";
const HUIJIGN = "59bfcc4d-2da3-43b1-a539-9fe605ad0d36";

const proc = spawn(EXE, [], {
  env: { ...process.env, SAG_MCP_SOURCE_ID: HUIJIGN },
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

proc.stderr.on("data", (d) => process.stderr.write(d));

function send(method, params) {
  const _id = ++id;
  return new Promise((resolveFn) => {
    pending.set(_id, resolveFn);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: _id, method, params }) + "\n");
  });
}

async function main() {
  // initialize
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "trae-test", version: "0" }
  });
  // initialized notification
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const queries = ["folder-a", "folder-b", "report"];
  for (const q of queries) {
    const r = await send("tools/call", {
      name: "search",
      arguments: { query: q, topK: 3 }
    });
    console.log(`\n=== query: "${q}" ===`);
    if (r.result?.content?.[0]?.text) {
      const text = r.result.content[0].text;
      try {
        const parsed = JSON.parse(text);
        const sections = parsed.sections ?? [];
        console.log(`  ${sections.length} sections`);
        for (const s of sections) {
          console.log(`    [score=${s.score?.toFixed(3)}] ${(s.content ?? "").slice(0, 80)}...`);
        }
      } catch {
        console.log(text.slice(0, 600));
      }
    } else if (r.error) {
      console.log("  ERROR:", JSON.stringify(r.error));
    } else {
      console.log(JSON.stringify(r).slice(0, 500));
    }
  }

  proc.kill();
}

main().catch((e) => { console.error(e); proc.kill(); process.exit(1); });