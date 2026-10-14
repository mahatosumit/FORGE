// FORGE environments — container execution (CAPABILITIES.md). Wraps `docker`
// with a bind-mounted workspace: --network none --cap-drop ALL. The workspace
// directory is shared, so file operations are host-side on the same tree.
// Isolation boundary: container-native (documented honest limit — see
// SECURITY.md; the local environment is process-governance only).

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { Environment, EnvIdentity, ExecResult, DirEntry } from "../contracts/env.js";
import type { Argv, SecretName, WorkspacePath } from "../contracts/base.js";
import { LocalEnvironment, sha256Hex, OUTPUT_MAX_BYTES } from "./local.js";
import { Sha256HexSchema, type Sha256Hex } from "../contracts/base.js";

export interface ContainerEnvironmentOptions {
  workspaceRoot: string;
  image: string; // e.g. "node:22-bookworm"
}

export function containerAvailable(): Promise<boolean> {
  return new Promise((res) => {
    const child = execFile("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 }, (err) =>
      res(!err),
    );
    child.on("error", () => res(false));
  });
}

export class ContainerEnvironment implements Environment {
  readonly identity: EnvIdentity;
  private local: LocalEnvironment;
  private outputs = new Map<string, { bytes: Buffer; truncated: boolean }>();
  private seq = 0;

  constructor(readonly opts: ContainerEnvironmentOptions) {
    const root = resolve(opts.workspaceRoot);
    this.local = new LocalEnvironment(root);
    const imageHash = sha256Hex(Buffer.from(opts.image));
    this.identity = { type: "container", imageHash: Sha256HexSchema.parse(imageHash), hostFingerprint: this.local.identity.hostFingerprint };
  }

  exec(req: {
    argv: Argv;
    cwd: WorkspacePath;
    timeoutMs: number;
    env: ReadonlyMap<SecretName, string>;
    signal: AbortSignal;
  }): Promise<ExecResult> {
    const started = Date.now();
    const dockerArgv: string[] = [
      "run", "--rm", "--network", "none", "--cap-drop", "ALL",
      "-v", `${this.local.workspaceRoot}:/work`,
      "-w", `/work/${req.cwd}`,
    ];
    for (const [name, value] of req.env) dockerArgv.push("-e", `${name}=${value}`);
    dockerArgv.push(this.opts.image);
    dockerArgv.push(...req.argv);

    return new Promise((resolveP) => {
      const child = execFile(
        "docker", dockerArgv,
        { timeout: req.timeoutMs, killSignal: "SIGKILL", maxBuffer: OUTPUT_MAX_BYTES },
        (err, so, se) => {
          const signal = child.signalCode ?? null;
          const numericCode = (err as (NodeJS.ErrnoException & { code?: unknown }) | null | undefined)?.code;
          const exit = signal !== null ? null : !err ? (child.exitCode ?? 0) : typeof numericCode === "number" ? numericCode : 1;
          const isMaxBuffer =
            (err as (NodeJS.ErrnoException & { code?: unknown }) | null | undefined)?.code ===
            "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          const soBuf = Buffer.from(so ?? "");
          const seBuf = Buffer.from(se ?? "");
          const combined = Buffer.concat([soBuf, seBuf]);
          const truncated =
            isMaxBuffer ||
            combined.byteLength > OUTPUT_MAX_BYTES ||
            soBuf.byteLength >= OUTPUT_MAX_BYTES ||
            seBuf.byteLength >= OUTPUT_MAX_BYTES;
          const out = combined.subarray(0, OUTPUT_MAX_BYTES);
          const handle = sha256Hex(out) + "-" + this.seq++;
          this.outputs.set(handle, { bytes: out, truncated });
          resolveP({ exit, signal, outputHandle: handle, durationMs: Date.now() - started });
        },
      );
      req.signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    });
  }

  output(handle: string): { bytes: Buffer; truncated: boolean } {
    const o = this.outputs.get(handle);
    if (!o) throw new Error(`unknown output handle ${handle}`);
    return o;
  }

  readFile(p: WorkspacePath): Uint8Array {
    return this.local.readFile(p); // workspace is bind-mounted: same tree
  }

  putFile(p: WorkspacePath, bytes: Uint8Array): { afterHash: Sha256Hex } {
    return this.local.putFile(p, bytes);
  }

  realpath(p: WorkspacePath): WorkspacePath {
    return this.local.resolveReal(p);
  }

  mkdir(p: WorkspacePath): void {
    this.local.mkdir(p);
  }

  readDir(p: WorkspacePath): DirEntry[] {
    return this.local.readDir(p);
  }
}

