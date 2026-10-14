import { readFileSync } from "node:fs";
const src = readFileSync("src/api/server.ts", "utf8").split("\n");
const authedLine = src.findIndex((l) => l.includes("if (!this.authed(req))")) + 1;
console.log("authed() gate at server.ts line", authedLine);
const roots = [];
src.forEach((l, i) => {
  const m = l.match(/parts\[0\] === "([a-z-]+)"/);
  if (m) roots.push({ line: i + 1, root: m[1], after: i + 1 > authedLine });
  if (l.includes("url.pathname ===")) roots.push({ line: i + 1, root: l.trim().slice(0, 70), after: i + 1 > authedLine });
});
for (const r of roots) console.log(`${String(r.line).padStart(5)}  ${r.root.padEnd(34)} ${r.after ? "after-auth" : "*** BEFORE AUTH ***"}`);
console.log("total route roots:", roots.length);
