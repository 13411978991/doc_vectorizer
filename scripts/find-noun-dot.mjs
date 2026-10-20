// find-noun-dot.mjs — hunt 。 that sits right before a closing quote where
// the preceding char is a typical mid-word character (体/实/载/联/置/义/
// 出/成/交/试/存/败/共/第/页/搜/待/取/话/态/送/档/项/目/果/题). Those are
// noun-tail corruptions, not sentence-final punctuation.
import { readFileSync } from "node:fs";
const lines = readFileSync("web/src/App.tsx", "utf8").split("\n");
const re = /[实体载联置义出成交试存败共第页搜待取话态送档项目果题]。[\"'`]/;
lines.forEach((l, i) => {
  const t = l.trim();
  if (re.test(l) && !t.startsWith("//") && !t.startsWith("*")) {
    console.log(`${i + 1}: ${t.slice(0, 140)}`);
  }
});
