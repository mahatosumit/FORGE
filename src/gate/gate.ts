// FORGE gate — the Proposal Gate (KERNEL primitive #4; ADR-003).
//
// The single mechanical arbiter between a Proposal and the Capability Host:
//   1. schema validation (strict; C-3 guarantees no authority fields exist),
//   2. constraint resolution (realpath via an injected resolver — the gate
//      module itself performs no I/O),
//   3. match against the active grant set (base policy ∩ envelope ∩ escalations),
//   4. verdict: allow | escalate | reject.
//
// There is no path from model output to a world effect that bypasses the
// Gate (INV-3): the Capability Host dispatch API requires a GateVerdict.

import {
  ProposalSchema,
  type Proposal,
  type Grant,
} from "../contracts/index.js";
import { HostPatternSchema } from "../contracts/base.js";
import type { IsolationProfile } from "../contracts/capabilities.js";
import { matchPath } from "./pathMatch.js";
import { DelegationAuthorityEvaluator } from "../multi-agent/evaluator.js";
import { MultiAgentProjection } from "../multi-agent/projection.js";
import type { EffectiveAuthorityEnvelope } from "../contracts/delegation.js";
import { IntentGate, type CriterionStore } from "../multi-agent/intent-gate.js";

export type GateVerdict =
  | { type: "allow"; grantId: string; resolved: ResolvedProposal; isolationProfile?: IsolationProfile }
  | { type: "escalate"; request: EscalationRequest }
  | { type: "reject"; reasonCode: string; detail: string };

export interface ResolvedProposal {
  capability: Proposal["capability"];
  args: Proposal["args"];
  /** workspace-relative real paths this proposal touches (fs ops) */
  paths: string[];
  hosts: string[];
  argv: string[];
}

export interface EscalationRequest {
  capability: string;
  requested: Grant["constraints"];
  rationale: string;
  citations: string[];
}

export interface PathResolver {
  /** Resolve a workspace-relative path to its real workspace-relative form.
   *  Throws PathEscapeError if the real path leaves the workspace root. */
  resolveReal(p: string): string;
}

export class PathEscapeError extends Error {
  constructor(public readonly path: string) {
    super(`path escapes the workspace root: ${path}`);
    this.name = "PathEscapeError";
  }
}

import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { CapabilityIdentity } from "../contracts/capabilities.js";

export interface GateBudgetConstraints {
  remainingArtifactBytes?: number;
  remainingCalls?: number;
  remainingExecutionTimeMs?: number;
}

export interface GateCallerContext {
  agentId?: string;
  delegationId?: string;
  incarnationEpoch?: number;
}

export interface GateOptions {
  /** Mission-scoped active grants (base policy + envelope + escalations),
   *  already filtered for expiry/revocation by the GrantStore. */
  grants: readonly Grant[];
  resolvePath?: PathResolver;
  now?: Date;
  registry?: CapabilityRegistry;
  pinnedIdentity?: CapabilityIdentity;
  revokedGrantIds?: ReadonlySet<string>;
  missionBudget?: GateBudgetConstraints;
  caller?: GateCallerContext;
  callerContext?: GateCallerContext;
  multiAgentProjection?: MultiAgentProjection;
  parentEnvelope?: EffectiveAuthorityEnvelope;
  criterionStore?: CriterionStore;
  expectedIntentHash?: string;
}

export function validateProposal(p: unknown):
  | { ok: true; proposal: Proposal }
  | { ok: false; reasonCode: string; detail: string } {
  const parsed = ProposalSchema.safeParse(p);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reasonCode: "schema", detail: `${first?.path.join(".")}: ${first?.message}` };
  }
  return { ok: true, proposal: parsed.data };
}

function grantMatchesPath(g: Grant, realPath: string): boolean {
  if (!g.constraints.paths) return false;
  return g.constraints.paths.some((pat) => matchPath(realPath, pat));
}

const INTERPRETER_CODE_EXEC_FLAGS = new Map<string, Set<string>>([
  ["bash", new Set(["-c"])],
  ["sh", new Set(["-c"])],
  ["zsh", new Set(["-c"])],
  ["cmd", new Set(["/c", "/k"])],
  ["cmd.exe", new Set(["/c", "/k"])],
  ["powershell", new Set(["-command", "-c", "-encodedcommand"])],
  ["powershell.exe", new Set(["-command", "-c", "-encodedcommand"])],
  ["pwsh", new Set(["-command", "-c", "-encodedcommand"])],
  ["pwsh.exe", new Set(["-command", "-c", "-encodedcommand"])],
  ["python", new Set(["-c"])],
  ["python3", new Set(["-c"])],
  ["python.exe", new Set(["-c"])],
  ["python3.exe", new Set(["-c"])],
  ["node", new Set(["-e", "--eval", "-p", "--print"])],
  ["node.exe", new Set(["-e", "--eval", "-p", "--print"])],
  ["ruby", new Set(["-e"])],
  ["ruby.exe", new Set(["-e"])],
  ["perl", new Set(["-e"])],
  ["perl.exe", new Set(["-e"])],
  ["php", new Set(["-r"])],
  ["php.exe", new Set(["-r"])],
]);

