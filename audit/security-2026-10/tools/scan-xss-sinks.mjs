// Static scan: innerHTML sinks in webui.ts and whether interpolation sites are escaped.
import { readFileSync } from "node:fs";
const src = readFileSync("src/api/webui.ts", "utf8").split("\n");
const sinkLines = [];
src.forEach((l, i) => {
  if (/\.innerHTML\s*=/.test(l) || /insertAdjacentHTML/.test(l)) sinkLines.push(i + 1);
});
console.log("innerHTML sinks at lines:", sinkLines.join(", "));
// For each sink, print following up to 14 lines and flag ${...} that are not wrapped in escapeHtml/formatMarkdown/JSON.stringify/Number
for (const s of sinkLines) {
  const block = src.slice(s - 1, s + 17).join("\n");
  const interps = [...block.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());
  const risky = interps.filter((x) => !/escapeHtml|formatMarkdown|escapeAttr|JSON\.stringify|Number\(|\.length|\.toFixed|idx|_id|id\)/.test(x));
  if (risky.length) console.log(`\nline ${s} risky interpolations:\n  ` + risky.join("\n  "));
}
console.log("\nsinks total:", sinkLines.length);
