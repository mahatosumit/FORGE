// FORGE environments — local execution (ADR-0007 self-contained missions;
// CAPABILITIES.md environment indirection). The ONLY module (with container)
// that touches effect seams. Secrets are injected per-exec and never logged.

import { execFile, exec, execSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, basename, relative, resolve, isAbsolute, join } from "node:path";
import { hostname } from "node:os";
import type { Environment, EnvIdentity, ExecResult, DirEntry, FileStat } from "../contracts/env.js";
import { Sha256HexSchema, type Argv, type SecretName, type Sha256Hex, type WorkspacePath } from "../contracts/base.js";
import { PathEscapeError } from "../gate/gate.js";

export const EXEC_TIMEOUT_DEFAULT_MS = 120_000;
export const OUTPUT_MAX_BYTES = 2 * 1024 * 1024; // capture cap; oversized → truncated

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Keep only the workspace-relative form inside the workspace root. */
export function assertInsideWorkspace(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathEscapeError(absolute);
  }
  return rel.split("\\").join("/");
}

/**
 * POSIX whole-tree termination (GATE B fix). SIGKILLs every descendant of
 * rootPid leaves-up, then sweeps the process group and the root itself.
 * Best-effort and total (never throws): every step is individually guarded
 * and the `ps` snapshot has a bounded timeout with a root-only fallback.
 *
 * Rationale (CI-demonstrated): process-group leadership cannot be assumed.
 * An exec'd child was observed sharing its launcher's group (pgid != pid),
 * so a group-only kill targets an empty group while the fallback kills only
 * the direct child — orphaning the subtree, which survives indefinitely.
 * Enumerating the tree works with or without group leadership, mirroring
 * the Windows `taskkill /T` strategy. Known residual: snapshot-then-kill
 * races (a PID recycled mid-sweep) — same class as any pid-based kill.
 */
export function killTreePosix(rootPid: number): void {
  try {
    let descendants: number[] = [];
    try {
      const out = execSync("ps -eo pid,ppid", { encoding: "utf8", timeout: 5000, windowsHide: true }) as string;
      const childrenOf = new Map<number, number[]>();
      for (const line of out.split("\n").slice(1)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)/);
        if (!m) continue;
        const pid = Number(m[1]);
        const ppid = Number(m[2]);
        if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
        const list = childrenOf.get(ppid);
        if (list) list.push(pid);
        else childrenOf.set(ppid, [pid]);
      }
      // BFS from the root discovers parents before children.
      const seen = new Set<number>([rootPid]);
      const queue: number[] = [rootPid];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const c of childrenOf.get(cur) ?? []) {
          if (!seen.has(c)) {
            seen.add(c);
            queue.push(c);
          }
        }
      }
      seen.delete(rootPid);
      descendants = [...seen];
    } catch {
      descendants = [];
    }
    // Reversed BFS order kills deeper processes before their parents.
    for (let i = descendants.length - 1; i >= 0; i--) {
      try {
        process.kill(descendants[i]!, "SIGKILL");
      } catch {
        /* already dead or reaped */
      }
    }
    try {
      process.kill(-rootPid, "SIGKILL");
    } catch {
      /* no such group — expected when leadership never took effect */
    }
    try {
      process.kill(rootPid, "SIGKILL");
    } catch {
      /* already dead */
    }
  } catch {
    /* total function: never throws */
  }
}

/**
 * Windows: npm/git/etc. are .cmd/.bat shims that execFile cannot spawn
 * directly. Resolve argv[0] against PATH; if it is a .cmd/.bat shim, route
 * through cmd.exe /d /s /c with each argument quoted (inner quotes doubled).
 * Residual risk (SECURITY-THREAT-MODEL T-06): grant matching still operates
 * on the ORIGINAL argv vector, and & | > < inside an argument are quoted with
 * the argument, so metacharacters cannot introduce new commands.
 */
function resolveWindowsCommand(argv: Argv): { command: string; args: string[]; rawCmdline: string | null } {
  if (process.platform !== "win32") return { command: argv[0]!, args: [...argv.slice(1)], rawCmdline: null };
  const first = argv[0]!;
  if (/.(exe|com)$/i.test(first)) return { command: first, args: [...argv.slice(1)], rawCmdline: null };
  const exts = (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";");
  const dirs = (process.env["PATH"] ?? "").split(";").filter((d) => d.length > 0);
  let shim: string | null = null;
  outer: for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, first + ext.toLowerCase());
      if (existsSync(candidate)) {
        if (/.(exe|com)$/i.test(candidate)) return { command: candidate, args: [...argv.slice(1)], rawCmdline: null };
        shim = candidate;
        break outer;
      }
    }
  }
  if (!shim) return { command: first, args: [...argv.slice(1)], rawCmdline: null }; // execFile surfaces the error
  const q = (a: string) => '"' + a.replace(/"/g, '""') + '"';
  const inner = [q(shim), ...argv.slice(1).map(q)].join(" ");
  // raw string executed via exec(): node's exec already routes through
  // `cmd.exe /d /s /c "<command>"`, so we supply only the inner command with
  // its own argument quoting (node's execFile arg-quoting backslash-escapes
  // quotes, which cmd.exe cannot parse).
  return { command: "cmd.exe", args: [], rawCmdline: inner };
}
export class LocalEnvironment implements Environment {
  readonly identity: EnvIdentity;
  private readonly realRoot: string;
  private outputs = new Map<string, { bytes: Buffer; truncated: boolean }>();

