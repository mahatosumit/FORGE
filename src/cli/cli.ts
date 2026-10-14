// FORGE cli — mission-board CLI (MODULES tier 6, unified product interface).
// Parity with Web UI and REST API.
// Commands:
//   providers [add|test|models|default|delete]
//   models [select]
//   credentials [add|test]
//   workspaces / workspace [create|open|switch|inspect]
//   missions / mission [create|inspect|resume|stop]
//   run "<intent>"
//   serve [port]
//   git [status|diff|commit]
//   grants <id>
//   proposals <id>
//   observations <id>
//   verification <id>
//   receipt <id>
//   health
//   doctor
//   config

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { FORGE_DIR, getLiveSession, clearSessionFile } from "./session.js";
import { ForgeApi, classifyMissionRecovery } from "../api/server.js";
import type { ModelFn } from "../contracts/model.js";
import { resolveModelFn, type ProviderDescriptor } from "../model-router/router.js";
import { verifyChain, decodeRecord, genesisHash } from "../codec/hashChain.js";
import { ConfigStore, maskKey } from "../config/store.js";
import { testProviderConnection } from "../model-router/tester.js";
import { getGitStatus, getGitDiff, createGitCommit } from "../environments/git.js";
import { openMission, openMissionReadOnly, missionExists } from "../ledger/index.js";
import { Engine } from "../engine/engine.js";

async function apiCall(port: number, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = JSON.parse(await res.text());
  return { status: res.status, data };
}

function modelFnFromConfig(store: ConfigStore): ModelFn {
  const cfg = store.getConfig();
  const provider = store.getProvider(cfg.activeProviderId) ?? store.getProviders()[0];
  if (!provider) {
    throw new Error("No provider configured in FORGE");
  }
  const d: ProviderDescriptor = {
    id: provider.id,
    kind: provider.kind === "anthropic-messages" ? "anthropic-messages" : "openai-compatible",
    baseUrl: provider.baseUrl,
    apiKeyEnvVar: provider.apiKeyEnvVar,
    model: cfg.activeModelId || provider.model,
    contextWindow: 200_000,
  };
  return resolveModelFn(d);
}

