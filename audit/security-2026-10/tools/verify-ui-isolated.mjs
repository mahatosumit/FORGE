// UI verification against the isolated audit instance (fixed build):
// console boots under CSP, no violations/errors, board + tabs work.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire("D:/quack pro/quack-current-worktree/package.json");
const { chromium } = require("playwright-core");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const inst = JSON.parse(readFileSync("audit/security-2026-10/instance.json", "utf8"));

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + String(e).slice(0, 140)));
page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push("csp: " + m.text().slice(0, 140)); });
page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("favicon")) problems.push(`http ${r.status()} ${r.url().slice(0, 90)}`); });

await page.goto(`http://127.0.0.1:${inst.port}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const title = await page.title();
const badge = await page.evaluate(() => document.getElementById("missionsCountBadge")?.textContent ?? "?");
const items = await page.evaluate(() => document.querySelectorAll("#sidebarMissionsList .nav-item").length);

// open first mission + receipt tab
await page.evaluate(() => document.querySelector("#sidebarMissionsList .nav-item")?.click());
await page.waitForTimeout(1500);
const missionOpen = await page.evaluate(() => {
  const mv = document.getElementById("mission-view");
  return mv ? getComputedStyle(mv).display !== "none" : false;
});
const receiptClicked = await page.evaluate(() => {
  const el = [...document.querySelectorAll("#mission-view .tab-btn")].find((e) => (e.textContent || "").includes("Receipt"));
  if (el) { el.click(); return true; }
  return false;
});
await page.waitForTimeout(1500);

console.log("title:", title);
console.log("board badge:", badge, "| sidebar items:", items);
console.log("mission view opened:", missionOpen, "| receipt tab clicked:", receiptClicked);
console.log("problems:", problems.length ? problems.slice(0, 6) : "none");
await page.screenshot({ path: "audit/security-2026-10/ui-verified.png", fullPage: true });
await browser.close();
process.exit(problems.length === 0 && items > 0 && missionOpen ? 0 : 1);