function isInterpreterCodeEval(argv: readonly string[]): boolean {
  if (argv.length < 2) return false;
  const execName = argv[0]!.toLowerCase().split(/[\\/]/).pop()!;
  const flags = INTERPRETER_CODE_EXEC_FLAGS.get(execName);
  if (!flags) return false;
  for (let i = 1; i < argv.length; i++) {
    const argLower = argv[i]!.toLowerCase();
    for (const flag of flags) {
      if (argLower === flag) return true;
      // Audit fix F-04: attached forms bypassed exact matching —
      // node -eprintln(...), sh -c"cmd", cmd /cecho, --eval=<code>.
      if (flag.startsWith("--")) {
        if (argLower.startsWith(flag + "=")) return true;
      } else if (flag.length === 2 && argLower.startsWith(flag) && argLower.length > flag.length) {
        return true;
      }
    }
  }
  return false;
}

function argvMatchesClass(argv: readonly string[], cls: NonNullable<Grant["constraints"]["argvClass"]>): boolean {
  if (cls.kind === "exact") {
    return argv.length === cls.argv.length && cls.argv.every((s, i) => argv[i] === s);
  }
  // Loose matching (prefix/regex): NEVER permit shell/scripting interpreter inline code execution flags (bash -c, python -c, node -e, cmd /c, powershell -Command)
  // unless the grant explicitly specifies that flag in its prefix segments.
  if (isInterpreterCodeEval(argv)) {
    if (cls.kind === "argv-prefix") {
      const prefixHasFlag = cls.segments.length >= 2 && isInterpreterCodeEval(cls.segments);
      if (!prefixHasFlag) {
        return false;
      }
    } else {
      return false;
    }
  }
  switch (cls.kind) {
    case "argv-prefix":
      return argv.length >= cls.segments.length && cls.segments.every((s, i) => argv[i] === s);
    case "argv-regex":
      return cls.anchors.every((a, i) => {
        if (a === null) return true; // wildcard element
        if (i >= argv.length) return false;
        return new RegExp(a).test(argv[i]!);
      });
  }
}

/** Host part of a URL, bracket-aware for IPv6 (audit fix F-06: naive
 *  split(":")[0] turned "[::1]" into "[", letting any IPv6 host match any
 *  IPv6 grant pattern). */
function splitHostPort(h: string): string {
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  return h.split(":")[0]!;
}

function hostMatches(pattern: string, host: string): boolean {
  const normPat = splitHostPort(pattern.toLowerCase());
  const normHost = splitHostPort(host.toLowerCase());
  if (normPat.startsWith("*.")) {
    const suffix = normPat.slice(2);
    return normHost === suffix || normHost.endsWith("." + suffix);
  }
  return normHost === normPat;
}

/** Match an MCP tool target (serverId.toolName) against grant patterns. */
function matchMcpTool(pattern: string, target: string, serverId: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern === `${serverId}.*`) return true;
  if (pattern === target) return true;
  if (pattern === toolName) return true;
  return false;
}

/** Derive the constraints an out-of-grant proposal would need — the basis of
 *  the structured escalation request. */
export function deriveRequestedConstraints(p: Proposal): Grant["constraints"] {
  switch (p.capability) {
    case "fs":
      return { paths: [p.args.path] };
    case "shell":
      return { argvClass: { kind: "exact", argv: [...p.args.argv] } };
    case "http": {
      const host = new URL(p.args.url).host;
      const parsed = HostPatternSchema.safeParse(host);
      return { hosts: parsed.success ? [parsed.data] : [], methods: [p.args.method] };
    }
    case "git":
      return p.args.paths ? { paths: [...p.args.paths] } : {};
    case "search":
      return {};
    case "verify":
      return {};
    case "artifact":
      return p.args.path ? { paths: [p.args.path] } : {};
    case "web_search":
      return {};
    case "web_fetch": {
      const host = new URL(p.args.url).host;
      const parsed = HostPatternSchema.safeParse(host);
      return { hosts: parsed.success ? [parsed.data] : [] };
    }
    case "mcp_call":
      return { mcpTools: [`${p.args.serverId}.${p.args.toolName}`] };
    case "mcp_server_start":
    case "mcp_server_stop":
      return { mcpServers: [p.args.serverId] };
    case "doc_parse":
      return { paths: [p.args.path] };
    case "delegate":
      return {};
  }
}