  constructor(readonly workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
    // Canonical root: the workspace directory itself may be reached through a
    // symlink/junction (e.g. %TEMP%); containment must compare real paths.
    this.realRoot = existsSync(this.workspaceRoot) ? realpathSync(this.workspaceRoot) : this.workspaceRoot;
    const fp = createHash("sha256")
      .update(`local|${hostname()}|${process.platform}|${this.workspaceRoot}`)
      .digest("hex");
    this.identity = { type: "local", hostFingerprint: Sha256HexSchema.parse(fp) };
  }

  /** Canonical workspace containment (CWE-59 class): resolve the REAL path of
   *  the deepest existing ancestor so directory symlinks/junctions inside the
   *  workspace cannot redirect reads/writes/exec-cwd outside it; reject
   *  Windows canonicalization aliases (drive-relative, ADS, trailing dot/space
   *  segments) that let the checked name differ from the effected name. */
  private absolute(p: WorkspacePath): string {
    const raw = String(p);
    if (process.platform === "win32" && /^[a-zA-Z]:(?![\\/])/.test(raw)) {
      throw new PathEscapeError(p); // drive-relative ("C:foo") — ambiguous target
    }
    const abs = resolve(this.workspaceRoot, p);
    let probe = abs;
    const suffix: string[] = [];
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      suffix.unshift(basename(probe));
      probe = parent;
    }
    const realBase = existsSync(probe) ? realpathSync(probe) : probe;
    const realAbs = suffix.length > 0 ? join(realBase, ...suffix) : realBase;
    const rel = relative(this.realRoot, realAbs);
    if (rel === "") return this.realRoot; // the workspace root itself
    if (rel.startsWith("..") || isAbsolute(rel)) throw new PathEscapeError(p);
    if (process.platform === "win32") {
      for (const seg of rel.split(/[\\/]+/)) {
        if (seg === "") continue;
        if (/[. ]$/.test(seg) || seg.includes(":")) throw new PathEscapeError(p); // alias/ADS segments
      }
    }
    return realAbs;
  }

  resolveReal(p: WorkspacePath): WorkspacePath {
    const abs = this.absolute(p);
    const real = existsSync(abs) ? realpathSync(abs) : abs; // pre-creation paths resolve lexically
    const rel = relative(this.realRoot, real);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      return rel.split("\\").join("/") as WorkspacePath;
    }
    throw new PathEscapeError(p);
  }

  /** Resolves an outputHandle returned by exec() into the captured bytes.
   *  The host persists them into the artifact store and records the ref. */
  output(handle: string): { bytes: Buffer; truncated: boolean } {
    const o = this.outputs.get(handle);
    if (!o) throw new Error(`unknown output handle ${handle}`);
    return o;
  }

  exec(req: {
    argv: Argv;
    cwd: WorkspacePath;
    timeoutMs: number;
    env: ReadonlyMap<SecretName, string>;
    signal: AbortSignal;
    isolationProfile: string;
  }): Promise<ExecResult> {
    const cwdAbs = this.absolute(req.cwd);

    if (req.isolationProfile === "sandboxed") {
      for (const arg of req.argv) {
        if (typeof arg !== "string") continue;
        // Block absolute paths and obvious escapes in sandboxed mode
        if (isAbsolute(arg) || arg.includes("..")) {
          throw new PathEscapeError(arg);
        }
      }
    }

    const started = Date.now();
    const self = this;
    return new Promise((resolveP) => {
      const childEnv: Record<string, string> = {};
      // Minimal env: nothing inherited except a few OS-required names —
      // secrets are injected per-dispatch, never read from ambient environment.
      for (const k of ["PATH", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TMP", "TEMP"]) {
        const v = process.env[k];
        if (v !== undefined) childEnv[k] = v;
      }
      for (const [name, value] of req.env) childEnv[name] = value;

      const finish = (child: ChildProcess, err: Error | null | undefined, so: string | Buffer, se: string | Buffer) => {
        let signal: string | null = child.signalCode ?? null;
        const numericCode = (err as (NodeJS.ErrnoException & { code?: unknown }) | null | undefined)?.code;
        const errno = (err as (NodeJS.ErrnoException & { errno?: number }) | null | undefined)?.errno;
        let exit: number | null;
        if (signal !== null) exit = null;
        else if (!err) exit = child.exitCode ?? 0;
        else if (typeof numericCode === "number" && numericCode >= 0 && numericCode <= 255) exit = numericCode;
        else if (typeof errno === "number" && errno < 0) {
          exit = null; // spawn fault (e.g. ENOENT) — surfaced via the signal field
          signal = ("ERRNO" + String(Math.abs(errno))).slice(0, 16);
        } else exit = child.exitCode ?? 1;
        const soBuf = Buffer.from(so ?? "");
        const seBuf = Buffer.from(se ?? "");
        const combined = Buffer.concat([soBuf, seBuf]);
        const isMaxBuffer =
          (err as (NodeJS.ErrnoException & { code?: unknown }) | null | undefined)?.code ===
          "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const truncated =
          isMaxBuffer ||
          combined.byteLength > OUTPUT_MAX_BYTES ||
          soBuf.byteLength >= OUTPUT_MAX_BYTES ||
          seBuf.byteLength >= OUTPUT_MAX_BYTES;
        const out = combined.subarray(0, OUTPUT_MAX_BYTES);
        const handle = sha256Hex(out) + "-" + self.outputs.size;
        self.outputs.set(handle, { bytes: out, truncated });
        resolveP({ exit, signal, outputHandle: handle, durationMs: Date.now() - started });
      };

      const { command, args, rawCmdline } = resolveWindowsCommand(req.argv);
      const common = {
        cwd: cwdAbs,
        timeout: req.timeoutMs,
        killSignal: "SIGKILL" as const,
        maxBuffer: OUTPUT_MAX_BYTES,
        env: childEnv,
        detached: process.platform !== "win32",
      };
      let timeoutTimer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
        const pid = child.pid;
        if (pid) {
          if (process.platform === "win32") {
            try {
              execSync(`taskkill /F /T /PID ${pid}`, { windowsHide: true, stdio: "ignore" });
            } catch {
              try { child.kill("SIGKILL"); } catch {}
            }
          } else {
            // GATE B fix: never assume group leadership — enumerate and kill
            // the whole tree (group sweep + root sweep included). Total.
            try {
              killTreePosix(pid);
            } catch {
              try { child.kill("SIGKILL"); } catch {}
            }
          }
        } else {
          try { child.kill("SIGKILL"); } catch {}
        }
      };

      if (req.timeoutMs > 0 && req.timeoutMs < 2147483647) {
        timeoutTimer = setTimeout(() => {
          onAbort();
        }, req.timeoutMs);
      }

      const finishCallback = (err: Error | null | undefined, so: string | Buffer, se: string | Buffer) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
        req.signal.removeEventListener("abort", onAbort);
        finish(child, err, so, se);
      };

      const child = rawCmdline !== null
        ? exec(rawCmdline, common, (err, so, se) => finishCallback(err, so, se))
        : execFile(command, args, common, (err, so, se) => finishCallback(err, so, se));

      if (req.signal.aborted) {
        onAbort();
      } else {
        req.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  stat(p: WorkspacePath): FileStat {
    const abs = this.absolute(p);
    const s = statSync(abs);
    return {
      size: s.size,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
    };
  }

  realpath(p: WorkspacePath): WorkspacePath {
    return this.resolveReal(p);
  }

  mkdir(p: WorkspacePath): void {
    mkdirSync(this.absolute(p), { recursive: true });
  }

  readDir(p: WorkspacePath): DirEntry[] {
    const abs = p === ("." as WorkspacePath) || p === ("" as WorkspacePath) ? this.workspaceRoot : this.absolute(p);
    if (!existsSync(abs)) return [];
    const entries = readdirSync(abs, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    }));
  }

  readFile(p: WorkspacePath): Uint8Array {
    return readFileSync(this.absolute(p));
  }

  putFile(p: WorkspacePath, bytes: Uint8Array): { afterHash: Sha256Hex } {
    const abs = this.absolute(p);
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = abs + ".forge-tmp-" + process.pid + "-" + Math.random().toString(36).slice(2);
    writeFileSync(tmp, bytes);
    try {
      renameSync(tmp, abs); // atomic same-filesystem replace
    } catch (err: any) {
      if (err?.code === "EPERM" || err?.code === "EBUSY") {
        // Windows transient file lock: retry briefly before direct overwrite
        let success = false;
        for (let i = 0; i < 5; i++) {
          try {
            const end = Date.now() + 10;
            while (Date.now() < end) {}
            renameSync(tmp, abs);
            success = true;
            break;
          } catch {}
        }
        if (!success) {
          writeFileSync(abs, bytes);
          try { unlinkSync(tmp); } catch {}
        }
      } else {
        throw err;
      }
    }
    return { afterHash: Sha256HexSchema.parse(sha256Hex(bytes)) };
  }
}