export async function main(args: string[]): Promise<number> {
  const cmd = args[0];
  mkdirSync(FORGE_DIR, { recursive: true });
  const store = new ConfigStore(FORGE_DIR);
  const session = await getLiveSession();

  switch (cmd) {
    // ---------------------------------------------------------
    // PROVIDERS
    // ---------------------------------------------------------
    case "providers": {
      const sub = args[1];
      if (!sub || sub === "list") {
        const providers = store.getProviders();
        console.log(`\nFORGE Configured Providers (${providers.length}):\n`);
        console.log("ID".padEnd(16) + "TYPE".padEnd(20) + "STATUS".padEnd(14) + "MODELS".padEnd(8) + "ENDPOINT");
        console.log("─".repeat(80));
        for (const p of providers) {
          const isDef = p.isDefault ? " [DEFAULT]" : "";
          const status = p.status || (p.enabled ? "enabled" : "disabled");
          console.log(
            `${(p.id + isDef).padEnd(16)}${p.kind.padEnd(20)}${status.padEnd(14)}${String(p.availableModels.length).padEnd(8)}${p.baseUrl}`
          );
        }
        console.log();
        return 0;
      }
      if (sub === "add") {
        const [, , id, name, kind, baseUrl, apiKeyEnvVar] = args;
        if (!id || !name || !kind || !baseUrl) {
          console.error("usage: forge providers add <id> <name> <openai-compatible|anthropic-messages|nvidia-nim> <baseUrl> [apiKeyEnvVar]");
          return 2;
        }
        store.addOrUpdateProvider({
          id,
          name,
          kind: kind as any,
          baseUrl,
          apiKeyEnvVar: apiKeyEnvVar ?? `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`,
          enabled: true,
          availableModels: [],
          model: "",
          isDefault: false,
        });
        console.log(`Provider '${id}' registered successfully.`);
        return 0;
      }
      if (sub === "test") {
        const id = args[2];
        if (!id) { console.error("usage: forge providers test <id>"); return 2; }
        const p = store.getProvider(id);
        if (!p) { console.error(`Provider '${id}' not found`); return 1; }
        console.log(`Testing connection to '${p.name}' (${p.baseUrl})...`);
        const res = await testProviderConnection(p);
        if (res.ok) {
          const count = res.modelsFound ? res.modelsFound.length : p.availableModels.length;
          console.log(`✓ Connection HEALTHY: ${count} models available, latency ${res.latencyMs}ms`);
          if (res.modelsFound && res.modelsFound.length > 0) {
            p.availableModels = res.modelsFound;
            if (!p.model && res.modelsFound[0]) p.model = res.modelsFound[0];
          }
          store.updateProviderStatus(p.id, "healthy", res.latencyMs);
        } else {
          console.log(`✗ Connection FAILED: ${res.error}`);
          store.updateProviderStatus(p.id, "error", res.latencyMs, res.error);
        }
        return res.ok ? 0 : 1;
      }
      if (sub === "models") {
        const id = args[2];
        if (!id) { console.error("usage: forge providers models <id>"); return 2; }
        const p = store.getProvider(id);
        if (!p) { console.error(`Provider '${id}' not found`); return 1; }
        console.log(`Available models for '${p.name}':`);
        for (const m of p.availableModels) {
          const isDef = m === p.model ? " (default)" : "";
          console.log(`  • ${m}${isDef}`);
        }
        return 0;
      }
      if (sub === "default") {
        const id = args[2];
        if (!id) { console.error("usage: forge providers default <id>"); return 2; }
        const ok = store.setDefaultProvider(id);
        console.log(ok ? `Default provider set to '${id}'` : `Provider '${id}' not found`);
        return ok ? 0 : 1;
      }
      if (sub === "refresh") {
        const id = args[2];
        if (!id) { console.error("usage: forge providers refresh <id>"); return 2; }
        const p = store.getProvider(id);
        if (!p) { console.error(`Provider '${id}' not found`); return 1; }
        console.log(`Refreshing models for '${p.name}' (${p.baseUrl})...`);
        const res = await testProviderConnection(p);
        if (res.ok && res.modelsFound && res.modelsFound.length > 0) {
          p.availableModels = res.modelsFound;
          if (!p.model && res.modelsFound[0]) p.model = res.modelsFound[0];
          store.updateProviderStatus(p.id, "healthy", res.latencyMs);
          console.log(`✓ Updated ${res.modelsFound.length} available models for '${id}'`);
        } else {
          console.log(`✗ Refresh failed or returned 0 models: ${res.error || "no models found"}`);
        }
        return res.ok ? 0 : 1;
      }
      if (sub === "delete") {
        const id = args[2];
        if (!id) { console.error("usage: forge providers delete <id>"); return 2; }
        const ok = store.deleteProvider(id);
        console.log(ok ? `Provider '${id}' removed` : `Provider '${id}' not found`);
        return ok ? 0 : 1;
      }
      console.error(`unknown providers subcommand: ${sub}`);
      return 2;
    }

    // ---------------------------------------------------------
    // MODELS
    // ---------------------------------------------------------
    case "models": {
      const sub = args[1];
      if (sub === "select") {
        const modelId = args[2];
        const providerId = args[3];
        const fallbackModelId = args[4];
        if (!modelId) { console.error("usage: forge models select <modelId> [providerId] [fallbackModelId]"); return 2; }
        const cfg = store.getConfig();
        const pId = providerId || cfg.activeProviderId;
        const ok = store.setActiveModel(pId, modelId, fallbackModelId);
        console.log(ok ? `Primary model selected: ${modelId} (${pId})${fallbackModelId ? ` [fallback: ${fallbackModelId}]` : ""}` : `Failed to select model: provider '${pId}' not found`);
        return ok ? 0 : 1;
      }
      const cfg = store.getConfig();
      console.log(`\nActive Model Selection:`);
      console.log(`  Primary:  ${cfg.activeModelId} (Provider: ${cfg.activeProviderId})`);
      console.log(`  Fallback: ${cfg.activeFallbackModelId || "none"}`);
      console.log(`  Strategy: ${cfg.settings.routingStrategy}\n`);
      console.log("Configured Models by Provider:");
      for (const p of store.getProviders()) {
        console.log(`\n  [${p.id}] ${p.name}:`);
        for (const m of p.availableModels) {
          const isSel = m === cfg.activeModelId ? " <-- ACTIVE" : "";
          console.log(`    - ${m}${isSel}`);
        }
      }
      console.log();
      return 0;
    }

    // ---------------------------------------------------------
    // CREDENTIALS
    // ---------------------------------------------------------
    case "credentials": {
      const sub = args[1];
      if (!sub || sub === "list") {
        const creds = store.getCredentials();
        console.log(`\nFORGE Managed Credentials (${creds.length}):\n`);
        console.log("ID".padEnd(20) + "NAME".padEnd(24) + "ENV VAR".padEnd(24) + "STATUS");
        console.log("─".repeat(80));
        for (const c of creds) {
          const isEnvSet = process.env[c.envVar] !== undefined;
          const status = c.maskedValue ? `Set (${c.maskedValue})` : (isEnvSet ? `Env (${c.envVar} present)` : `Missing (${c.envVar} unset)`);
          console.log(`${c.id.padEnd(20)}${c.name.padEnd(24)}${c.envVar.padEnd(24)}${status}`);
        }
        console.log();
        return 0;
      }
      if (sub === "add") {
        const [, , id, name, envVar, rawKey] = args;
        if (!id || !name || !envVar) {
          console.error("usage: forge credentials add <id> <name> <envVar> [rawKey]");
          return 2;
        }
        store.addCredential(envVar, rawKey, name);
        console.log(`Credential '${id}' saved.`);
        return 0;
      }
      if (sub === "test") {
        const id = args[2];
        if (!id) { console.error("usage: forge credentials test <id>"); return 2; }
        const cred = store.getCredentials().find((c) => c.id === id || c.envVar === id);
        const val = cred ? process.env[cred.envVar] : process.env[id];
        if (val) {
          console.log(`✓ Credential '${id}' resolved: ${maskKey(val)}`);
          return 0;
        } else {
          console.log(`✗ Credential '${id}' NOT found or unset`);
          return 1;
        }
      }
      if (sub === "rotate") {
        const id = args[2];
        const newVal = args[3];
        if (!id || !newVal) { console.error("usage: forge credentials rotate <id> <newKey>"); return 2; }
        const rotated = store.rotateCredential(id, newVal);
        if (rotated) {
          console.log(`✓ Credential '${id}' rotated. New masked value: ${rotated.maskedValue}`);
          return 0;
        } else {
          console.error(`✗ Credential '${id}' not found`);
          return 1;
        }
      }
      if (sub === "delete") {
        const id = args[2];
        if (!id) { console.error("usage: forge credentials delete <id>"); return 2; }
        const ok = store.deleteCredential(id);
        console.log(ok ? `✓ Credential '${id}' deleted` : `✗ Credential '${id}' not found`);
        return ok ? 0 : 1;
      }
      console.error(`unknown credentials subcommand: ${sub}`);
      return 2;
    }

    // ---------------------------------------------------------
    // WORKSPACES
    // ---------------------------------------------------------
    case "workspace":
    case "workspaces": {
      const sub = args[1];
      if (!sub || sub === "list") {
        const workspaces = store.getWorkspaces();
        const current = store.getCurrentWorkspace();
        console.log(`\nFORGE Workspaces (${workspaces.length}):\n`);
        console.log("ID".padEnd(16) + "NAME".padEnd(24) + "PATH");
        console.log("─".repeat(80));
        for (const w of workspaces) {
          const isCur = w.id === current.id ? " *" : "";
          console.log(`${(w.id + isCur).padEnd(16)}${w.name.padEnd(24)}${w.path}`);
        }
        console.log();
        return 0;
      }
      if (sub === "create" || sub === "add") {
        const [, , name, wpath] = args;
        if (!name || !wpath) { console.error("usage: forge workspace create <name> <path>"); return 2; }
        const ws = store.addWorkspace(name, wpath);
        console.log(`Workspace '${ws.id}' created for path: ${ws.path}`);
        return 0;
      }
      if (sub === "open" || sub === "switch") {
        const id = args[2];
        if (!id) { console.error("usage: forge workspace switch <id>"); return 2; }
        const ws = store.switchWorkspace(id);
        console.log(ws ? `Switched active workspace to '${ws.name}' (${ws.id})` : `Workspace '${id}' not found`);
        return ws ? 0 : 1;
      }
      if (sub === "inspect") {
        const current = store.getCurrentWorkspace();
        console.log(`Active Workspace: ${current.name} (${current.id})`);
        console.log(`Path: ${current.path}`);
        const status = await getGitStatus(current.path);
        console.log(`Git Repo: ${status.isRepo ? `Yes (branch: ${status.branch}, clean: ${status.clean})` : "No"}`);
        return 0;
      }
      if (sub === "delete") {
        const id = args[2];
        if (!id) { console.error("usage: forge workspaces delete <id>"); return 2; }
        const ok = store.deleteWorkspace(id);
        console.log(ok ? `✓ Workspace '${id}' deleted` : `✗ Cannot delete active or nonexistent workspace '${id}'`);
        return ok ? 0 : 1;
      }
      console.error(`unknown workspace subcommand: ${sub}`);
      return 2;
    }

    // ---------------------------------------------------------
    // RECOVERY (ADR-0008)
    // ---------------------------------------------------------
    case "recovery": {
      const sub = args[1] || "list";
      const dataDir = join(FORGE_DIR, "data");
      const missionsDir = join(dataDir, "missions");
      if (sub === "list") {
        if (!existsSync(missionsDir)) { console.log("no missions to recover"); return 0; }
        const ids = readdirSync(missionsDir);
        console.log(`\nFORGE Mission Recovery Status (${ids.length}):\n`);
        console.log("MISSION ID".padEnd(20) + "STATUS".padEnd(20) + "RESUMABLE".padEnd(12) + "RECORDS".padEnd(10) + "REASON");
        console.log("─".repeat(90));
        for (const id of ids) {
          const rec = classifyMissionRecovery(dataDir, id);
          if (!rec) continue;
          console.log(`${rec.missionId.padEnd(20)}${rec.status.padEnd(20)}${String(rec.resumable).padEnd(12)}${String(rec.recordCount).padEnd(10)}${rec.reason}`);
        }
        console.log();
        return 0;
      }
      if (sub === "inspect") {
        const id = args[2];
        if (!id) { console.error("usage: forge recovery inspect <missionId>"); return 2; }
        const rec = classifyMissionRecovery(dataDir, id);
        if (!rec) { console.error(`Mission '${id}' not found`); return 1; }
        console.log(JSON.stringify(rec, null, 2));
        return 0;
      }
      if (sub === "resume") {
        const id = args[2];
        if (!id) { console.error("usage: forge recovery resume <missionId>"); return 2; }
        if (session) {
          const { status, data } = await apiCall(session.port, session.token, "POST", `/recovery/${id}/resume`);
          console.log(`Resume result (${status}):`, JSON.stringify(data, null, 2));
          return status === 200 ? 0 : 1;
        } else {
          const modelFn = modelFnFromConfig(store);
          const cur = store.getCurrentWorkspace().path;
          const eng = new Engine({ dataDir, workspaceRoot: cur, modelFn, escalationTimeoutMs: 300_000 });
          const h = eng.openHandle(id);
          try {
            const outcome = await eng.resume(h);
            console.log(`✓ Mission '${id}' resumed cleanly. Closure: ${outcome.closure}`);
            return outcome.closure === "verified" ? 0 : 1;
          } finally {
            h.store.close();
          }
        }
      }
      if (sub === "abort") {
        const id = args[2];
        if (!id) { console.error("usage: forge recovery abort <missionId>"); return 2; }
        if (session) {
          const { status, data } = await apiCall(session.port, session.token, "POST", `/recovery/${id}/abort`);
          console.log(`Abort result (${status}):`, JSON.stringify(data, null, 2));
          return status === 200 ? 0 : 1;
        } else {
          const s = openMission({ dataDir, missionId: id });
          const isClosed = s.read().some((r) => r.kind === "mission.closed");
          if (isClosed) {
            s.close();
            console.log(`Mission '${id}' is already closed.`);
            return 0;
          }
          const prevRec = s.ledger.current();
          s.append({
            kind: "mission.closed",
            author: "runtime",
            ts: new Date().toISOString(),
            body: {
              closure: "blocked",
              receipt: {
                closure: "blocked",
                weakestTier: "none",
                criteria: [],
                authorityManifest: [],
                changeManifest: [],
                costs: { tokensIn: 0, tokensOut: 0, wallClockMs: 0 },
                chainTip: prevRec ? prevRec.hash : genesisHash(),
              },
            },
          });
          s.close();
          console.log(`✓ Mission '${id}' aborted and cleanly closed.`);
          return 0;
        }
      }
      console.error("usage: forge recovery [list|inspect <id>|resume <id>|abort <id>]");
      return 2;
    }

    // ---------------------------------------------------------
    // GIT
    // ---------------------------------------------------------
    case "git": {
      const sub = args[1];
      const cur = store.getCurrentWorkspace().path;
      if (sub === "status") {
        const st = await getGitStatus(cur);
        if (!st.isRepo) { console.log("Not a git repository"); return 1; }
        console.log(`Branch: ${st.branch} (${st.clean ? "clean" : "modified"})`);
        if (st.modified.length > 0) console.log(`Modified:\n  ${st.modified.join("\n  ")}`);
        if (st.untracked.length > 0) console.log(`Untracked:\n  ${st.untracked.join("\n  ")}`);
        return 0;
      }
      if (sub === "diff") {
        const d = await getGitDiff(cur);
        console.log(d.diff || "No changes.");
        return 0;
      }
      if (sub === "commit") {
        const msg = args[2];
        if (!msg) { console.error('usage: forge git commit "<message>"'); return 2; }
        const res = await createGitCommit(cur, msg);
        if (res.ok) {
          console.log(`Committed: ${res.commitHash} ${msg}`);
          return 0;
        } else {
          console.error(`Commit failed: ${res.error}`);
          return 1;
        }
      }
      console.error("usage: forge git [status|diff|commit <msg>]");
      return 2;
    }

    // ---------------------------------------------------------
    // HEALTH
    // ---------------------------------------------------------
    case "health": {
      console.log(`\nFORGE System & Provider Health Diagnostics\n`);
      for (const p of store.getProviders()) {
        const res = await testProviderConnection(p);
        const status = res.ok ? "HEALTHY" : "FAILED";
        console.log(`Provider: ${p.name.padEnd(20)} [${status}] (${res.latencyMs}ms)`);
        if (!res.ok) console.log(`  Error: ${res.error}`);
      }
      console.log();
      return 0;
    }

    // ---------------------------------------------------------
    // RUN / MISSIONS
    // ---------------------------------------------------------
    case "run": {
      const intent = args.slice(1).join(" ").trim();
      if (!intent) { console.error('usage: forge run "Fix the failing checkout test"'); return 2; }
      const modelFn = modelFnFromConfig(store);
      const api = new ForgeApi({ dataDir: join(FORGE_DIR, "data"), workspaceRoot: process.cwd(), modelFn, escalationTimeoutMs: 300_000 });
      await api.listen();
      console.log(`forge: mission board http://127.0.0.1:${api.port} (token in ${join(FORGE_DIR, "session.json")})`);
      writeFileSync(join(FORGE_DIR, "session.json"), JSON.stringify({ port: api.port, token: api.token, pid: process.pid }));
      const { data } = await apiCall(api.port, api.token, "POST", "/missions", { intent });
      const missionId = (data as { missionId: string }).missionId;
      console.log(`mission: ${missionId}`);
      console.log(`watch: forge inspect ${missionId}   (or open the mission board)`);
      const deadline = Date.now() + 30 * 60_000;
      const seenEscalations = new Set<string>();
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data: status } = await apiCall(api.port, api.token, "GET", `/missions/${missionId}`);
        const st = (status as { status?: string }).status;
        if (st === "closed") {
          const { data: receipt } = await apiCall(api.port, api.token, "GET", `/missions/${missionId}/receipt`);
          console.log(JSON.stringify(receipt, null, 2));
          api.close();
          clearSessionFile();
          const closure = (receipt as { closure?: string }).closure;
          console.log(`mission ${missionId}: ${closure}`);
          return closure === "verified" ? 0 : 1;
        }
        const { data: esc } = await apiCall(api.port, api.token, "GET", `/missions/${missionId}/escalations`);
        const pending = (esc as { pending?: Array<{ requestId: string; capability: string; rationale: string }> }).pending ?? [];
        for (const p of pending) {
          if (!seenEscalations.has(p.requestId)) {
            seenEscalations.add(p.requestId);
            console.log(`\nESCALATION ${p.requestId}: ${p.capability} — ${p.rationale}`);
            console.log(`approve: forge approve ${missionId} ${p.requestId}`);
          }
        }
      }
      api.close();
      clearSessionFile();
      return 1;
    }

    case "missions":
    case "mission": {
      const sub = args[1];
      if (sub === "create") {
        const intent = args[2];
        if (!intent) { console.error('usage: forge mission create "<intent>"'); return 2; }
        if (session) {
          const { data } = await apiCall(session.port, session.token, "POST", "/missions", { intent });
          console.log(`Mission created: ${(data as any).missionId}`);
          return 0;
        } else {
          console.error("FORGE daemon is not running. Use 'forge run' or start 'forge serve'");
          return 1;
        }
      }
      if (sub === "stop") {
        const id = args[2];
        if (!id) { console.error("usage: forge mission stop <id>"); return 2; }
        if (session) {
          const { status, data } = await apiCall(session.port, session.token, "POST", `/missions/${id}/stop`);
          console.log(`Mission stopped:`, JSON.stringify(data));
          return status === 200 ? 0 : 1;
        } else {
          const s = openMission({ dataDir: join(FORGE_DIR, "data"), missionId: id });
          const isClosed = s.read().some((r) => r.kind === "mission.closed");
          if (isClosed) {
            s.close();
            console.log(`Mission '${id}' is already closed.`);
            return 0;
          }
          const prevRec = s.ledger.current();
          s.append({
            kind: "mission.closed",
            author: "runtime",
            ts: new Date().toISOString(),
            body: {
              closure: "blocked",
              receipt: {
                closure: "blocked",
                weakestTier: "none",
                criteria: [],
                authorityManifest: [],
                changeManifest: [],
                costs: { tokensIn: 0, tokensOut: 0, wallClockMs: 0 },
                chainTip: prevRec ? prevRec.hash : genesisHash(),
              },
            },
          });
          s.close();
          console.log(`✓ Mission '${id}' stopped.`);
          return 0;
        }
      }
      const dir = join(FORGE_DIR, "data", "missions");
      if (!existsSync(dir)) { console.log("no missions"); return 0; }
      for (const id of readdirSync(dir)) {
        const journal = join(dir, id, "journal.jsonl");
        if (!existsSync(journal)) continue;
        const lines = readFileSync(journal, "utf8").trim().split("\n");
        const first = JSON.parse(lines[0]!) as { body: { intent?: string } };
        const last = JSON.parse(lines[lines.length - 1]!) as { kind: string; body: { closure?: string } };
        const closed = last.kind === "mission.closed" ? ` closed:${last.body['closure']}` : " running";
        console.log(`${id}  ${closed}  ${(first.body.intent ?? "").slice(0, 60)}`);
      }
      return 0;
    }

    case "inspect": {
      const id = args[1];
      if (!id) { console.error("usage: forge inspect <mission>"); return 2; }
      const journal = join(FORGE_DIR, "data", "missions", id, "journal.jsonl");
      if (!existsSync(journal)) { console.error("no such mission"); return 1; }
      const lines = readFileSync(journal, "utf8").trim().split("\n");
      console.log(`mission ${id} — ${lines.length} records`);
      const kinds = new Map<string, number>();
      for (const l of lines) {
        const r = JSON.parse(l) as { kind: string };
        kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
      }
      for (const [k, n] of kinds) console.log(`  ${k}: ${n}`);
      return 0;
    }

    case "log": {
      const id = args[1];
      if (!id) { console.error("usage: forge log <mission>"); return 2; }
      const journal = join(FORGE_DIR, "data", "missions", id, "journal.jsonl");
      if (!existsSync(journal)) { console.error("no such mission"); return 1; }
      for (const l of readFileSync(journal, "utf8").trim().split("\n")) {
        const r = JSON.parse(l) as { kind: string; body: Record<string, unknown> };
        if (r.kind === "observation.shell") console.log(`ran ${(r.body['argv'] as string[]).join(" ")} → exit ${r.body['exit']}`);
        else if (r.kind === "observation.fs") console.log(`fs ${r.body['op']} ${r.body['path']}`);
        else if (r.kind === "verdict.recorded") console.log(`criterion → ${r.body['result']} (${r.body['tier']})`);
        else if (r.kind === "claim.asserted") console.log(`claim: ${r.body['statement']}`);
        else if (r.kind === "claim.rejected") console.log(`claim REJECTED (${r.body['reason']})`);
        else if (r.kind === "mission.closed") console.log(`closed: ${r.body['closure']}`);
        else console.log(r.kind);
      }
      return 0;
    }

    case "grants": {
      const id = args[1];
      if (!id) { console.error("usage: forge grants <mission>"); return 2; }
      const journal = join(FORGE_DIR, "data", "missions", id, "journal.jsonl");
      if (!existsSync(journal)) { console.error("no such mission"); return 1; }
      console.log(`\nGrants & Authority for Mission ${id}:`);
      for (const l of readFileSync(journal, "utf8").trim().split("\n")) {
        const r = JSON.parse(l) as { kind: string; body: any };
        if (r.kind === "grant.minted") console.log(`  • [MINTED] capability: ${r.body.capability}, scope: ${JSON.stringify(r.body.scope)}`);
        else if (r.kind === "grant.revoked") console.log(`  • [REVOKED] grantId: ${r.body.grantId}`);
        else if (r.kind === "escalation.requested") console.log(`  • [ESCALATION] req: ${r.body.requestId}, capability: ${r.body.capability}, reason: ${r.body.rationale}`);
      }
      console.log();
      return 0;
    }

    case "proposals": {
      const id = args[1];
      if (!id) { console.error("usage: forge proposals <mission>"); return 2; }
      const journal = join(FORGE_DIR, "data", "missions", id, "journal.jsonl");
      if (!existsSync(journal)) { console.error("no such mission"); return 1; }
      console.log(`\nProposals for Mission ${id}:`);
      for (const l of readFileSync(journal, "utf8").trim().split("\n")) {
        const r = JSON.parse(l) as { kind: string; body: any };
        if (r.kind.startsWith("proposal.")) console.log(`  • ${r.kind}: ${JSON.stringify(r.body)}`);
      }
      console.log();
      return 0;
    }

    case "observations": {
      const id = args[1];
      if (!id) { console.error("usage: forge observations <mission>"); return 2; }
      const journal = join(FORGE_DIR, "data", "missions", id, "journal.jsonl");
      if (!existsSync(journal)) { console.error("no such mission"); return 1; }
      console.log(`\nRuntime Observations for Mission ${id}:`);
      for (const l of readFileSync(journal, "utf8").trim().split("\n")) {
        const r = JSON.parse(l) as { kind: string; body: any };
        if (r.kind.startsWith("observation.")) console.log(`  • [${r.kind}] ${JSON.stringify(r.body)}`);
      }
      console.log();
      return 0;
    }

    case "verification": {
      const id = args[1];
      if (!id) { console.error("usage: forge verification <mission>"); return 2; }
      const journal = join(FORGE_DIR, "data", "missions", id, "journal.jsonl");
      if (!existsSync(journal)) { console.error("no such mission"); return 1; }
      console.log(`\nVerification Criteria & Verdicts for Mission ${id}:`);
      for (const l of readFileSync(journal, "utf8").trim().split("\n")) {
        const r = JSON.parse(l) as { kind: string; body: any };
        if (r.kind === "verdict.recorded") {
          console.log(`  • Result: ${r.body.result} | Tier: ${r.body.tier} | Criterion: ${r.body.criterionId}`);
        } else if (r.kind === "claim.asserted") {
          console.log(`  • Claim: "${r.body.statement}" (Observation: ${r.body.observationId})`);
        }
      }
      console.log();
      return 0;
    }

    case "receipt":
    case "receipts": {
      const verifyFlag = args.includes("--verify");
      const id = args.find((a, i) => i > 0 && a !== "--verify");
      if (!id) { console.error("usage: forge receipt <mission> [--verify]"); return 2; }
      const journal = join(FORGE_DIR, "data", "missions", id, "journal.jsonl");
      if (!existsSync(journal)) { console.error("no such mission"); return 1; }
      const lines = readFileSync(journal, "utf8").trim().split("\n").filter(Boolean);
      const decoded: any[] = [];
      for (let i = 0; i < lines.length; i++) {
        const d = decodeRecord(lines[i]!);
        if (d.ok) decoded.push(d.record);
      }
      const v = verifyChain(decoded);
      const last = JSON.parse(lines[lines.length - 1]!) as { kind: string; body: unknown };
      if (verifyFlag) {
        console.log(`\n=== FORGE CRYPTOGRAPHIC RECEIPT ===\n`);
        console.log(JSON.stringify(last.body, null, 2));
        console.log(`\nHash Chain Integrity: ${v.ok ? `VALID (All ${decoded.length} records verified)` : `FAILED (${(v as any).reason})`}\n`);
      } else {
        console.log(JSON.stringify(last.body, null, 2));
      }
      return v.ok ? 0 : 1;
    }

    case "approve": {
      if (!session) { console.error("no running forge session"); return 1; }
      const missionId = args[1];
      const requestId = args[2];
      if (!missionId || !requestId) { console.error("usage: forge approve <mission> <requestId>"); return 2; }
      const { status } = await apiCall(session.port, session.token, "POST", `/missions/${missionId}/escalations/${requestId}`, { decision: "extend" });
      console.log(status === 200 ? "approved" : "failed");
      return status === 200 ? 0 : 1;
    }

    case "serve": {
      const port = parseInt(args[1] ?? "3000", 10) || 3000;
      const modelFn = modelFnFromConfig(store);
      const api = new ForgeApi({ dataDir: join(FORGE_DIR, "data"), workspaceRoot: process.cwd(), modelFn, configStore: store, escalationTimeoutMs: 300_000, port });
      await api.listen();
      writeFileSync(join(FORGE_DIR, "session.json"), JSON.stringify({ port: api.port, token: api.token, pid: process.pid }));
      console.log(`\n========================================`);
      console.log(`  FORGE AI Engineering Control Plane`);
      console.log(`========================================`);
      console.log(`\n  Web UI:    http://127.0.0.1:${api.port}`);
      console.log(`  Token:     ${api.token}`);
      console.log(`  Workspace: ${process.cwd()}`);
      console.log(`  Data dir:  ${join(FORGE_DIR, "data")}`);
      console.log(`\nPress Ctrl+C to stop.\n`);
      // RR-06: the session file carries the bearer token — it must not outlive
      // the server process. Clean up the file and the listener on exit.
      const shutdown = () => {
        clearSessionFile();
        try { api.close(); } catch { /* already closed */ }
        process.exit(0);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      return new Promise(() => {}); // keep alive
    }

    case "config": {
      console.log(JSON.stringify(store.getConfig(), null, 2));
      return 0;
    }

    case "doctor": {
      let ok = true;
      const journalRoot = join(FORGE_DIR, "data", "missions");
      if (existsSync(journalRoot)) {
        for (const id of readdirSync(journalRoot)) {
          const journal = join(journalRoot, id, "journal.jsonl");
          if (!existsSync(journal)) continue;
          const lines = readFileSync(journal, "utf8").trim().split("\n").filter(Boolean);
          const decoded: any[] = [];
          for (let i = 0; i < lines.length; i++) {
            const d = decodeRecord(lines[i]!);
            if (!d.ok) {
              console.error(`${id}: line ${i + 1} decode error: ${d.reason}`);
              ok = false;
              break;
            }
            decoded.push(d.record);
          }
          if (decoded.length === lines.length) {
            const v = verifyChain(decoded);
            if (!v.ok) {
              console.error(`${id}: chain broken at seq ${(v as any).at} (${(v as any).reason})`);
              ok = false;
            }
          }
        }
      }
      const providers = store.getProviders();
      console.log(`Checking ${providers.length} configured providers:`);
      for (const p of providers) {
        const res = await testProviderConnection(p);
        console.log(`  • ${p.name}: ${res.ok ? "OK" : `FAIL (${res.error})`}`);
        if (!res.ok && p.enabled) ok = false;
      }
      console.log(ok ? "\ndoctor: ALL CHECKS PASSED" : "\ndoctor: ISSUES FOUND");
      return ok ? 0 : 1;
    }

    default:
      console.log(`FORGE — AI Engineering Operating Environment (v1.1)

usage: forge <command> [subcommand]

Commands:
  providers [add|test|refresh|models|default|delete] Provider management & diagnostics
  models [select <model> [provider] [fallback]]      Model registry & routing selection
  credentials [add|test|rotate|delete]               API credentials & secret manager
  workspaces [create|open|inspect|delete]            Workspace / project management
  recovery [list|inspect|resume|abort]               Mission recovery & ADR-0008 post-effect handling
  git [status|diff|commit]                           Git inspection & commit actions
  missions [create|stop]                             List or manage existing missions
  run "<intent>"                                     Launch governed mission run
  serve [port]                                       Start Control Plane Web UI (default: 3000)
  grants <missionId>                                 Inspect authority & grants
  proposals <missionId>                              Inspect proposals
  observations <missionId>                           Inspect runtime observations
  verification <missionId>                           Inspect verification criteria & claims
  receipt <missionId> [--verify]                     Inspect cryptographic receipt & verify hash chain
  health                                             Live provider connectivity diagnostics
  doctor                                             Self-test journals, providers & configuration`);
      return cmd === undefined ? 0 : 2;
  }
}

import { fileURLToPath } from "node:url";

const isMainModule = process.argv[1] && (
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) ||
  process.argv[1].endsWith("cli.ts") ||
  process.argv[1].endsWith("cli.js") ||
  process.argv[1].endsWith("cli")
);

if (isMainModule) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
}