/**
 * Evaluate one proposal against the active grant set. Fail-closed: any
 * uncertainty is an escalation or a rejection, never an allow.
 */
export function evaluateProposal(
  raw: unknown,
  meta: { rationale: string; citations: string[] },
  opts: GateOptions,
): GateVerdict {
  // Tier 1 Intent Gate Evaluation (DR-01, DR-02, DR-05)
  const caller = opts.caller ?? opts.callerContext;
  const intentVerdict = IntentGate.evaluate(raw as any, caller, {
    criterionStore: opts.criterionStore,
    expectedIntentHash: opts.expectedIntentHash as any,
  });
  if (!intentVerdict.ok) {
    return {
      type: "reject",
      reasonCode: intentVerdict.reasonCode ?? "intent-rejected",
      detail: intentVerdict.detail ?? "Intent Gate rejected proposal",
    };
  }

  const v = validateProposal(raw);
  if (!v.ok) return { type: "reject", reasonCode: "rejected-schema", detail: v.detail };
  const proposal = v.proposal;

  // 1. Registry status and identity validation (CAP-004, CAP-006, CAP-018)
  if (opts.registry) {
    const status = opts.registry.getStatus(proposal.capability);
    if (status === "disabled") {
      return { type: "reject", reasonCode: "capability-disabled", detail: `capability "${proposal.capability}" is disabled in registry` };
    }
    if (status === "quarantined") {
      return { type: "reject", reasonCode: "capability-quarantined", detail: `capability "${proposal.capability}" is quarantined in registry` };
    }
    if (opts.pinnedIdentity) {
      const val = opts.registry.validateIdentity(opts.pinnedIdentity);
      if (!val.valid) {
        return {
          type: "reject",
          reasonCode: val.reason === "tampered-implementation" ? "tampered-implementation" : "identity-mismatch",
          detail: `capability identity check failed: ${val.reason}`,
        };
      }
    }
  }

  // 2. Mission budget enforcement (CAP-011)
  if (opts.missionBudget) {
    if (opts.missionBudget.remainingCalls !== undefined && opts.missionBudget.remainingCalls <= 0) {
      return { type: "reject", reasonCode: "budget-exhausted", detail: "mission capability calls budget exhausted" };
    }
    if (opts.missionBudget.remainingArtifactBytes !== undefined && opts.missionBudget.remainingArtifactBytes <= 0) {
      return { type: "reject", reasonCode: "budget-exhausted", detail: "mission artifact bytes budget exhausted" };
    }
    if (opts.missionBudget.remainingExecutionTimeMs !== undefined && opts.missionBudget.remainingExecutionTimeMs <= 0) {
      return { type: "reject", reasonCode: "budget-exhausted", detail: "mission execution time budget exhausted" };
    }
  }

  // 3. Caller Multi-Agent Lineage and Epoch Validation (AUDIT-P1-03, AUDIT-P1-08, AUDIT-P1-10)
  if (caller?.delegationId && opts.multiAgentProjection) {
    const lineage = opts.multiAgentProjection.isLineageActive(caller.delegationId as any);
    if (!lineage.ok) {
      return {
        type: "reject",
        reasonCode: "delegation-revoked",
        detail: `Caller delegation "${caller.delegationId}" lineage is revoked: ${lineage.reason}`,
      };
    }
    if (caller.incarnationEpoch !== undefined) {
      const isEpochValid = opts.multiAgentProjection.isEpochAuthoritative(
        caller.delegationId as any,
        caller.incarnationEpoch,
      );
      if (!isEpochValid) {
        const authEpoch = opts.multiAgentProjection.getAuthoritativeEpoch(caller.delegationId as any);
        return {
          type: "reject",
          reasonCode: "stale-epoch",
          detail: `Caller epoch ${caller.incarnationEpoch} is stale or non-authoritative (current authoritative epoch is ${authEpoch})`,
        };
      }
    }
  }

  // resolve paths (fs mutations, artifact paths, doc_parse) against the workspace root
  const resolvedPaths: string[] = [];
  try {
    if (proposal.capability === "fs") {
      const r = opts.resolvePath ? opts.resolvePath.resolveReal(proposal.args.path) : proposal.args.path;
      resolvedPaths.push(r);
    }
    if (proposal.capability === "artifact" && proposal.args.path) {
      const r = opts.resolvePath ? opts.resolvePath.resolveReal(proposal.args.path) : proposal.args.path;
      resolvedPaths.push(r);
    }
    if (proposal.capability === "git" && proposal.args.paths) {
      for (const p of proposal.args.paths) {
        resolvedPaths.push(opts.resolvePath ? opts.resolvePath.resolveReal(p) : p);
      }
    }
    if (proposal.capability === "doc_parse") {
      const r = opts.resolvePath ? opts.resolvePath.resolveReal(proposal.args.path) : proposal.args.path;
      resolvedPaths.push(r);
    }
  } catch (e) {
    if (e instanceof PathEscapeError) {
      return { type: "reject", reasonCode: "rejected-gate", detail: e.message };
    }
    throw e;
  }

  const hosts =
    proposal.capability === "http" || proposal.capability === "web_fetch"
      ? [new URL(proposal.args.url).host]
      : [];
  const argv = proposal.capability === "shell" ? [...proposal.args.argv] : [];

  const resolved: ResolvedProposal = {
    capability: proposal.capability,
    args: proposal.args,
    paths: resolvedPaths,
    hosts,
    argv,
  };

  const now = opts.now ?? new Date();
  let foundRevokedGrant = false;
  for (const g of opts.grants) {
    if (g.capability !== proposal.capability) continue;
    if (opts.revokedGrantIds && opts.revokedGrantIds.has(g.id)) {
      foundRevokedGrant = true;
      continue;
    }
    if (g.expiresAt !== null && Date.parse(g.expiresAt) <= now.getTime()) continue;
    const c = g.constraints;
    let ok = true;
    if (resolvedPaths.length > 0) {
      // every touched path must be covered
      if (!resolvedPaths.every((rp) => grantMatchesPath(g, rp))) ok = false;
    }
    if (hosts.length > 0) {
      if (proposal.capability === "http") {
        if (!c.hosts || !hosts.every((h) => c.hosts!.some((pat) => hostMatches(pat, h)))) ok = false;
        if (c.methods && !c.methods.includes(proposal.args.method)) ok = false;
      } else if (proposal.capability === "web_fetch") {
        if (!c.hosts || c.hosts.length === 0 || !hosts.every((h) => c.hosts!.some((pat) => hostMatches(pat, h)))) {
          ok = false;
        }
      }
    }
    if (argv.length > 0) {
      if (!c.argvClass || !argvMatchesClass(argv, c.argvClass)) ok = false;
    }
    if (proposal.capability === "mcp_call") {
      const target = `${proposal.args.serverId}.${proposal.args.toolName}`;
      if (!c.mcpTools || !c.mcpTools.some((pat) => matchMcpTool(pat, target, proposal.args.serverId, proposal.args.toolName))) {
        ok = false;
      }
    }
    if (proposal.capability === "mcp_server_start" || proposal.capability === "mcp_server_stop") {
      if (c.mcpServers && c.mcpServers.length > 0) {
        if (!c.mcpServers.some((pat) => pat === "*" || pat === proposal.args.serverId)) {
          ok = false;
        }
      }
    }
    if (ok) {
      if (proposal.capability === "delegate") {
        const projection = opts.multiAgentProjection ?? new MultiAgentProjection();
        const parentEnv = opts.parentEnvelope ?? (caller as any)?.parentEnvelope;
        const evalRes = DelegationAuthorityEvaluator.evaluate(
          proposal.args,
          g,
          parentEnv,
          projection,
          now,
        );
        if (!evalRes.ok) {
          return {
            type: "reject",
            reasonCode: evalRes.reasonCode ?? "delegation-rejected",
            detail: evalRes.detail ?? "Delegation authority evaluation failed",
          };
        }
        return {
          type: "allow",
          grantId: g.id,
          resolved,
          isolationProfile: evalRes.effectiveEnvelope?.isolationProfile ?? "sandboxed",
        };
      }

      let isolationProfile: IsolationProfile = "sandboxed";
      if (c.isolationProfile) {
        isolationProfile = c.isolationProfile;
      } else if (c.allowHostExecution || (g.capability as string) === "host_execution") {
        isolationProfile = "host";
      } else if (proposal.capability === "http" || proposal.capability === "web_fetch") {
        isolationProfile = "sandboxed-network";
      }
      return { type: "allow", grantId: g.id, resolved, isolationProfile };
    }
  }

  if (foundRevokedGrant) {
    return {
      type: "reject",
      reasonCode: "grant-revoked",
      detail: `grant for capability "${proposal.capability}" was revoked`,
    };
  }

  // read-shaped capabilities with no constraint requirements still need SOME
  // grant for the capability (deny-by-default, ADR-0003) — base policy issues
  // broad read grants so normal reads never escalate.
  const isArbitraryCode = proposal.capability === "shell" && isInterpreterCodeEval(argv);
  const rationale = isArbitraryCode
    ? `[R4 Arbitrary Code Execution] ${meta.rationale || "Command executes inline code via interpreter eval flag; requires explicit R4 authority"}`
    : meta.rationale;

  return {
    type: "escalate",
    request: {
      capability: proposal.capability,
      requested: deriveRequestedConstraints(proposal),
      rationale,
      citations: meta.citations,
    },
  };
}
