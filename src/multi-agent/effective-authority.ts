// FORGE Effective Authority Model (Step 8 Phase 1)
// Closed-world attenuation algorithm computing child effective authority
// from parent effective envelope and child requested authority across all 20 dimensions.
// Core Invariant: A_child ⊆ A_parent across all dimensions; undefined NEVER means unlimited.

import { matchPath, literalPrefix } from "../gate/pathMatch.js";
import type { Constraints } from "../contracts/base.js";
import type { RiskClass } from "../contracts/grants.js";
import {
  type EffectiveAuthorityEnvelope,
  EffectiveAuthorityEnvelopeSchema,
  type ChildRequestedAuthority,
} from "../contracts/delegation.js";

export class AttenuationError extends Error {
  constructor(
    public readonly dimension: string,
    message: string,
  ) {
    super(`AttenuationError [${dimension}]: ${message}`);
    this.name = "AttenuationError";
  }
}

const RISK_RANKS: Record<RiskClass, number> = {
  read: 1,
  write: 2,
  execute: 3,
  network: 4,
  secret: 5,
};

const ISOLATION_RANKS: Record<"sandboxed" | "sandboxed-network" | "host", number> = {
  sandboxed: 3,
  "sandboxed-network": 2,
  host: 1,
};

/**
 * Strict directory segment containment:
 * Child path must be identical to parent or lie strictly inside parent directory.
 * "workspace/sub" covers "workspace/sub/file.txt", but NEVER "workspace/subversion/file.txt".
 */
export function isPathContained(childPath: string, parentPath: string): boolean {
  const normChild = childPath.replace(/^\/+|\/+$/g, "");
  const normParent = parentPath.replace(/^\/+|\/+$/g, "");

  // Upward traversal forbidden
  if (normChild.split("/").includes("..") || normParent.split("/").includes("..")) {
    return false;
  }

  // Exact match
  if (normChild === normParent) return true;

  // Directory boundary containment
  if (normChild.startsWith(normParent + "/")) return true;

  // Glob matching
  if (matchPath(normChild, normParent)) return true;

  // Glob directory prefix
  if (normParent.endsWith("/**")) {
    const base = normParent.slice(0, -3);
    if (normChild === base || normChild.startsWith(base + "/")) return true;
  }

  return false;
}

/** Bracket-aware host extraction (audit fix F-06). */
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

function matchMcpTool(pattern: string, tool: string): boolean {
  if (pattern === "*") return true;
  if (pattern === tool) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return tool.startsWith(prefix + ".");
  }
  return false;
}

function argvClassCovers(
  parent: Constraints["argvClass"],
  child: NonNullable<Constraints["argvClass"]>,
): boolean {
  if (!parent) return false;
  if (child.kind === "exact" && parent.kind === "exact") {
    return (
      parent.argv.length <= child.argv.length &&
      parent.argv.every((s, i) => child.argv[i] === s)
    );
  }
  if (parent.kind === "argv-prefix" && child.kind === "argv-prefix") {
    return (
      parent.segments.length <= child.segments.length &&
      parent.segments.every((s, i) => child.segments[i] === s)
    );
  }
  if (parent.kind === "argv-prefix" && child.kind === "exact") {
    return parent.segments.every((s, i) => child.argv[i] === s);
  }
  if (parent.kind === "exact" && child.kind === "argv-prefix") return false; // widening
  if (parent.kind === "argv-regex" && child.kind === "argv-regex") {
    return JSON.stringify(parent.anchors) === JSON.stringify(child.anchors);
  }
  return false;
}

/**
 * Pure closed-world attenuation intersection operator:
 * A_child_eff = A_parent_eff ⊓ A_child_req
 *
 * Guaranteed properties:
 * 1. Monotonic containment: every dimension in child is <= parent.
 * 2. Closed-world inheritance: omitted fields in child inherit parent bounds or collapse to empty set.
 * 3. Never expands wildcards, never widens permissions, never lengthens lifetimes.
 */
