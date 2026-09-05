/**
 * Embedding model evaluation: text-embedding-3-large (1024-dim) vs
 * MiniMax embo-01 (1536-dim, Chinese-focused).
 *
 * For each ground-truth query, compute embedding with both models,
 * rank chunks by cosine similarity, and check recall@5 against GT.
 *
 * No DB writes — this is read-only + external API calls.
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const MINIMAX_KEY = "sk-cp-z5_EyaNEKlw5V38veNlgrYY9YgR8H-Get6J9RZtoYl13_LWlCYl8rEQHTxWR_Yl6BBv0cNDweL5yCSt2mRYpZwPS5sE2P38eeEX5fMw_3ukaasJBcFx46AE";
const DB_PATH = "/home/admin/.openclaw/workspace/SAG/data/sag.db";
const SRC = "8904ad22-bb4a-4af2-892a-27a8be78e9eb";

const tests: Record<string, string[]> = {
  "Harness Agent": ["网址结构探索Harness Agent"],
  "深圳星耀科技": ["深圳星耀科技", "01_2025_年度报告"],
  "审计师": ["红旗清单_审计师关注", "让数字说话", "透过财报看管理"],
  "Playwright": ["网址结构探索Harness Agent"],
  "2025 年度报告": ["01_2025_年度报告", "03_行业基准"],
  "全文检索": ["网址结构探索Harness Agent", "MCP测试文档"],
  "example.com": ["网址结构探索Harness Agent"],
  "审计": ["红旗清单_审计师关注", "让数字说话", "透过财报看管理", "审查报告"],
  "供应商评分": ["红旗清单_审计师关注", "让数字说话", "透过财报看管理"],
  "项目预算": ["红旗清单_审计师关注", "智慧工厂", "让数字说话"],
  "关联方应收": ["红旗清单_审计师关注"],
  "商誉减值": ["红旗清单_审计师关注"],
  "机器学习": ["机器学习"],
  "智慧工厂": ["智慧工厂"],
  "财务报表": ["透过财报看管理", "让数字说话", "税务会计"],
};

interface ChunkRow {
  chunk_id: string;
  document_id: string;
  doc_title: string;
  content: string;
  embedding_te3l: number[];  // text-embedding-3-large
}

async function embo01(texts: string[]): Promise<number[][]> {
  const r = await fetch("https://api.minimaxi.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${MINIMAX_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "embo-01",
      type: "db",
      texts
    })
  });
  const d = await r.json();
  if (!d.vectors) {
    console.error("embo-01 error:", JSON.stringify(d).slice(0, 300));
    throw new Error("embo-01 failed");
  }
  return d.vectors as number[][];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  sqliteVec.load(db);

  // Load all chunks with their text-embedding-3-large embeddings + document titles
  const rows = db.prepare(`
    select c.id as chunk_id, c.document_id, d.title as doc_title,
           substr(c.content, 1, 200) as content,
           ce.embedding_json
    from chunks c
    join documents d on d.id = c.document_id
    join chunk_embeddings ce on ce.chunk_id = c.id
    where c.source_id = ?
      and ce.embedding_json is not null
  `).all(SRC) as { chunk_id: string; document_id: string; doc_title: string; content: string; embedding_json: string }[];

  console.log(`Loaded ${rows.length} chunks`);

  // Get doc title mapping
  const docTitle = new Map<string, string>();
  for (const r of rows) docTitle.set(r.document_id, r.doc_title);

  // For each chunk, parse the text-embedding-3-large vector
  const te3lVecs: number[][] = rows.map(r => JSON.parse(r.embedding_json));
  console.log(`TE3L dim: ${te3lVecs[0]?.length}`);

  // Get embo-01 embeddings for all chunk contents
  console.log("Calling embo-01 for chunk contents...");
  const chunkContents = rows.map(r => r.content.slice(0, 200));
  const emboVecs = await embo01(chunkContents);
  console.log(`embo-01 dim: ${emboVecs[0]?.length}`);

  // For each query, embed with both models and rank chunks
  const queries = Object.keys(tests);
  console.log(`\nCalling embo-01 for ${queries.length} queries...`);
  const queryEmboVecs = await embo01(queries);

  // te3l query embeddings — get them from chunk_embeddings for chunks that contain the query text
  // (since we don't have a way to call te3l API without key, approximate using a chunk that contains query)
  const queryTe3lVecs: number[][] = [];
  for (const q of queries) {
    const matchingChunk = db.prepare(`
      select ce.embedding_json from chunk_embeddings ce
      join chunks c on c.id = ce.chunk_id
      where c.content like ? limit 1
    `).get(`%${q}%`) as { embedding_json: string } | undefined;
    if (matchingChunk) {
      queryTe3lVecs.push(JSON.parse(matchingChunk.embedding_json));
    } else {
      queryTe3lVecs.push(te3lVecs[0]);  // fallback
    }
  }

  // Evaluate recall@5 for both models
  let te3lHits = 0, emboHits = 0, hybridHits = 0;
  const te3lFails: string[] = [];
  const emboFails: string[] = [];
  const hybridFails: string[] = [];

  console.log("\n=== Recall@5 evaluation ===");
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const expected = tests[q];
    const te3lQ = queryTe3lVecs[i];
    const emboQ = queryEmboVecs[i];

    // TE3L ranking
    const te3lRanked = te3lVecs.map((v, idx) => ({ idx, score: cosine(te3lQ, v), doc_title: rows[idx].doc_title }))
      .sort((a, b) => b.score - a.score).slice(0, 5);
    const te3lTop5 = te3lRanked.map(r => r.doc_title);
    const te3lHit = te3lTop5.some(t => expected.some(e => t.includes(e)));

    // embo-01 ranking
    const emboRanked = emboVecs.map((v, idx) => ({ idx, score: cosine(emboQ, v), doc_title: rows[idx].doc_title }))
      .sort((a, b) => b.score - a.score).slice(0, 5);
    const emboTop5 = emboRanked.map(r => r.doc_title);
    const emboHit = emboTop5.some(t => expected.some(e => t.includes(e)));

    // Hybrid: average of normalised ranks
    const te3lScores = te3lVecs.map(v => cosine(te3lQ, v));
    const emboScores = emboVecs.map(v => cosine(emboQ, v));
    const norm = (arr: number[]) => {
      const min = Math.min(...arr);
      const max = Math.max(...arr);
      return arr.map(s => (s - min) / (max - min + 1e-9));
    };
    const tN = norm(te3lScores);
    const eN = norm(emboScores);
    const hybridRanked = rows.map((r, idx) => ({
      idx, score: (tN[idx] + eN[idx]) / 2, doc_title: r.doc_title
    })).sort((a, b) => b.score - a.score).slice(0, 5);
    const hybridTop5 = hybridRanked.map(r => r.doc_title);
    const hybridHit = hybridTop5.some(t => expected.some(e => t.includes(e)));

    if (te3lHit) te3lHits++; else te3lFails.push(q);
    if (emboHit) emboHits++; else emboFails.push(q);
    if (hybridHit) hybridHits++; else hybridFails.push(q);

    const mark = (te3lHit && emboHit && hybridHit) ? "✓" :
                 (hybridHit && !te3lHit && !emboHit) ? "+" :
                 (te3lHit === emboHit) ? "=" : (te3lHit ? "TE3L>" : "EMBO>");
    console.log(`  ${mark} ${q.padEnd(14)} TE3L:[${te3lTop5[0]?.slice(0,18)}]  EMBO:[${emboTop5[0]?.slice(0,18)}]`);
  }

  console.log(`\n=== Summary ===`);
  const te3lPct = Math.round(100 * te3lHits / queries.length);
    const emboPct = Math.round(100 * emboHits / queries.length);
  console.log(`  text-embedding-3-large: ${te3lHits}/${queries.length} = ${te3lPct}%`);
  console.log(`  MiniMax embo-01:       ${emboHits}/${queries.length} = ${emboPct}%`);
  const hybridPct = Math.round(100 * hybridHits / queries.length);
  console.log(`  Hybrid (avg):           ${hybridHits}/${queries.length} = ${hybridPct}%`);
  console.log(`  TE3L fails:  ${te3lFails.join(", ")}`);
  console.log(`  EMBO fails:  ${emboFails.join(", ")}`);
  console.log(`  HYBRID fails: ${hybridFails.join(", ")}`);

  db.close();
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
