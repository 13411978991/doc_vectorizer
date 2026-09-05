// Try a list of common embedding model names against the sunwoda API
const apiKey = "sk-MKSLNwKxx6xIcNBmFH7hahlCY7xEIhVzyCEkZ2HrdDpLjKhU";
const baseUrl = "https://llm-api.sunwoda.com/v1";

const candidates = [
  "text-embedding-3-large",
  "text-embedding-3-small",
  "text-embedding-ada-002",
  "bge-large-zh-v1.5",
  "BAAI/bge-large-zh-v1.5",
  "bge-large-zh",
  "embedding-2",
  "bge-m3",
  "BAAI/bge-m3",
  "text-embedding-v2",
  "text-embedding-v3",
  "embedding",
  "qwen3-embedding",
  "qwen-embed",
  "text-embedding",
  "moka-embedding",
  "conversational-embedding",
  "azure-text-embedding-3-large"
];

for (const m of candidates) {
  try {
    const r = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ input: ["test"], model: m })
    });
    const t = (await r.text()).slice(0, 200);
    const status = r.status;
    if (status === 200) {
      console.log(`✅ ${m}: ${status}  ${t.slice(0, 100)}`);
    } else {
      console.log(`❌ ${m}: ${status}  ${t.slice(0, 100)}`);
    }
  } catch (e) {
    console.log(`⚠️ ${m}: ${e.message}`);
  }
}