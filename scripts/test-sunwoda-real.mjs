// Test real LLM extraction by directly calling chatJson() with the
// settings from the DB. We bypass getRuntimeSettings() because its
// NODE_ENV=test check fires when tsx loads ai-settings-service.ts
// (env.ts defaults NODE_ENV to "development" so it works, but tsx
// with no --env-file flips it to "test" and we always go through the
// envSettings() shortcut which has no DB-backed LLM base URL).
//
// This test validates the runtime path against the running backend
// by reading settings from the SQLite DB directly.
import Database from "better-sqlite3";

const db = new Database("./data/sag.db", { readonly: true });
const row = db.prepare(`
  SELECT llm_provider, llm_base_url, llm_model, llm_api_key
  FROM ai_provider_settings WHERE id = 'global'
`).get();
db.close();

if (!row || !row.llm_base_url) {
  console.error("DB has no LLM config; aborting.");
  process.exit(1);
}

const settings = {
  llmProvider: row.llm_provider,
  llmBaseUrl: row.llm_base_url,
  llmModel: row.llm_model,
  llmApiKey: row.llm_api_key || "",
  llmTimeoutMs: 60000,
  hasRemoteLlm: !!(row.llm_api_key && row.llm_base_url && row.llm_model)
};
console.log("DB-backed runtime settings:");
console.log("  llmProvider:", settings.llmProvider);
console.log("  llmBaseUrl:", settings.llmBaseUrl);
console.log("  llmModel:", settings.llmModel);
console.log("  hasRemoteLlm:", settings.hasRemoteLlm);
console.log("  hasLlmApiKey:", !!settings.llmApiKey);
console.log("");

// Now call the LLM client directly with these settings. We need a
// real chatJson() call — import the private method via the class.
const { OpenAICompatibleLlmClient } = await import("../src/ai/llm-client.js");

// Hack: instantiate, then call the protected chatJson() via
// "(client as any).chatJson(settings, ...)".
const client = new OpenAICompatibleLlmClient();

const sampleText = "审计发现：张三在2025年10月于北京签署了关于Q4销售报表的合规审查文件。本期内控审计发现1项风险。";
console.log("Calling chatJson (benchmark extraction) via real Sunwoda endpoint...");
const t0 = Date.now();
try {
  const result = await client.chatJson(settings, {
    operation: "extractEventsFromChunk.real-test",
    messages: [
      { role: "system", content: "You are an audit-event extractor. Respond only in JSON." },
      { role: "user", content: JSON.stringify({
        type: "request",
        data: {
          items: [{
            id: 1,
            content: "# 审计发现\n\n" + sampleText
          }],
          meta: {
            source_type: "article",
            source_title: "测试文档",
            source_summary: "",
            previous_context: "",
            related_events: [],
            entity_types: [
              { type: "person", description: "人物、作者、用户、负责人等具体个人" },
              { type: "organization", description: "公司、机构、团体、政府部门、学校、团队等组织" },
              { type: "location", description: "地点、地域、国家、城市、场所、地址" },
              { type: "time", description: "日期、年份、时期、时间表达" }
            ],
            output_language: "Chinese"
          }
        },
        output_schema: {
          type: "object",
          properties: {
            type: { const: "response" },
            data: {
              type: "object",
              properties: {
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      summary: { type: "string" },
                      content: { type: "string" },
                      category: { type: "string" },
                      keywords: { type: "array", items: { type: "string" } },
                      entities: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            type: { type: "string" },
                            name: { type: "string" },
                            description: { type: "string" }
                          }
                        }
                      },
                      is_valid: { type: "boolean" }
                    }
                  }
                }
              }
            }
          }
        }
      }) }
    ]
  });
  console.log("Got result in", Date.now() - t0, "ms:");
  console.log(JSON.stringify(result, null, 2).slice(0, 1500));
} catch (err) {
  console.log("FAILED after", Date.now() - t0, "ms:", err.message);
  process.exit(1);
}
process.exit(0);