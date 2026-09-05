// Quick test: can we reach 302ai embedding API?
const apiKey = "sk-MKSLNwKxx6xIcNBmFH7hahlCY7xEIhVzyCEkZ2HrdDpLjKhU";
const baseUrl = "https://llm-api.sunwoda.com/v1";
const t0 = Date.now();
try {
  const resp = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ input: ["hello"], model: "text-embedding-3-large" })
  });
  const elapsed = Date.now() - t0;
  console.log(`status: ${resp.status}  elapsed: ${elapsed}ms`);
  const text = await resp.text();
  console.log("body preview:", text.slice(0, 800));
} catch (e) {
  console.log("ERR:", e.message);
}