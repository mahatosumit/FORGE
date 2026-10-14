import { readFileSync } from "node:fs";
import { openMissionReadOnly } from "../../../src/ledger/index.js";
import { verifyChain, computeRecordHash } from "../../../src/codec/hashChain.js";
const inst = JSON.parse(readFileSync("audit/security-2026-10/instance.json", "utf8"));
const missionId = "mis_01M4V72TF89M8JDHQ571R0AH67";

const store = openMissionReadOnly(inst.dataDir, missionId);
const records = store.read();
const v = verifyChain(records);
console.log("records:", records.length, "| verifyChain:", v.ok ? "OK" : "FAILED: " + JSON.stringify(v));
for (const r of records.slice(-6)) {
  const recomputed = computeRecordHash({ ...r, hash: undefined });
  console.log(`seq ${r.seq} [${r.kind}] author=${r.author} hashOK=${recomputed === r.hash}`);
}
store.close?.();