export function computeEffectiveAuthority(
  parent: EffectiveAuthorityEnvelope,
  requested: ChildRequestedAuthority,
): { ok: true; effective: EffectiveAuthorityEnvelope } | { ok: false; error: string; dimension: string } {
  try {
    // 1. Capabilities Attenuation (Fail-closed: omitted = empty set, §2.1)
    let effectiveCaps: string[];
    if (requested.capabilities !== undefined) {
      for (const cap of requested.capabilities) {
        if (!parent.capabilities.includes(cap)) {
          throw new AttenuationError(
            "capabilities",
            `Requested capability "${cap}" is not covered by parent capabilities [${parent.capabilities.join(", ")}]`,
          );
        }
      }
      effectiveCaps = [...requested.capabilities];
    } else {
      // Omitted capabilities: fail closed to empty set (zero capabilities)
      effectiveCaps = [];
    }

    // 2. Risk Ceiling Monotonicity
    let effectiveRisk: RiskClass = parent.riskCeiling;
    if (requested.riskCeiling !== undefined) {
      const reqRank = RISK_RANKS[requested.riskCeiling];
      const parentRank = RISK_RANKS[parent.riskCeiling];
      if (reqRank !== undefined && parentRank !== undefined && reqRank > parentRank) {
        throw new AttenuationError(
          "risk",
          `Requested risk ceiling "${requested.riskCeiling}" exceeds parent ceiling "${parent.riskCeiling}"`,
        );
      }
      effectiveRisk = requested.riskCeiling;
    }

    // 3. Isolation Profile Monotonicity
    let effectiveIsolation = parent.isolationProfile;
    if (requested.isolationProfile !== undefined) {
      if (ISOLATION_RANKS[requested.isolationProfile] < ISOLATION_RANKS[parent.isolationProfile]) {
        throw new AttenuationError(
          "isolationProfile",
          `Requested isolation "${requested.isolationProfile}" is weaker than parent isolation "${parent.isolationProfile}"`,
        );
      }
      effectiveIsolation = requested.isolationProfile;
    }

    // 4. Host Execution Monotonicity
    let effectiveAllowHost = false;
    if (requested.allowHostExecution !== undefined) {
      if (requested.allowHostExecution && !parent.allowHostExecution) {
        throw new AttenuationError(
          "hostExecution",
          "Child requested allowHostExecution: true when parent possesses false",
        );
      }
      effectiveAllowHost = requested.allowHostExecution;
    } else {
      // Omitted host execution: defaults to false (fail-closed)
      effectiveAllowHost = false;
    }

    // 5. Constraints Attenuation (Closed-World Rules)
    const pConst = parent.constraints;
    const rConst = requested.constraints ?? {};
    const effectiveConstraints: Constraints = {};

    // 5a. Filesystem Paths
    if (rConst.paths !== undefined) {
      if (pConst.paths === undefined || pConst.paths.length === 0) {
        throw new AttenuationError("paths", "Child requested filesystem paths but parent has zero authorized paths");
      }
      for (const cp of rConst.paths) {
        const prefix = literalPrefix(cp) || cp;
        const covered = pConst.paths.some((pp) => isPathContained(prefix, pp) || isPathContained(cp, pp));
        if (!covered) {
          throw new AttenuationError(
            "paths",
            `Requested path "${cp}" is not covered by parent authorized paths [${pConst.paths.join(", ")}]`,
          );
        }
      }
      effectiveConstraints.paths = [...rConst.paths];
    } else {
      // Omitted paths: inherit parent paths strictly (never unlimited)
      if (pConst.paths !== undefined) {
        effectiveConstraints.paths = [...pConst.paths];
      }
    }

    // 5b. Network Hosts & Methods
    if (rConst.hosts !== undefined) {
      if (pConst.hosts === undefined || pConst.hosts.length === 0) {
        throw new AttenuationError("hosts", "Child requested network hosts but parent has zero authorized hosts");
      }
      for (const ch of rConst.hosts) {
        // Anti-wildcard widening: child cannot request wildcard "*.x" unless parent has "*.x"
        if (ch.startsWith("*.")) {
          const covered = pConst.hosts.some((ph) => ph.startsWith("*.") && hostMatches(ph, ch.slice(2)));
          if (!covered) {
            throw new AttenuationError(
              "hosts",
              `Wildcard host "${ch}" widens parent non-wildcard or narrower host patterns`,
            );
          }
        } else {
          const covered = pConst.hosts.some((ph) => hostMatches(ph, ch));
          if (!covered) {
            throw new AttenuationError(
              "hosts",
              `Requested host "${ch}" is not covered by parent authorized hosts [${pConst.hosts.join(", ")}]`,
            );
          }
        }
      }
      effectiveConstraints.hosts = [...rConst.hosts];
    } else {
      // Omitted hosts: inherit parent hosts strictly
      if (pConst.hosts !== undefined) {
        effectiveConstraints.hosts = [...pConst.hosts];
      }
    }

    if (rConst.methods !== undefined) {
      if (pConst.methods !== undefined) {
        for (const m of rConst.methods) {
          if (!pConst.methods.includes(m)) {
            throw new AttenuationError("methods", `Requested HTTP method "${m}" is not permitted by parent`);
          }
        }
      }
      effectiveConstraints.methods = [...rConst.methods];
    } else if (pConst.methods !== undefined) {
      effectiveConstraints.methods = [...pConst.methods];
    }

    // 5c. Shell Command Class (argvClass)
    if (rConst.argvClass !== undefined) {
      if (pConst.argvClass !== undefined) {
        if (!argvClassCovers(pConst.argvClass, rConst.argvClass)) {
          throw new AttenuationError("commands", "Requested argvClass is not covered by parent command constraints");
        }
      }
      effectiveConstraints.argvClass = rConst.argvClass;
    } else if (pConst.argvClass !== undefined) {
      effectiveConstraints.argvClass = pConst.argvClass;
    }

    // 5d. MCP Servers & Tools
    if (rConst.mcpServers !== undefined) {
      if (pConst.mcpServers === undefined || pConst.mcpServers.length === 0) {
        throw new AttenuationError("mcpServers", "Child requested MCP servers but parent has zero authorized servers");
      }
      for (const s of rConst.mcpServers) {
        if (!pConst.mcpServers.includes(s)) {
          throw new AttenuationError(
            "mcpServers",
            `Requested MCP server "${s}" is not covered by parent servers [${pConst.mcpServers.join(", ")}]`,
          );
        }
      }
      effectiveConstraints.mcpServers = [...rConst.mcpServers];
    } else if (pConst.mcpServers !== undefined) {
      effectiveConstraints.mcpServers = [...pConst.mcpServers];
    }

    if (rConst.mcpTools !== undefined) {
      if (pConst.mcpTools === undefined || pConst.mcpTools.length === 0) {
        throw new AttenuationError("mcpTools", "Child requested MCP tools but parent has zero authorized tools");
      }
      for (const t of rConst.mcpTools) {
        if (t.endsWith(".*") || t === "*") {
          // Wildcard tool request: parent must already have that exact wildcard or broader
          const covered = pConst.mcpTools.some((pt) => pt === "*" || pt === t);
          if (!covered) {
            throw new AttenuationError("mcpTools", `Wildcard MCP tool "${t}" widens parent tool permissions`);
          }
        } else {
          const covered = pConst.mcpTools.some((pt) => matchMcpTool(pt, t));
          if (!covered) {
            throw new AttenuationError(
              "mcpTools",
              `Requested MCP tool "${t}" is not covered by parent tools [${pConst.mcpTools.join(", ")}]`,
            );
          }
        }
      }
      effectiveConstraints.mcpTools = [...rConst.mcpTools];
    } else if (pConst.mcpTools !== undefined) {
      effectiveConstraints.mcpTools = [...pConst.mcpTools];
    }

    // 5e. Secret Names
    if (rConst.secretNames !== undefined) {
      if (pConst.secretNames === undefined) {
        throw new AttenuationError("secretNames", "Child requested secrets but parent has zero authorized secrets");
      }
      for (const s of rConst.secretNames) {
        if (!pConst.secretNames.includes(s)) {
          throw new AttenuationError("secretNames", `Requested secret "${s}" is not authorized on parent`);
        }
      }
      effectiveConstraints.secretNames = [...rConst.secretNames];
    } else if (pConst.secretNames !== undefined) {
      effectiveConstraints.secretNames = [...pConst.secretNames];
    }

    // 6. Temporal Expiry Monotonicity (Lifetime)
    let effectiveExpiry = parent.expiresAt;
    if (requested.expiresAt !== undefined) {
      if (parent.expiresAt !== null) {
        if (requested.expiresAt === null) {
          throw new AttenuationError("processLifetime", "Perpetual child lifetime requested under expiring parent grant");
        }
        const pTime = new Date(parent.expiresAt).getTime();
        const cTime = new Date(requested.expiresAt).getTime();
        if (cTime > pTime) {
          throw new AttenuationError("processLifetime", `Child expiresAt (${requested.expiresAt}) outlives parent (${parent.expiresAt})`);
        }
      }
      effectiveExpiry = requested.expiresAt;
    }

    // 7. Budget Attenuation (Strict Subtraction / Containment)
    const pBudget = parent.budgetEscrow;
    const rBudget = requested.budget ?? {};

    const effectiveBudget = {
      maxPlannerTurns: Math.min(rBudget.maxPlannerTurns ?? pBudget.maxPlannerTurns, pBudget.maxPlannerTurns),
      maxModelCalls: Math.min(rBudget.maxModelCalls ?? pBudget.maxModelCalls, pBudget.maxModelCalls),
      maxTokens: Math.min(rBudget.maxTokens ?? pBudget.maxTokens, pBudget.maxTokens),
      maxCapabilityCalls: Math.min(rBudget.maxCapabilityCalls ?? pBudget.maxCapabilityCalls, pBudget.maxCapabilityCalls),
      maxRetries: Math.min(rBudget.maxRetries ?? pBudget.maxRetries, pBudget.maxRetries),
      maxExecutionTimeMs: Math.min(rBudget.maxExecutionTimeMs ?? pBudget.maxExecutionTimeMs, pBudget.maxExecutionTimeMs),
      maxArtifactBytes: Math.min(rBudget.maxArtifactBytes ?? pBudget.maxArtifactBytes, pBudget.maxArtifactBytes),
      maxConcurrentTasks: Math.min(rBudget.maxConcurrentTasks ?? pBudget.maxConcurrentTasks, pBudget.maxConcurrentTasks),
      maxSubprocesses: Math.min(rBudget.maxSubprocesses ?? pBudget.maxSubprocesses, pBudget.maxSubprocesses),
    };

    // If child explicitly requested more than parent has remaining in envelope, reject
    if (rBudget.maxTokens !== undefined && rBudget.maxTokens > pBudget.maxTokens) {
      throw new AttenuationError("tokens", `Requested tokens (${rBudget.maxTokens}) exceeds parent remaining (${pBudget.maxTokens})`);
    }
    if (rBudget.maxModelCalls !== undefined && rBudget.maxModelCalls > pBudget.maxModelCalls) {
      throw new AttenuationError("modelCalls", `Requested modelCalls (${rBudget.maxModelCalls}) exceeds parent (${pBudget.maxModelCalls})`);
    }
    if (rBudget.maxCapabilityCalls !== undefined && rBudget.maxCapabilityCalls > pBudget.maxCapabilityCalls) {
      throw new AttenuationError("capabilities", `Requested capabilityCalls (${rBudget.maxCapabilityCalls}) exceeds parent (${pBudget.maxCapabilityCalls})`);
    }
    if (rBudget.maxExecutionTimeMs !== undefined && rBudget.maxExecutionTimeMs > pBudget.maxExecutionTimeMs) {
      throw new AttenuationError("executionTime", `Requested execution time exceeds parent timeout`);
    }
    if (rBudget.maxArtifactBytes !== undefined && rBudget.maxArtifactBytes > pBudget.maxArtifactBytes) {
      throw new AttenuationError("artifactBytes", `Requested artifact bytes exceeds parent limit`);
    }
    if (rBudget.maxSubprocesses !== undefined && rBudget.maxSubprocesses > pBudget.maxSubprocesses) {
      throw new AttenuationError("subprocesses", `Requested subprocesses exceeds parent limit`);
    }
    if (rBudget.maxConcurrentTasks !== undefined && rBudget.maxConcurrentTasks > pBudget.maxConcurrentTasks) {
      throw new AttenuationError("concurrency", `Requested concurrency exceeds parent limit`);
    }

    // 8. Delegation Depth Monotonicity
    const effectiveDepth = parent.depth + 1;
    if (effectiveDepth > 3) {
      throw new AttenuationError("delegationDepth", `Delegation depth ${effectiveDepth} exceeds hard maximum depth of 3`);
    }

    const effectiveEnvelope: EffectiveAuthorityEnvelope = EffectiveAuthorityEnvelopeSchema.parse({
      capabilities: effectiveCaps,
      constraints: effectiveConstraints,
      riskCeiling: effectiveRisk,
      isolationProfile: effectiveIsolation,
      allowHostExecution: effectiveAllowHost,
      budgetEscrow: effectiveBudget,
      expiresAt: effectiveExpiry,
      depth: effectiveDepth,
      maxChildren: Math.min(parent.maxChildren, 3),
    });

    return { ok: true, effective: effectiveEnvelope };
  } catch (err) {
    if (err instanceof AttenuationError) {
      return { ok: false, error: err.message, dimension: err.dimension };
    }
    return { ok: false, error: String(err), dimension: "unknown" };
  }
}
