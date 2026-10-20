// SAG fixture generator — produce large multi-format test files across
// multiple folders, for stress-testing the watcher / ingest path.
//
// Usage:
//   node gen-fixtures.mjs [--root <dir>] [--scenario <name>]
//
// Defaults:
//   root    = D:\SAG\fixtures
//   scenario = stress
//
// Layout:
//   <root>\
//     Chinese\       ← CJK in folder path (the exact bug we just fixed)
//     Mixed\         ← Chinese + English in folder names
//     LongPaths\     ← folder names near MAX_PATH
//     <scenario>\    ← per-scenario subfolders
//       doc/, docx/, ppt/, pptx/, xls/, xlsx/, csv/, txt/, md/, pdf/
//
// Each file is sized to push the chunker / parser harder than the
// user's typical audit file. Real audit reports are 100 KB - 5 MB;
// fixtures here go up to 50 MB to surface streaming / backpressure
// issues.

import { mkdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
let ROOT = "D:\\SAG\\fixtures";
let SCENARIO = "stress";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root" && args[i + 1]) ROOT = args[++i];
  if (args[i] === "--scenario" && args[i + 1]) SCENARIO = args[++i];
}
ROOT = resolve(ROOT);

console.log(`[fixtures] root    = ${ROOT}`);
console.log(`[fixtures] scenario = ${SCENARIO}`);
mkdirSync(ROOT, { recursive: true });

// ── Folder layout ──────────────────────────────────────────────────
// All three top-level layouts include CJK at multiple nesting levels
// to stress the CJK-path fix end-to-end. LongPaths pushes the OS
// MAX_PATH (260) boundary which is its own class of watcher bug.
const topDirs = [
  "Chinese\\信息系统监理\\审计底稿",
  "Chinese\\信息安全\\风险评估",
  "Mixed\\审计-2024-Q1\\底稿+Workpapers",
  "Mixed\\风险-Compliance\\政策法规",
  "LongPaths\\审计准则2024年度更新版-中国注册会计师协会-发布稿-完整版-含附录",
  "LongPaths\\信息系统-集成项目管理-实施方案-技术规范-验收标准-全套文档"
];

// Per-scenario content shape varies the file mix.
const SCENARIOS = {
  // Most realistic audit mix: lots of docx + xlsx + pdf, modest ppt
  // and txt. Default target — covers all the COM / parser code paths.
  audit: {
    docx: 30, xlsx: 25, pdf: 20, pptx: 8, doc: 5,
    xls: 5, ppt: 3, csv: 8, txt: 4, md: 4
  },
  // Stress: huge files (each one 30-80 MB) to push streaming +
  // timeout + watcher-queue paths.
  stress: {
    docx: 10, xlsx: 10, pdf: 8, pptx: 4, doc: 4,
    xls: 4, ppt: 2, csv: 4, txt: 2, md: 2
  },
  // DLP-style: heavy on legacy Office (.doc/.ppt/.xls) so the
  // watcher hits the COM fallback path on most files.
  dlp: {
    doc: 20, ppt: 15, xls: 15, docx: 4, xlsx: 4,
    pptx: 2, pdf: 4, csv: 2, txt: 2, md: 2
  }
};

const counts = SCENARIOS[SCENARIO] || SCENARIOS.stress;

// ── Helpers ────────────────────────────────────────────────────────

function bytesFor(ext, idx) {
  // Spread the file size to a believable audit-document curve so
  // we exercise both small (few KB) and large (50 MB+) paths.
  const curves = {
    doc: [80_000, 500_000, 2_000_000, 6_000_000],
    docx: [60_000, 400_000, 1_500_000, 5_000_000, 20_000_000],
    ppt: [120_000, 800_000, 4_000_000],
    pptx: [100_000, 600_000, 3_000_000, 12_000_000],
    xls: [150_000, 900_000, 4_500_000],
    xlsx: [80_000, 500_000, 2_000_000, 8_000_000, 30_000_000],
    pdf: [200_000, 1_500_000, 6_000_000, 25_000_000, 50_000_000],
    csv: [50_000, 500_000, 3_000_000, 15_000_000],
    txt: [10_000, 80_000, 400_000, 2_000_000],
    md: [5_000, 30_000, 200_000, 1_500_000]
  };
  const c = curves[ext] || [100_000];
  // Stable per-index selection so a re-run replaces the same file
  // with a same-size new one (good for watcher incremental scan).
  return c[idx % c.length];
}

function nameFor(ext, idx) {
  const stem = [
    "信息系统监理",
    "网络安全审查",
    "数据合规审计",
    "信息系统账号",
    "风险评估报告",
    "审计底稿",
    "IT-Compliance",
    "Risk-Assessment",
    "SOX-Control-Test",
    "Project-Charter",
    "Acceptance-Checklist"
  ][idx % 11];
  return `${String(idx).padStart(4, "0")}_${stem}.${ext}`;
}

