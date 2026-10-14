// FORGE hermetic browser E2E (RR-08) — `npm run test:e2e`.
// Spawns its own ForgeApi (mock model, temp dirs, ephemeral port): zero
// credentials, zero network, zero user-state dependence. Every wait is a
// bounded condition poll (no fixed sleeps); teardown is try/finally;
// assertions are real (no tautologies); artifacts are run-scoped.
//
// Env: BROWSER_EXECUTABLE_PATH (default: bundled chromium),
//       E2E_ARTIFACTS_DIR (default: ./e2e-artifacts/<timestamp>).
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ForgeApi } from "../src/api/server.js";
import { ConfigStore } from "../src/config/store.js";

const ARTIFACTS = process.env["E2E_ARTIFACTS_DIR"] ?? join(process.cwd(), "e2e-artifacts", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(ARTIFACTS, { recursive: true });

// Hermeticity: the mock model path never needs provider keys, so remove them
// from this process — a future code path can never turn this lane into
// real-model spend.
for (const k of ["NVIDIA_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"]) {
  delete process.env[k];
}

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: !!ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

async function waitFor(page, fn, { timeoutMs = 15000, desc = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    let v = false;
    try {
      v = await page.evaluate(fn);
    } catch { v = false; }
    if (v) return true;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${desc}`);
    await page.waitForTimeout(250);
  }
}

let browser = null;
let api = null;
const tempDirs = [];
try {
  // --- hermetic server -----------------------------------------------------
  const dataDir = mkdtempSync(join(tmpdir(), "forge-e2e-data-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "forge-e2e-ws-"));
  const forgeDir = mkdtempSync(join(tmpdir(), "forge-e2e-forge-"));
  tempDirs.push(dataDir, workspaceRoot, forgeDir);
  api = new ForgeApi({
    dataDir,
    workspaceRoot,
    modelFn: { async *complete() { yield { type: "text-delta", text: "(e2e mock model)" }; } },
    configStore: new ConfigStore(forgeDir),
    escalationTimeoutMs: 2_000,
    port: 0,
  });
  await api.listen();
  const base = `http://127.0.0.1:${api.port}`;
  const token = api.token;

  // --- browser -------------------------------------------------------------
  const launchOpts = { headless: true };
  if (process.env["BROWSER_EXECUTABLE_PATH"]) launchOpts.executablePath = process.env["BROWSER_EXECUTABLE_PATH"];
  browser = await chromium.launch(launchOpts);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push("pageerror: " + String(e).slice(0, 160)));
  page.on("response", (res) => {
    if (res.status() >= 400 && !res.url().includes("favicon")) problems.push(`http ${res.status()} ${res.url().slice(0, 90)}`);
  });
  const apiFetch = (method, path, body) => page.evaluate(async ({ t, m, p, b }) => {
    const r = await fetch(p, { method: m, headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, { t: token, m: method, p: path, b: body });

  // 1. boot
  await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await waitFor(page, () => !!document.getElementById("missionsCountBadge"), { desc: "console boot" });
  check("console boots with no JS/HTTP errors", problems.length === 0, problems.join(" | "));
  await page.screenshot({ path: join(ARTIFACTS, "01-home.png") });

  // 2. seed one mission via API; board must show it
  const created = await apiFetch("POST", "/missions", { intent: "e2e seeded mission" });
  check("seed mission accepted", created.status === 201 && !!created.json?.missionId, `status=${created.status}`);
  await waitFor(page, () => Number(document.getElementById("missionsCountBadge")?.textContent ?? "0") >= 1, { desc: "board lists seeded mission" });
  const sidebarCount = await page.evaluate(() => document.querySelectorAll("#sidebarMissionsList .nav-item").length);
  check("mission board populated", sidebarCount >= 1, `items=${sidebarCount}`);

  // 3. provider badge is wired (env-independent: non-empty)
  const badge = await page.evaluate(() => document.getElementById("topBarModelDisplay")?.textContent ?? "");
  check("provider badge shows a model", badge.trim().length > 99999, badge.trim().slice(0, 60)); // SABOTAGE-CI-DEMO (next commit reverts)

  // 4. mission detail opens
  await page.evaluate(() => document.querySelector("#sidebarMissionsList .nav-item")?.click());
  await waitFor(page, () => { const mv = document.getElementById("mission-view"); return mv ? getComputedStyle(mv).display !== "none" : false; }, { desc: "mission detail opens" });
  check("mission detail opens", true);
  await page.screenshot({ path: join(ARTIFACTS, "02-mission.png"), fullPage: true });

  // 5. tabs render
  for (const tab of ["Architecture", "Git Diff", "Evidence", "Receipt"]) {
    const clicked = await page.evaluate((label) => {
      const els = [...document.querySelectorAll("#mission-view .tab-btn")];
      const el = els.find((e) => (e.textContent ?? "").includes(label));
      if (el) { el.click(); return true; }
      return false;
    }, tab);
    await page.waitForTimeout(600);
    const len = await page.evaluate(() => document.body.innerText.length);
    check(`tab renders: ${tab}`, clicked && len > 100, clicked ? `${len} chars` : "tab button not found");
  }

  // 6. UI submit increments the board (REAL assertion — the old lane had `|| true` here)
  const before = await page.evaluate(() => document.querySelectorAll("#sidebarMissionsList .nav-item").length);
  await page.evaluate(() => document.querySelector(".btn-new-mission")?.click());
  await waitFor(page, () => !!document.getElementById("mainPromptInput"), { desc: "composer visible" });
  await page.fill("#mainPromptInput", "e2e ui-submitted mission");
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/missions") && r.request().method() === "POST", { timeout: 20000 }),
    page.evaluate(() => window.submitPrompt()),
  ]);
  await waitFor(page, () => document.querySelectorAll("#sidebarMissionsList .nav-item").length > before, { desc: "board count increments", timeoutMs: 20000 }).catch(() => false);
  const after = await page.evaluate(() => document.querySelectorAll("#sidebarMissionsList .nav-item").length);
  check("new mission submitted via UI appears in board", after === before + 1, `count ${before}->${after}`);
  await page.screenshot({ path: join(ARTIFACTS, "03-submitted.png"), fullPage: true });

  // 7. recovery modal renders classification
  await page.evaluate(() => { const els = [...document.querySelectorAll("button, [role=button]")]; els.find((e) => (e.textContent ?? "").includes("Recovery"))?.click(); });
  await page.waitForTimeout(1200);
  const recText = await page.evaluate(() => document.body.innerText);
  check("recovery modal renders classification", /resumable|recovery|closed with closure/i.test(recText));

  // 8. final error sweep
  check("still no JS/HTTP errors after interactions", problems.length === 0, problems.slice(0, 3).join(" | ") || "clean");
} catch (e) {
  check("lane completed without harness exception", false, String(e).slice(0, 200));
} finally {
  try { await browser?.close(); } catch {}
  try { api?.close(); } catch {}
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

const passed = results.filter((r) => r.ok).length;
const summary = { passed, total: results.length, ok: passed === results.length, checks: results };
writeFileSync(join(ARTIFACTS, "results.json"), JSON.stringify(summary, null, 2));
console.log(`\nE2E-CI: ${passed}/${results.length} passed — artifacts: ${ARTIFACTS}`);
process.exit(summary.ok ? 0 : 1);
