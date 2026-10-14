// Scan webui.ts for backslash escapes that TS template cooking will corrupt.
import { readFileSync } from "node:fs";
const src = readFileSync("src/api/webui.ts", "utf8");
const lines = src.split("\n");
const offenders = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    if (line[j] !== "\\") continue;
    const n2 = line[j + 1] ?? "";
    const n3 = line[j + 2] ?? "";
    if (n2 === "$" && n3 === "{") { j += 2; continue; }       // intentional: \${
    if (n2 === "`") { j += 1; continue; }                      // intentional: \`
    if (n2 === "\\") { j += 1; continue; }                     // already doubled
    if (n2 === "x" && /[0-9a-f]/i.test(n3)) { j += 3; continue; } // \x60 etc.
    if (n2 === "u" && n3 === "{") continue;                    // \u{...}
    offenders.push({ line: i + 1, col: j, ctx: line.slice(Math.max(0, j - 30), Math.min(line.length, j + 20)) });
  }
}
for (const o of offenders) console.log(`${o.line}:${o.col}  …${o.ctx}…`);
console.log("total offenders:", offenders.length);
