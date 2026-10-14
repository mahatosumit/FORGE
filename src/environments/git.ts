import { LocalEnvironment } from "./local.js";
import type { Argv, WorkspacePath } from "../contracts/base.js";

export interface GitStatusResult {
  isRepo: boolean;
  branch?: string;
  clean?: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
  rawStatus: string;
}

export interface GitDiffResult {
  diff: string;
  files: string[];
}

export async function getGitStatus(workspaceRoot: string): Promise<GitStatusResult> {
  const env = new LocalEnvironment(workspaceRoot);
  try {
    const argv: Argv = ["git", "status", "--porcelain", "-b"];
    const res = await env.exec({
      argv,
      cwd: "." as WorkspacePath,
      timeoutMs: 10_000,
      env: new Map(),
      signal: new AbortController().signal,
      isolationProfile: "host",
    });
    if (res.exit !== 0) {
      return { isRepo: false, staged: [], modified: [], untracked: [], rawStatus: "" };
    }
    const out = env.output(res.outputHandle);
    const text = new TextDecoder().decode(out.bytes);
    const lines = text.split("\n");
    let branch = "HEAD";
    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];

    for (const l of lines) {
      if (l.startsWith("##")) {
        const branchMatch = /^## ([\w\d\-_\.\/]+)/.exec(l);
        if (branchMatch) branch = branchMatch[1]!;
        continue;
      }
      if (l.length < 3) continue;
      const x = l[0];
      const y = l[1];
      const file = l.slice(3).trim();
      if (x === "?" && y === "?") {
        untracked.push(file);
      } else {
        if (x !== " " && x !== "?") staged.push(file);
        if (y !== " " && y !== "?") modified.push(file);
      }
    }

    return {
      isRepo: true,
      branch,
      clean: staged.length === 0 && modified.length === 0 && untracked.length === 0,
      staged,
      modified,
      untracked,
      rawStatus: text,
    };
  } catch {
    return { isRepo: false, staged: [], modified: [], untracked: [], rawStatus: "" };
  }
}

export async function getGitDiff(workspaceRoot: string, paths?: string[]): Promise<GitDiffResult> {
  const env = new LocalEnvironment(workspaceRoot);
  try {
    const argv: Argv = paths && paths.length > 0
      ? ["git", "diff", "--", ...paths]
      : ["git", "diff", "HEAD"];
    const res = await env.exec({
      argv,
      cwd: "." as WorkspacePath,
      timeoutMs: 15_000,
      env: new Map(),
      signal: new AbortController().signal,
      isolationProfile: "host",
    });
    const out = env.output(res.outputHandle);
    const diff = new TextDecoder().decode(out.bytes);
    const files: string[] = [];
    for (const line of diff.split("\n")) {
      if (line.startsWith("diff --git a/")) {
        const parts = line.split(" ");
        if (parts[2]) files.push(parts[2].replace(/^a\//, ""));
      }
    }
    return { diff, files };
  } catch {
    return { diff: "", files: [] };
  }
}

export async function createGitCommit(
  workspaceRoot: string,
  message: string
): Promise<{ ok: boolean; commitHash?: string; error?: string }> {
  const env = new LocalEnvironment(workspaceRoot);
  try {
    const addArgv: Argv = ["git", "add", "-A"];
    const addRes = await env.exec({
      argv: addArgv,
      cwd: "." as WorkspacePath,
      timeoutMs: 15_000,
      env: new Map(),
      signal: new AbortController().signal,
      isolationProfile: "host",
    });
    if (addRes.exit !== 0) return { ok: false, error: "git add failed" };

    const commitArgv: Argv = ["git", "commit", "-m", message];
    const commitRes = await env.exec({
      argv: commitArgv,
      cwd: "." as WorkspacePath,
      timeoutMs: 15_000,
      env: new Map(),
      signal: new AbortController().signal,
      isolationProfile: "host",
    });
    const out = env.output(commitRes.outputHandle);
    const text = new TextDecoder().decode(out.bytes);
    if (commitRes.exit === 0) {
      const revArgv: Argv = ["git", "rev-parse", "HEAD"];
      const revRes = await env.exec({
        argv: revArgv,
        cwd: "." as WorkspacePath,
        timeoutMs: 5_000,
        env: new Map(),
        signal: new AbortController().signal,
        isolationProfile: "host",
      });
      const revOut = env.output(revRes.outputHandle);
      const commitHash = new TextDecoder().decode(revOut.bytes).trim();
      return { ok: true, commitHash };
    }
    return { ok: false, error: text };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}
