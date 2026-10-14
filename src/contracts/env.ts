// FORGE contracts — Environment (§7). TYPE-LEVEL ONLY in M0: this file
// declares the interface and the environment identity schema, and implements
// nothing. No execution of any kind exists at the contracts layer.

import { z } from "zod";
import { Sha256HexSchema, type Sha256Hex } from "./base.js";
import type { Argv, SecretName, WorkspacePath } from "./base.js";

export const EnvIdentitySchema = z
  .object({
    type: z.enum(["local", "container"]),
    imageHash: Sha256HexSchema.optional(),
    hostFingerprint: Sha256HexSchema,
  })
  .strict();
export type EnvIdentity = z.infer<typeof EnvIdentitySchema>;

export interface ExecResult {
  readonly exit: number | null; // null ⇒ terminated by signal
  readonly signal: string | null;
  /** Opaque handle to captured output (spilled to the artifact store by the
   *  capability host). The host — never the model — resolves it. */
  readonly outputHandle: string;
  readonly durationMs: number;
}

export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
}

export interface FileStat {
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

/** The only effect-execution surface in FORGE (KERNEL primitive #6 depends on
 *  this contract). M0 declared it; M3 implements it in environments/* only. */
export interface Environment {
  readonly identity: EnvIdentity;
  exec(req: {
    readonly argv: Argv;
    readonly cwd: WorkspacePath;
    readonly timeoutMs: number; // runtime-assigned (C-3) — never from the model
    readonly env: ReadonlyMap<SecretName, string>; // injected at dispatch, never logged
    readonly signal: AbortSignal;
    readonly isolationProfile: string;
  }): Promise<ExecResult>;
  /** Resolves an outputHandle returned by exec() into the captured bytes.
   *  (M3 addition, ADR-007 #10: the host persists them into the artifact
   *  store; the environment is the buffer owner.) */
  output(handle: string): { bytes: Uint8Array; truncated: boolean };
  readFile(p: WorkspacePath): Uint8Array;
  putFile(p: WorkspacePath, bytes: Uint8Array): { afterHash: Sha256Hex };
  realpath(p: WorkspacePath): WorkspacePath;
  /** Optional: create a directory (fs mkdir op). (ADR-007 #11) */
  mkdir?(p: WorkspacePath): void;
  /** Read directory entries in the workspace. */
  readDir?(p: WorkspacePath): DirEntry[];
  /** Optional: query file stats (size, isFile, isDirectory) without allocating memory. */
  stat?(p: WorkspacePath): FileStat;
}