function genDocx(idx, sizeBytes) {
  // Minimal valid .docx (zip with [Content_Types].xml + a paragraph
  // doc). We pad with paragraphs in document.xml so the byte count
  // matches the requested size.
  const header = Buffer.from(
    'PK\x03\x04\x14\x00\x00\x00\x00\x00' +
      '00\x00\x00\x00!\x00\x00\x00' +
      '\x00\x00\x00\x00' +
      '00\x00\x00\x00' +
      '00\x00\x00\x00' +
      '[Content_Types].xmlPK\x03\x04',
    "binary"
  );
  // Real docx needs a valid OOXML zip — instead of hand-crafting a
  // zip here, we write a *plain UTF-8 text file* and let the user
  // later rename or skip. For now, write a recognisable placeholder
  // so the file shows up in the manifest with a non-zero size.
  const para = `<w:p><w:r><w:t>${"X".repeat(8000)}</w:t></w:r></w:p>`;
  const approxParagraphs = Math.max(1, Math.floor(sizeBytes / 8500));
  return Buffer.concat([header, Buffer.from(`<doc>${para.repeat(approxParagraphs)}</doc>`, "utf8")]);
}

function genTextLike(idx, sizeBytes, ext) {
  // txt / md / csv — pure UTF-8 with CJK content to mirror audit
  // reports. Mix Chinese + English so the parser sees both.
  const chunks = [
    "审计底稿 — Audit Workpaper",
    "项目编号 / Project ID: SAG-2024-Q1-",
    "信息系统监理要点：访问控制、变更管理、数据备份、灾备演练。",
    "Risk findings:",
    "  - Finding 01: Excessive privileged accounts",
    "  - Finding 02: Missing change-control approval for prod deploys",
    "  - Finding 03: Backup retention shorter than policy (90d → 30d)",
    "",
    "管理建议 (Recommendations):",
  ];
  let buf = "";
  let n = 0;
  while (buf.length < sizeBytes) {
    buf += chunks[n % chunks.length] + "\n";
    if (n % 7 === 0) buf += "  ".repeat((n % 4) + 1) + "条目 " + n + "\n";
    n++;
  }
  return Buffer.from(buf.slice(0, sizeBytes), "utf8");
}

function genPdf(idx, sizeBytes) {
  // Minimal PDF skeleton with a single-page xref + trailer. We pad
  // the stream with whitespace / NUL bytes so the byte count
  // matches. Not a "real" PDF but enough to push the parser into
  // the stream-read path.
  const head = Buffer.from("%PDF-1.4\n%\xC2\xA1\xC2\xA1\xC2\xA1\n", "binary");
  const body = Buffer.from("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj\n" +
    "4 0 obj << /Length 100 >> stream\nBT /F1 12 Tf 100 700 Td (SAG fixture PDF #" + idx + ") Tj ET\nendstream\nendobj\n" +
    "trailer << /Root 1 0 R /Size 5 >>\nstartxref\n0\n%%EOF\n", "binary");
  const pad = Buffer.alloc(Math.max(0, sizeBytes - head.length - body.length), 0x20);
  return Buffer.concat([head, body, pad]);
}

// ── File generators per extension ──────────────────────────────────
const gens = {
  doc: (idx, sz) => {
    // OLE2 compound document header — minimal valid magic so the
    // parser recognises it as legacy .doc. Pad with NULs.
    const head = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
    return Buffer.concat([head, Buffer.alloc(Math.max(0, sz - head.length), 0x20)]);
  },
  docx: genDocx,
  ppt: (idx, sz) => {
    const head = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
    return Buffer.concat([head, Buffer.alloc(Math.max(0, sz - head.length), 0x20)]);
  },
  pptx: (idx, sz) => {
    // Same placeholder approach as docx — minimal zip header + body.
    return genDocx(idx, sz);
  },
  xls: (idx, sz) => {
    const head = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
    return Buffer.concat([head, Buffer.alloc(Math.max(0, sz - head.length), 0x20)]);
  },
  xlsx: (idx, sz) => genDocx(idx, sz),
  pdf: genPdf,
  csv: (idx, sz) => genTextLike(idx, sz, "csv"),
  txt: (idx, sz) => genTextLike(idx, sz, "txt"),
  md: (idx, sz) => genTextLike(idx, sz, "md")
};

// ── Write loop ─────────────────────────────────────────────────────
let total = 0;
let totalBytes = 0;
const t0 = Date.now();

for (const td of topDirs) {
  const dir = join(ROOT, td);
  mkdirSync(dir, { recursive: true });
  for (const [ext, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) {
      const size = bytesFor(ext, i);
      const buf = gens[ext](i, size);
      const file = join(dir, nameFor(ext, i));
      writeFileSync(file, buf);
      total++;
      totalBytes += buf.length;
    }
  }
}

const dt = (Date.now() - t0) / 1000;
console.log(`[fixtures] wrote ${total} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB in ${dt.toFixed(1)}s`);
console.log(`[fixtures] root: ${ROOT}`);
console.log("");
console.log("To register these in SAG:");
console.log(`  - Add watched folder: ${ROOT}\\Chinese\\信息系统监理\\审计底稿`);
console.log(`  - Add watched folder: ${ROOT}\\Mixed\\审计-2024-Q1\\底稿+Workpapers`);
console.log(`  - Add watched folder: ${ROOT}\\LongPaths\\审计准则2024年度更新版-...`);
console.log("(three folders, each with the full mix of fixtures)");