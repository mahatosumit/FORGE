// FORGE Local Execution Provider (Step 7A).
// Implements ExecutionProvider for exceptional "host" execution profile.
// Enforces that non-host profiles cannot execute directly on the host.

import type { ExecutionProvider, ExecutionRequest, ExecutionResult } from "./types.js";
import type { IsolationProfile } from "../../contracts/capabilities.js";
import { LocalEnvironment, OUTPUT_MAX_BYTES } from "../local.js";
import type { Argv, SecretName, WorkspacePath } from "../../contracts/base.js";

export class LocalExecutionProvider implements ExecutionProvider {
  readonly profile: IsolationProfile = "host";

  constructor(private readonly localEnv: LocalEnvironment) {}

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    if (req.isolationProfile !== "host") {
      throw new Error(`LocalExecutionProvider refused execution: request requested profile "${req.isolationProfile}", but local provider only supports "host"`);
    }

    const envMap = new Map<SecretName, string>();
    if (req.env) {
      if (req.env instanceof Map) {
        for (const [k, v] of req.env.entries()) envMap.set(k as SecretName, v);
      } else {
        for (const [k, v] of Object.entries(req.env)) envMap.set(k as SecretName, v);
      }
    }

    const execResult = await this.localEnv.exec({
      argv: req.argv as unknown as Argv,
      cwd: (req.cwd ?? "") as WorkspacePath,
      timeoutMs: req.timeoutMs,
      env: envMap,
      signal: req.signal,
      isolationProfile: req.isolationProfile,
    });

    const out = this.localEnv.output(execResult.outputHandle);

    return {
      exit: execResult.exit,
      signal: execResult.signal,
      outputHandle: execResult.outputHandle,
      durationMs: execResult.durationMs,
      truncated: out.truncated,
      oomKilled: false,
      isolationProfile: "host",
    };
  }

  output(handle: string): { bytes: Buffer; truncated: boolean } {
    return this.localEnv.output(handle);
  }
}
