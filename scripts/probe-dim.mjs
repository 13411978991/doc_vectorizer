import { spawn } from "node:child_process";

const proc = spawn(
  "E:\\sag\\dist\\mcp-test\\黑洞-mcp.exe",
  [], { stdio: ["pipe", "pipe", "pipe"], env: {
    DEFAULT_TENANT_ID: "default",
    SAG_MCP_SOURCE_ID: "59bfcc4d-2da3-43b1-a539-9fe605ad0d36",
    EMBEDDING_DIMENSIONS: "4096",
    EMBEDDING_MODEL: "qwen3-embedding-8b",
    EMBEDDING_BASE_URL: "https://llm-api.sunwoda.com/v1",
    EMBEDDING_API_KEY: "sk-MKSLNwKxx6xIcNBmFH7hahlCY7xEIhVzyCEkZ2HrdDpLjKhU",
    EMBEDDING_PROVIDER: "api",
    DATABASE_FILE: "E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db"
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

proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
await new Promise(r => setTimeout(r, 500));

proc.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 2, method: "tools/call",
  params: { name: "sag_search", arguments: { query: "盘点", strategy: "vector", topK: 3, searchMode: "standard" } }
}) + "\n");
await new Promise(r => setTimeout(r, 8000));

proc.stdin.end();
await new Promise(r => setTimeout(r, 500));

console.log("=== FULL STDERR ===");
console.log(err);
console.log("=== FULL STDOUT ===");
console.log(out);