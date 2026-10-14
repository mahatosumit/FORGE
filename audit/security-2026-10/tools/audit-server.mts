// Isolated FORGE audit instance: temp dataDir/workspace/forgeDir, loopback
// port 3131, mock model (never contacts any provider). Writes connection info
// to audit/security-2026-10/instance.json. Never touches the user's .forge.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeApi } from "../../../src/api/server.js";
import { ConfigStore } from "../../../src/config/store.js";
import type { ModelEvent } from "../../../src/contracts/model.js";

const dataDir = mkdtempSync(join(tmpdir(), "forge-audit-data-"));
const workspaceRoot = mkdtempSync(join(tmpdir(), "forge-audit-ws-"));
const forgeDir = mkdtempSync(join(tmpdir(), "forge-audit-forge-"));

// Archive-quarantine model: emits nothing at all (proposals only via test hooks).
const modelFn = {
  async *complete(): AsyncGenerator<ModelEvent> {
    yield { type: "text-delta", text: "(audit mock model: no output)" };
  },
};

const configStore = new ConfigStore(forgeDir);
const api = new ForgeApi({
  dataDir,
  workspaceRoot,
  modelFn,
  configStore,
  escalationTimeoutMs: 2_000,
  port: 3131,
});
await api.listen();
writeFileSync(
  new URL("../instance.json", import.meta.url),
  JSON.stringify({ port: api.port, token: api.token, dataDir, workspaceRoot, forgeDir, pid: process.pid }, null, 2),
);
console.log(`audit instance up: port=${api.port} pid=${process.pid}`);
setInterval(() => {}, 60_000);
