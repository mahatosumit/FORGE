// Extract module/feature inventory from the REA evidence bundle
import { readFileSync } from "node:fs";
const b = JSON.parse(readFileSync("C:/Users/SUMIT/AppData/Local/Temp/opencode/rea-session-bundle.json", "utf8"));
const recs = b.records ?? [];
for (const r of recs) {
  if (r.operation !== "analyze_javascript_application") continue;
  const subj = r.subject?.local_path;
  const g = r.normalized_result?.semantic_graph;
  const appG = r.normalized_result?.graph;
  console.log("\n==========================");
  console.log("SUBJECT:", subj);
  if (!g) { console.log("no semantic graph"); continue; }
  const nodes = g.nodes ?? [];
  const buckets = new Map();
  for (const n of nodes) {
    const p = n.identity?.module_path;
    if (!p) continue;
    const norm = p.replaceAll("\\", "/");
    const seg = norm.split("/").filter(s => s && s !== "." && s !== "..");
    let key;
    if (seg.includes("node_modules")) continue;
    if (seg[0] === "packages") key = seg.slice(0, 3).join("/");
    else key = seg.slice(0, 2).join("/");
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const top = [...buckets.entries()].sort((a, b2) => b2[1] - a2c(a[1], b2[1] = b2[1]));
  function a2c(){return 0}
  const sorted = [...buckets.entries()].sort((a, b2) => b2[1] - a[1]);
  for (const [k, v] of sorted.slice(0, 60)) console.log(String(v).padStart(6), k);
  // interesting relation samples
  const rels = g.relations ?? [];
  const relCount = {};
  for (const r2 of rels) relCount[r2.relation] = (relCount[r2.relation] ?? 0) + 1;
  console.log("\nrelation families:", JSON.stringify(relCount));
}
