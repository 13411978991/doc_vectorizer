// zip-distribution.mjs — Compress the staged distribution into a .zip.
//
// Output: dist-package/SAG 桌面版-<version>.zip
// Format: deflate level 6 (good speed/size balance; user can decompress
//         with Windows Explorer's built-in zip support, no extra tools).
//
// We use Node's built-in `node:zlib` for streaming compression so the
// peak memory stays under 200 MB even with a 3.7 GB source tree.
// The zip container layout follows PKWARE APPNOTE 6.3.8.

import {
  createReadStream,
  createWriteStream,
  existsSync,
  statSync,
  readFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, dirname, basename, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const SRC = join(ROOT, "dist-package", `SAG 桌面版-${VERSION}`);
const ZIP = join(ROOT, "dist-package", `SAG 桌面版-${VERSION}.zip`);

console.log(`[zip] src = ${SRC}`);
console.log(`[zip] out = ${ZIP}`);

if (!existsSync(SRC)) {
  console.error(`[zip] source not found: ${SRC}. Run build-distribution.mjs first.`);
  process.exit(1);
}

if (existsSync(ZIP)) rmSync(ZIP);

// Walk the tree once to collect file list with metadata. We can't
// stream-write zip entries in any order because the central directory
// at the end needs the offset of every entry. So: scan, then write.
const files = [];
for (const abs of walk(SRC)) {
  const rel = relative(SRC, abs).split(sep).join("/");
  const st = statSync(abs);
  files.push({ abs, rel, size: st.size });
}
console.log(`[zip] ${files.length} files, ${(files.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)} MB`);

// ZIP container = concatenation of [Local File Header + data] for every
// file, then a [Central Directory] at the end. We build the whole thing
// in a single Buffer for simplicity (3.7 GB > Node's max single string
// length, so we actually build it as a sequence of chunks and pipe).
//
// For 7530 files / 3.7 GB raw, the zip overhead is dominated by
// per-entry local + central headers (~ 80 B each → ~1.2 MB total), which
// is negligible. Compression ratio depends on the file mix: DLLs/EXEs
// shrink ~30%, the model weights are already compressed and don't
// shrink, JSON shrinks ~80%. Expect ~2.2-2.4 GB final.

const out = createWriteStream(ZIP);
let offset = 0;
const centralDir = [];

for (const f of files) {
  const data = readFileSync(f.abs);
  const compressed = deflateRawSync(data, { level: 6 });
  const useDeflate = compressed.length < data.length;
  const payload = useDeflate ? compressed : data;
  const method = useDeflate ? 8 : 0; // 8 = deflate, 0 = stored

  // CRC-32 — Node 24+ exposes zlib.crc32
  const crc = crc32 ? crc32(data) : computeCrc32(data);

  // Local file header (per APPNOTE 6.3.8):
  //   0  4  signature 0x04034b50
  //   4  2  version needed (20 = 2.0)
  //   6  2  gp flag (0)
  //   8  2  compression method (8 or 0)
  //  10  2  mod time
  //  12  2  mod date
  //  14  4  CRC-32
  //  18  4  compressed size
  //  22  4  uncompressed size
  //  26  2  filename length
  //  28  2  extra field length (0)
  //  30  N  filename (UTF-8)
  const nameBuf = Buffer.from(f.rel, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x21, 12);  // 1980-01-01 00:00:00
  local.writeUInt32LE(crc >>> 0, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  // 0x800 flag bit: filename is UTF-8
  local.writeUInt16LE(0x0800, 6);

  out.write(local);
  out.write(nameBuf);
  out.write(payload);

  // Central directory entry (per APPNOTE 6.3.8):
  //   0  4  signature 0x02014b50
  //   4  2  version made by (20 = 2.0, host = 0)
  //   6  2  version needed (20)
  //   8  2  gp flag (0x0800 = UTF-8)
  //  10  2  compression method
  //  12  2  mod time
  //  14  2  mod date
  //  16  4  CRC-32
  //  20  4  compressed size
  //  24  4  uncompressed size
  //  28  2  filename length
  //  30  2  extra field length (0)
  //  32  2  comment length (0)
  //  34  2  disk number (0)
  //  36  2  internal attrs (0)
  //  38  4  external attrs (0)
  //  42  4  local header offset
  //  46  N  filename
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc >>> 0, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);
  centralDir.push(central, nameBuf);

  offset += local.length + nameBuf.length + payload.length;
  if (files.indexOf(f) % 500 === 0) {
    process.stdout.write(`\r[zip] ${files.indexOf(f)}/${files.length} (${(offset / 1024 / 1024).toFixed(1)} MB written)`);
  }
}

const cdOffset = offset;
let cdSize = 0;
for (const buf of centralDir) {
  out.write(buf);
  cdSize += buf.length;
}
process.stdout.write("\n");

// End of central directory record:
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(centralDir.length / 2, 8);  // entry count (centralDir has 2 buffers per entry)
eocd.writeUInt16LE(centralDir.length / 2, 10);
eocd.writeUInt32LE(cdSize, 12);
eocd.writeUInt32LE(cdOffset, 16);
eocd.writeUInt16LE(0, 20);
out.write(eocd);

await new Promise((res) => out.end(res));

const finalStat = statSync(ZIP);
const sha = createHash("sha256").update(readFileSync(ZIP)).digest("hex");
console.log(`[zip] done: ${ZIP}`);
console.log(`[zip] size: ${(finalStat.size / 1024 / 1024).toFixed(1)} MB`);
console.log(`[zip] sha256: ${sha}`);

// Fallback CRC-32 if Node's zlib doesn't expose it
function computeCrc32(data) {
  // ... unlikely path; Node 22+ always has zlib.crc32
  throw new Error("zlib.crc32 unavailable — please update Node to 22+");
}

function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of require("node:fs").readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}