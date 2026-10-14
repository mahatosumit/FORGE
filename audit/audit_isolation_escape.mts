import { Engine } from "../src/engine/engine.js";
import { LocalEnvironment } from "../src/environments/local.ts";
import { PathEscapeError } from "../src/gate/gate.js";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

async function test() {
  const workspaceRoot = resolve("./test-isolation-ws");
  mkdirSync(workspaceRoot, { recursive: true });
  
  const mockModelFn = {
    complete: async function* () {
      yield { type: "proposal", proposal: { capability: "shell", args: { argv: ["cat", "/etc/passwd"], cwd: "." } }, meta: { rationale: "attack", citations: [] } };
    }
  } as any;

  const engine = new Engine({
    dataDir: join(workspaceRoot, ".forge-data"),
    workspaceRoot,
    modelFn: mockModelFn,
  });

  console.log("Testing sandboxed isolation escape...");
  
  const h = await engine.openQuickMission("attack the system");
  // The quick lane usually issues sandboxed grants for shell.
  
  try {
    await engine.executeMission(h);
    console.error("❌ FAILURE: Mission completed without blocking absolute path!");
    process.exit(1);
  } catch (e) {
    if (e instanceof PathEscapeError || (e as any).message?.includes("path escapes")) {
      console.log("✓ SUCCESS: Absolute path was blocked by PathEscapeError");
    } else {
      console.error(`❌ FAILURE: Caught unexpected error: ${e}`);
      process.exit(1);
    }
  }
}

test().catch(console.error);
