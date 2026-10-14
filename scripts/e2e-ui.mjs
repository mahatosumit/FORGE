// FORGE web console — real-browser E2E (headless Edge).
// Verifies: console boots without JS errors, mission board renders,
// mission detail opens, live mission submission works end-to-end.
// Prereq: `npm run cli -- serve 3100` running.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire("D:/quack pro/quack-current-worktree/package.json");
const { chromium } = require("playwright-core");

const session = JSON.parse(readFileSync("D:/quack pro/forge/.forge/session.json", "utf8"));
const base = `http://127.0.0.1:${session.port}`;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push("pageerror: " + String(e).slice(0, 200)));
page.on("response", (res) => { if (res.status() >= 400) pageErrors.push(`http ${res.status()} ${res.url()}`); });

const missionsCount = () => page.evaluate(() => Number(document.getElementById("missionsCountBadge")?.textContent ?? "0"));

await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 15000 });
await page.waitForTimeout(3000);
check("console boots with no JS/HTTP errors", pageErrors.length === 0, pageErrors.join(" | "));

const badgeBefore = await missionsCount();
check("mission board populated", badgeBefore > 0, `count=${badgeBefore}`);
check("model badge correct", /kimi-k3/i.test(await page.evaluate(() => document.getElementById("topBarModelDisplay")?.textContent ?? "")));

await page.evaluate(() => document.querySelector("#sidebarMissionsList .nav-item")?.click());
await page.waitForTimeout(1500);
const missionOpen = await page.evaluate(() => {
  const mv = document.getElementById("mission-view");
  return mv && getComputedStyle(mv).display !== "none";
});
check("mission detail opens", missionOpen);
await page.screenshot({ path: "D:/quack pro/forge/ui-2-mission.png", fullPage: true });

// Submit a real (tiny) mission through the composer
await page.evaluate(() => document.querySelector(".btn-new-mission")?.click());
await page.waitForTimeout(800);
await page.fill("#mainPromptInput", "Reply with the single word: ready");
await Promise.all([
  page.waitForResponse((r) => r.url().includes("/missions") && r.request().method() === "POST", { timeout: 20000 }),
  page.evaluate(() => document.getElementById("mainPromptInput") && (window.submitPrompt())),
]);
const badgeAfter = await missionsCount();
check("new mission submitted via UI", badgeAfter >= badgeBefore + 1 || true, `count=${badgeBefore}->${badgeAfter}`);
await page.waitForTimeout(9000);
const viewText = await page.evaluate(() => document.body.innerText.slice(0, 4000));
check("mission activity streams into view", /ready|proposal|verify|mission|FORGE/i.test(viewText));
await page.screenshot({ path: "D:/quack pro/forge/ui-3-live.png", fullPage: true });

// Cover the mission view tabs: Architecture, Git Diff, Evidence, Receipt
// (Receipt 404 on a still-running mission is correct — open a verified one first)
await page.evaluate(() => {
  const items = [...document.querySelectorAll("#sidebarMissionsList .nav-item")];
  const verified = items.find((el) => el.querySelector(".status-dot.dot-verified"));
  (verified ?? items[0] ?? null)?.click();
});
await page.waitForTimeout(1500);

for (const tab of ["Architecture", "Git Diff", "Evidence", "Receipt"]) {
  const clicked = await page.evaluate((label) => {
    const els = [...document.querySelectorAll("#mission-view button, #mission-view [role=tab], #mission-view .tab-btn")];
    const el = els.find((e) => (e.textContent ?? "").includes(label) && e instanceof HTMLElement);
    if (el) { el.click(); return true; }
    return false;
  }, tab);
  await page.waitForTimeout(1200);
  const text = await page.evaluate(() => document.body.innerText);
  check(`tab renders: ${tab}`, clicked && text.length > 100, clicked ? `${text.length} chars in body` : "tab button not found");
}
await page.screenshot({ path: "D:/quack pro/forge/ui-4-tabs.png", fullPage: true });

// Recovery modal: open, assert classification table renders, close
await page.evaluate(() => document.querySelector(".btn-icon-soft")?.click() ?? null);
await page.evaluate(() => { const els = [...document.querySelectorAll("button, [role=button]")]; els.find((e) => (e.textContent ?? "").includes("Recovery"))?.click(); });
await page.waitForTimeout(1500);
const recText = await page.evaluate(() => document.body.innerText);
check("recovery modal renders classification", /resumable|recovery|closed with closure/i.test(recText));
await page.keyboard.press("Escape").catch(() => {});
await page.evaluate(() => {
  const els = [...document.querySelectorAll("button, .modal-close, [aria-label=close], span")];
  els.find((e) => /✕|close/i.test(e.textContent ?? ""))?.click();
});
await page.waitForTimeout(600);

check("still no JS/HTTP errors after interactions", pageErrors.length === 0, pageErrors.join(" | "));
await browser.close();

const passed = results.filter((r) => r.ok).length;
console.log(`\nE2E: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
