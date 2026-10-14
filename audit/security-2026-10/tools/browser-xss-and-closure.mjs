// Browser check: stored rendering of hostile mission goal + closed-mission mutation probes.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire("D:/quack pro/quack-current-worktree/package.json");
const { chromium } = require("playwright-core");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const inst = JSON.parse(readFileSync("audit/security-2026-10/instance.json", "utf8"));

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage();
const dialogFired = [];
page.on("dialog", async (d) => { dialogFired.push(d.message()); await d.dismiss(); });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 120)));

await page.goto(`http://127.0.0.1:${inst.port}/`, { waitUntil: "domcontentloaded" });
await page.evaluate((t) => localStorage.setItem("forge_token", t), inst.token).catch(() => {});
await page.evaluate(() => localStorage.removeItem("forge_active_mission"));
await page.waitForTimeout(2000);

// The hostile goal mission should be listed; open it via deep-link selection.
const hostile = await page.evaluate(async (t) => {
  const r = await fetch("/missions", { headers: { authorization: "Bearer " + t } });
  const j = await r.json();
  return j.missions.find((m) => (m.goal || "").includes("onerror"));
}, inst.token);

let rendered = "";
if (hostile) {
  await page.evaluate((id) => {
    const items = [...document.querySelectorAll("#sidebarMissionsList .nav-item")];
    const el = items.find((x) => (x.textContent || "").includes("onerror")) || null;
    if (el) el.click();
  }, hostile.missionId);
  await page.waitForTimeout(2000);
  rendered = await page.evaluate(() => document.body.innerText);
}

console.log("mission found:", hostile ? hostile.missionId : "NO");
console.log("dialog (alert) fired:", dialogFired.length, dialogFired.slice(0, 3));
console.log("literal text rendered:", rendered.includes("<img src=x onerror="));
console.log("img element injected into DOM:", await page.evaluate(() => document.querySelectorAll('img[onerror], img[src="x"]').length));
console.log("pageerrors:", pageErrors);

// Closed-mission mutation via API (mock closes quickly; poll status)
for (let k = 0; k < 20; k++) {
  const st = await (await fetch(`http://127.0.0.1:${inst.port}/missions`, { headers: { authorization: "Bearer " + inst.token } })).json();
  const m = st.missions.find((x) => x.missionId === hostile?.missionId);
  if (m && (m.status === "closed" || m.closure)) {
    console.log("mission state:", m.status, m.closure);
    const post = async (p, body) => {
      const r = await fetch(`http://127.0.0.1:${inst.port}${p}`, { method: "POST", headers: { authorization: "Bearer " + inst.token, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { code: r.status, body: (await r.text()).slice(0, 140) };
    };
    console.log("directive to closed:", JSON.stringify(await post(`/missions/${hostile.missionId}/directive`, { content: "more work" })));
    console.log("resume closed:", JSON.stringify(await post(`/missions/${hostile.missionId}/resume`, {})));
    console.log("cancel closed:", JSON.stringify(await post(`/missions/${hostile.missionId}/cancel`, {})));
    break;
  }
  await page.waitForTimeout(1000);
}
await browser.close();
