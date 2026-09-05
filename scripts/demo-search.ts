import { searchService } from "../src/services/search-service.js";
import { closePool } from "../src/db/pool.js";

const query = process.argv.slice(2).join(" ") || "How does SAG multi search work?";

try {
  const result = await searchService.search({
    query,
    sourceIds: ["10000000-0000-0000-0000-000000000001"],
    strategy: "multi",
    topK: 5,
    returnTrace: true
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closePool();
}
