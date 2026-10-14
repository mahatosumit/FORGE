// FORGE CLI session lifecycle (RR-06).
// The session file carries the server bearer token: it is shape-validated,
// used only when its server actually answers on loopback, and cleared when
// stale, malformed, or dead — so CLI commands fall back to local execution
// instead of failing against a dead port. Extracted from cli.ts; no behavior
// change beyond the RR-06 contract.

import { readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export const FORGE_DIR = join(resolve(process.cwd()), ".forge");

export interface ForgeSession {
  port: number;
  token: string;
  pid?: number;
}

/** Strict shape validation for the session file. Anything malformed is
 *  treated as absent (never used for network calls). */
export function parseSessionFile(raw: string): ForgeSession | null {
  try {
    const j = JSON.parse(raw) as { port?: unknown; token?: unknown; pid?: unknown };
    if (typeof j.port !== "number" || !Number.isInteger(j.port) || j.port < 1 || j.port > 65535) return null;
    if (typeof j.token !== "string" || !/^[a-f0-9]{48}$/.test(j.token)) return null;
    const pid = typeof j.pid === "number" && Number.isInteger(j.pid) ? j.pid : undefined;
    return { port: j.port, token: j.token, pid };
  } catch {
    return null;
  }
}

/** A session file must not outlive its process (it carries the bearer
 *  token). Best-effort removal; absence is success. */
export function clearSessionFile(forgeDir: string = FORGE_DIR): void {
  try {
    rmSync(join(forgeDir, "session.json"), { force: true });
  } catch {
    /* best effort */
  }
}

/** Return the session only if its server actually answers on loopback;
 *  stale/dead/malformed files are cleared so later commands fall back to the
 *  local execution path instead of failing against a dead port. */
export async function getLiveSession(forgeDir: string = FORGE_DIR): Promise<ForgeSession | null> {
  const sessionPath = join(forgeDir, "session.json");
  if (!existsSync(sessionPath)) return null;
  let parsed: ForgeSession | null = null;
  try {
    parsed = parseSessionFile(readFileSync(sessionPath, "utf8"));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    clearSessionFile(forgeDir);
    return null;
  }
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1200);
    const res = await fetch(`http://127.0.0.1:${parsed.port}/health`, {
      headers: { authorization: `Bearer ${parsed.token}` },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (res.status === 200) return parsed;
  } catch {
    /* dead port / not our server */
  }
  clearSessionFile(forgeDir);
  return null;
}
