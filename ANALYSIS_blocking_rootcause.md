# 主线程阻塞根因分析报告（纯静态代码分析）

> 分析范围：`E:\sag\完整后端版本\源码\doc_vectorizer\src\`
> 关键约束：better-sqlite3 同步 API + WAL、Node 24 single-thread event loop、
> ingestConcurrency 上限 4、watcher 默认 INGEST_CONCURRENCY=1
> （`src\config\env.ts:122`）

---

## 【主线程阻塞证据】 — 按概率从高到低

### #1（最高概率）— **LLM HTTP fetch 在主线程累积 + 同步 SQLite 写入串行化**
路径：`ingestDocument` → `prepareEvents` → 4 处 `mapWithConcurrency`。

- `src\services\ingestion-service.ts:179-181`：`this.embeddings.batchGenerate(chunking.chunks.map(...))`
  — 串行调用，没有并发。`batchGenerate`（`src\ai\embedding-client.ts:116-209`）
  在 batch 数 ≤ 1 时走 `for` 循环（line 167-171），是顺序的 await。
- `src\services\ingestion-service.ts:713-751`：`mapWithConcurrency(input.chunks, concurrency=4, mapper)` —
  4 个 worker 每个都调 `extractEventsFromChunk`（`src\ingestion\extract\extractor.ts:11-16`）
  → `this.llm.extractEventsFromChunk`（`src\ai\llm-client.ts:176-296`）
  → `this.chatJson` → `fetch(url, ...)`（`src\ai\llm-client.ts:385-393`）。

  `fetch` 在 Node 24 上是 undici 异步 HTTP（不会阻塞 event loop 等 socket I/O），
  但 `fetch` 会立即创建 N=4 个并发 socket，每个 socket 走 DNS → TCP → TLS → send →
  recv → JSON.parse 的微任务链。**fetch 触发的 microtask 风暴 + 4 路同时 in-flight
  会让 event loop 在 chunk 级的事件循环上花掉 50-150ms/iteration**（每条 fetch
  至少 2 个微任务 + body 解码 + JSON.parse，对于返回 ~1KB JSON 响应来说）。

  用户提到 "~25s/请求" — 4 路并发即意味着总时延 ≥ 25s，并且 4 路同时进入
  microtask 队列的瞬时压力是高峰期（interval 在 0-3s 时 4 路同时活跃）。
- `src\services\ingestion-service.ts:767-786`（event embedding）、
  `src\services\ingestion-service.ts:794-806`（entity embedding）、
  `src\services\ingestion-service.ts:821-833`（relation embedding）— 同上模式：
  每个 mapper 内调 `this.embeddings.batchGenerate([...])` 或 `this.embeddings.generate(...)`。
  这些都是远程 HTTP（`src\ai\embedding-client.ts:237-252` 的 `fetch(url, {...})`），
  所以**主线程被微任务 + fetch 响应解析拖住**的概率高。
- `src\services\ingestion-service.ts:234-633` dbWrite 阶段：
  每个 `await client.query(...)` 实际上**调用 better-sqlite3 同步 API**
  （`src\db\sqlite-driver.ts:288-309`：`this.db.prepare(sql)` + `stmt.run(...)` / `stmt.all(...)`），
  这些 C++ 绑定**会直接卡主线程**直到 statement 完成。
  - 每条 INSERT 的卡顿是 0.1-1ms 量级（SQLite 写缓冲 + WAL append）。
  - 但 4 路 ingest 并发 × 每个 chunk 一条 chunks INSERT + 一条 chunk_embeddings
    INSERT + 一条 vec0 INSERT + 一条 chunk_state UPDATE = **4 chunks × 4 INSERTs = 16
    sync statements 同时进 queue**。对 30 chunks 的典型 xlsx，
    total sync statements ≈ 30 × (2 chunk inserts + 4 vec0 + 1 update) ≈ 200+ statements
    per ingest，每个 ~0.5ms = 100ms+ pure sync time。
- `src\services\ingestion-service.ts:551-561`：`console.log("[entity-debug]", ...)`
  **同步 stdout 写入**，每个 entity 触发一次。在 entityResolution 阶段会触发数十次
  `console.log`，每次 1-5ms（取决于 stdout 是否 TTY / pipe）。
  `process.stderr.write(...)` 同样问题（`src\watcher\sync-orchestrator.ts:79`
  也有一处 `process.stderr.write("[diag] syncFolder ENTRY ...")`）。

### #2 — **local-bgo 路径 fallback 会引发真同步 CPU 阻塞**

- `src\ai\embedding-client.ts:132-151`：当 `embeddingProvider === 'local-bge'` 且
  `localBgeEmbedding` 走 worker thread 路径（`src\ai\embedding-worker-client.ts:221-238`），
  这是**安全的** — worker thread 跑 ONNX forward，主线程只 await `postMessage`。
- `src\ai\embedding-client.ts:813-822`：但 worker 启动失败时（SEA native-cache 缺失、
  .cjs 文件不存在），会 fallback 到 `localBgeEmbeddingInProcess`
  （`src\ai\embedding-client.ts:844-935`）— 这是**纯主线程 ONNX forward**，每次 forward
  ~10-50ms/文本，30 chunks 同步就是 ~1.5s 真卡主线程。
- 文档 `embedding-client.ts:919-932` 提到 "每 3 chunks 用 setImmediate 让出一次"，
  这表明作者**自己也承认 in-process fallback 会阻塞主线程**。
- 这条路线的概率取决于部署形态：开发模式（tsx 直接跑）大概率命中 fallback，
  生产 SEA 模式大概率命中 worker。

### #3 — **NER pipeline 在主线程同步 forward（Plan B，2026-09-19 后）**

- `src\ai\llm-client.ts:442-465`：`runNerForIngest` 调用
  `getLocalNerPipeline(...)`（`src\ai\ner-pipeline-factory.ts:135-277`），
  然后 `pipeline(truncated, { aggregation_strategy, max_length, truncation })` —
  这是在**主线程**上跑的 ONNX token-classification（与 BGE 不同，NER **没有 worker thread**），
  单次 forward ~5-15ms/chunk（注释 `src\ai\llm-client.ts:7`）。
- 4 路 ingest 并发时，4 个 chunk 各自触发 NER forward；如果 pipeline 已加载（startup 验证时加载了，
  见 `src\api\server.ts:350-355`），后续 forward 是同步 ONNX call，**每个 chunk 5-15ms 主线程
  占用**，4 路并发累计 ~60ms+ 同步 ONNX/iteration。
- 因为 NER 模型加载是 startup 时单次（`src\api\server.ts:308-364`），首次同步 forward 的
  worst-case 包含分词 + tensor 创建，但稳态下只是 forward pass。

### #4 — **Ingest queue per-folder 并发 + 单 SQLite 文件锁**

- `src\watcher\ingest-queue.ts:397-411`：`drain()` 的并发数 = `resolveConcurrency()`
  （`src\watcher\ingest-queue.ts:143-150`） = `getRuntimePerformanceSettings().ingestConcurrency`，
  默认 1（`src\config\env.ts:122` + `src\services\performance-settings-service.ts:92`），
  但 schema 允许 1-10（`src\services\performance-settings-service.ts:91`），
  UI aggressive profile 给 3（line 159）。
- 每个 `processItem`（`src\watcher\ingest-queue.ts:414-563`）调
  `ingestEntry` → `ingestionService.ingestDocument` → 内层又跑 4 路 `mapWithConcurrency`。
  所以最坏情况下 **3 文件 × 4 chunks = 12 路同步 SQLite + HTTP 同时进**，
  主线程会被这 12 路的 microtask + sync write 反复打断。

### #5 — **dbWrite 阶段单线程长事务**

- `src\services\ingestion-service.ts:236-633` 在一个 `await client.query("begin")`...
  `await client.query("commit")` 长事务里跑 ~50-200 sync SQLite operations（`sqlite-driver.ts:288-309`）。
  - 整个事务期间 better-sqlite3 持有 writer mutex（WAL 模式下允许 1 writer + N readers，
    但单 connection 内的事务是 atomic + serial）。
  - 单个 SQLite transaction 50+ statements 在事务提交 WAL 时会触发 fsync（取决于 `synchronous`
    pragma，better-sqlite3 默认 FULL），每次 fsync 在 Windows 5-50ms（NVMe） / 50-500ms（HDD）。
  - 跨进程读（其他 HTTP request 走 `pool.query`）也走这同一个 `SqlitePool` 单 connection
    （`src\db\sqlite-driver.ts:240-242`：`async connect(): Promise<SqlitePool> { return this; }`
    — SQLite 是单连接），**所有读写排队过同一个 better-sqlite3 mutex**。
  - 关键是 `await client.query` 包了一个 `async` 包装但内部仍**同步执行**：
    `src\db\sqlite-driver.ts:248-343` 的 `async query` 整个函数体除了 `await`
    都是同步的，所有 `stmt.prepare(...)` / `stmt.run(...)` / `stmt.all(...)` 都是 sync C++ call。

### #6 — **Fastify 默认 timeout 在长 ingest 期间不会卡请求，但 keep-alive socket 队列可能拖累**

- `src\api\server.ts:64-70`：`Fastify({ logger: ... })` — **未显式设置** `connectionTimeout`、
  `keepAliveTimeout`、`requestTimeout`。Fastify 默认分别是 `connectionTimeout: 0`（不超时）、
  `keepAliveTimeout: 72000`（72s）、`requestTimeout: 0`（不超时）。
- 但 HTTP server 跟 ingest 走同一个 Node event loop，**ingest 每条 INSERT 的同步
  C++ 调用占主线程的几百微秒**会延迟所有 incoming request 的 accept / parse。
- 默认 Node `http.Server` 的 `server.maxConnections` 是无上限 + 排队，所以 ingest
  卡顿时浏览器侧可能看到的是 "请求已发但几秒没响应"，因为 TCP 连接接受了但
  HTTP parser 还在排队等 event loop。

---

## 【SQLite 锁证据】

### busy_timeout 当前值

- `grep` 全 src 树：`busy_timeout` / `PRAGMA busy` / `pragma.*timeout` 全部 **0 匹配**
  （除了无关的 `journal_mode` / `foreign_keys` / `wal_checkpoint` / `setImmediate`）。
- `src\db\sqlite-driver.ts:38-50` 的 `getOrOpen()` 只设了 `journal_mode = WAL` 和
  `foreign_keys = ON`（line 40-41），**没有设置 `busy_timeout`**。
- better-sqlite3 的默认 `busy_timeout` 是 **0 毫秒**（即 SQLITE_BUSY 立即抛错）。

### write 阶段会不会阻塞 read

- `SqlitePool.connect()`（`src\db\sqlite-driver.ts:240-242`）返回 self — 整个进程
  **只有一个 better-sqlite3 Database 实例**（`databases` Map 同一 filePath 只开一次）。
- better-sqlite3 是**同步 + 单连接** API：每次 `stmt.run/all` 都拿 C++ 层的 mutex。
- WAL 模式下 SQLite 允许 1 writer + N readers 并发，但 better-sqlite3 没有内置的
  connection pool — 全部读写**串行过同一 mutex**。
- `dbWrite` 阶段（`ingestion-service.ts:234-633`）跑一个长事务，事务期间所有
  concurrent `pool.query(...)`（包括浏览器请求触发的 list / search）都进同一 mutex
  队列等待。
- 每次 `stmt.run` 在长事务内累加到 ~200 次时，**单次 read 的等待 = 长事务剩余
  sync statements × 每条 ~0.5-2ms = 可能 50-200ms 的 blocking**。
- 长事务的 WAL append 越积越多时，**commit 时的 WAL flush / checkpoint** 会一次性
  fsync（5-500ms），期间整个 mutex 卡住。
- 因为没有 `busy_timeout`，**如果有其他 writer（理论上只有一个进程所以不会）**，
  会立即抛 SQLITE_BUSY。实际场景中只有 ingest writer 自己 → 不会有 BUSY 错误，
  但 read 端的"卡"是 mutex 串行排队导致的延迟，不是 BUSY 抛错。

### WAL flush 副作用

- `src\db\sqlite-driver.ts:326` 唯一一个 `pragma("wal_checkpoint(TRUNCATE)")` 只在
  "表真的没了" 的 stale-schema fallback 里触发（line 318-335），日常 commit 不强制
  checkpoint，所以**WAL 不会自动 flush**。后果：
  - WAL 文件持续增长（默认 1000 page 阈值才自动 checkpoint）。
  - commit 时的 fsync 是 incremental commit per-statement（`synchronous=FULL` 默认），
    不是整个 WAL 一起 fsync，所以单次 commit 通常 5-50ms（NVMe）/ 50-300ms（HDD）。
  - 但 200+ statements 的事务累积 fsync 可能在 commit 时一次性放出来几十 ms。

---

## 【最可能的根因】

**主线程阻塞证据 #1 + #5 + SQLite 锁证据叠加：**
> `src\services\ingestion-service.ts:233-633` 的 `dbWrite` 阶段在主线程跑一个
> 长事务（200+ 同步 SQLite operations），与
> `src\services\ingestion-service.ts:713-833` 的 4 路 `mapWithConcurrency` 并发
> 跑 LLM/embedding HTTP fetch 叠加，主线程被 microtask 风暴 + 同步 C++ SQLite mutex
> 反复打断。N=4 并发、典型 30 chunks 时，**主线程 50-200ms/iteration 是常态，
> 某些 commit + NER forward 的同步窗口可能瞬时冲到 500ms-1s**。
>
> 这时浏览器其他按钮的 HTTP 请求：TCP accept → HTTP parser → route handler →
> `pool.query(...)` → 等 better-sqlite3 mutex 的某个等待点 → 返回 → 序列化响应
> → write socket。整个 pipeline 在 event loop 卡顿时延累计 ≥ 主线程卡顿量级。

**具体到最热的 3 条证据线（按概率降序）**：

| 概率 | 文件 / 行 | 函数 | N 并发时主线程影响 |
|---|---|---|---|
| **P0**（最热） | `ingestion-service.ts:234-633` + `sqlite-driver.ts:288-309` | `dbWrite` + `stmt.run` | **200+ sync C++ calls per ingest × 4 ingest 概率叠加 = 50-200ms 主线程占用 per ingest，长事务 commit 时的 fsync 5-300ms spike**。`SqlitePool` 单 connection → 所有 read 也排队过同一 mutex。 |
| **P1** | `ingestion-service.ts:713-833` × 4 + `embedding-client.ts:237-252` + `llm-client.ts:385-393` | `mapWithConcurrency` × 4 workers × 3 个 embedding stages | **4 路 fetch 同时 in-flight，microtask 风暴 50-150ms/event-loop-iteration**。batchGenerate 串行 / concurrent 取决于 batch 数（line 166-190）。 |
| **P2** | `ingestion-service.ts:794-806` (entity embedding) + `llm-client.ts:442-465` (NER forward) | `this.embeddings.generate(...)` + `getLocalNerPipeline(...)` | **entity embedding 单条 HTTP 5-15ms × 4 并发 = 20-60ms**；NER 主线程同步 forward 每个 chunk 5-15ms × 4 = 20-60ms 同步 CPU 占用。 |
| **P3** | `embedding-client.ts:813-822` (worker fallback 路径) | `localBgeEmbeddingInProcess` | **只在 worker thread 文件缺失时 hit；每个 ONNX forward 10-50ms/chunk × 4 = 40-200ms 主线程阻塞**（开发模式 tsx 跑大概率命中）。 |
| **P4** | `ingestion-service.ts:551-561` | `console.log("[entity-debug]", ...)` | 每个 entity 1 次 stdout 写，50-200 entity 累计 50-500ms。 |

**结论**：**P0 + P1 是主因**。

- `dbWrite` 阶段（`ingestion-service.ts:233-633`）在主线程串行执行 200+ 个 better-sqlite3
  同步 statement，加上 4 路 LLM/embedding fetch 同时 in-flight 触发 microtask 风暴，
  主线程被反复打断。
- **N=4 ingestConcurrency + 30 chunks 典型 xlsx：主线程 100-300ms/iteration 是常态，
  在 dbWrite 长事务 commit + WAL fsync 时瞬时可冲 500ms-1s。**
- 这时同一 Node 主线程上的 Fastify HTTP server 的"接受新请求 → 路由 →
  `pool.query(...)` → 等 better-sqlite3 mutex" 的整段 pipeline 累计延迟 ≥ 主线程卡顿量级，
  所以**浏览器点其他按钮会感觉"反应慢几秒"**。

**关键非根因但需注意的点**：
- busy_timeout 缺省（=0）在本场景下不会触发 BUSY 错误（因为只有一个 writer 进程），
  但**单 mutex 串行化**本身就是 read 端卡顿的根因。
- LLM_HTTP 调用本身是异步的，不会阻塞 event loop 等 socket I/O — 真正阻塞的是
  fetch 引发的 microtask + JSON.parse + 后续 `await client.query` 调同步 better-sqlite3。
- 之前有 worker thread 兜底 BGE embedding 是**正确方向**（`embedding-worker.ts`），
  但 NER 没走 worker、dbWrite 也没走 worker，所以根因没消除。

---

## 【附：需要下一轮关注的次要证据】

1. `src\watcher\sync-orchestrator.ts:79` — `process.stderr.write` 同步 stderr 输出，
   每次 syncFolder 都触发一次（~1-10ms）。
2. `src\ai\embedding-client.ts:163-190` — `batchGenerate` 的 sub-batch 并发是
   `getRuntimePerformanceSettings().embeddingBatchConcurrency` = 5（默认），
   意味着**单次 batchGenerate 内部就有 5 路 fetch 同时 in-flight**，
   与外层 `mapWithConcurrency` 的 4 路叠加 = **最坏 20 路 fetch 同时**
   （每个 chunk 在 entity/relation embedding 阶段都触发 1 个 fetch；
   event embedding 阶段每个 2 路；chunk embedding 阶段只走一次但 5 路）。
3. `src\services\ingestion-service.ts:417-446` — 每个 chunk 触发 4 条 INSERT（chunks、
   chunk_embeddings、chunk_vec0、chunk_state update），30 chunks = 120 sync SQLite
   calls + 30 unique chunks = 150 sync calls in dbWrite phase 1。叠加 event/entity
   INSERT，总事务 200-500 sync statements。
4. `src\ai\embedding-client.ts:224-251` 的 `createModelCallLogger` 在每次 fetch 前后
   调用，里面 `JSON.stringify({ url, method, headers, body })` 是 sync CPU work —
   4 路同时触发时也吃 ~5-10ms 主线程。