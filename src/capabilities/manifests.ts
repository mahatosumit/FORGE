// FORGE Capability Manifests V2 (Step 6 Phase 1 & 9).
// Canonical V2 manifests for all 11 built-in and adapter capabilities.

import {
  type CapabilityManifestV2,
  type Sha256Hex,
  CapabilityManifestV2Schema,
} from "../contracts/capabilities.js";

const CORE_HASH = "0000000000000000000000000000000000000000000000000000000000000000" as Sha256Hex;

export const fsManifestV2: CapabilityManifestV2 = CapabilityManifestV2Schema.parse({
  id: "fs",
  version: "1.0.0",
  name: "Filesystem Workspace Mutation",
  description: "Read, write, append, patch, and mkdir within the workspace root",
  proposalKind: "fs",
  riskTier: "R1",
  riskVector: {
    sideEffectScope: "workspace",
    networkScope: "none",
    resourceIntensity: "bounded",
    dataSensitivity: "workspace-internal",
    injectionRisk: "none",
  },
  sideEffects: ["workspace_fs"],
  concurrency: "parallel",
  constraintsVocab: ["paths", "exclusive"],
  requiredGrants: [],
  idempotency: "conditionally_idempotent",
  timeoutMs: 30000,
  resourceLimits: {
    maxOutputBytes: 2 * 1024 * 1024,
    maxArtifactBytes: 50 * 1024 * 1024,
    maxSubprocesses: 0,
  },
  verification: {
    defaultStrategy: "file_state",
    failureSignals: ["patch context mismatch", "ENOENT"],
  },
  provenance: {
    pack: "core",
    hash: CORE_HASH,
  },
  status: "active",
});

export const shellManifestV2: CapabilityManifestV2 = CapabilityManifestV2Schema.parse({
  id: "shell",
  version: "1.0.0",
  name: "Vector-Only Shell Command Execution",
  description: "Execute argv vector directly via child_process without shell interpolation",
  proposalKind: "shell",
  riskTier: "R4",
  riskVector: {
    sideEffectScope: "process-lifecycle",
    networkScope: "none",
    resourceIntensity: "heavy-subprocess",
    dataSensitivity: "secret-bearer",
    injectionRisk: "none",
  },
  sideEffects: ["process_spawn"],
  concurrency: "exclusive",
  constraintsVocab: ["argvClass", "exclusive", "secretNames"],
  requiredGrants: [],
  idempotency: "non_idempotent",
  timeoutMs: 120000,
  resourceLimits: {
    maxOutputBytes: 2 * 1024 * 1024,
    maxArtifactBytes: 50 * 1024 * 1024,
    maxSubprocesses: 1,
  },
  verification: {
    defaultStrategy: "exit_code",
    failureSignals: ["exit non-zero", "spawn error"],
  },
  provenance: {
    pack: "core",
    hash: CORE_HASH,
  },
  status: "active",
});

export const gitManifestV2: CapabilityManifestV2 = CapabilityManifestV2Schema.parse({
  id: "git",
  version: "1.0.0",
  name: "Git Version Control Operations",
  description: "Inspect git status/diff and stage or commit workspace changes",
  proposalKind: "git",
  riskTier: "R1",
  riskVector: {
    sideEffectScope: "workspace",
    networkScope: "none",
    resourceIntensity: "bounded",
    dataSensitivity: "workspace-internal",
    injectionRisk: "none",
  },
  sideEffects: ["workspace_fs"],
  concurrency: "exclusive",
  constraintsVocab: ["paths", "exclusive"],
  requiredGrants: [],
  idempotency: "conditionally_idempotent",
  timeoutMs: 60000,
  resourceLimits: {
    maxOutputBytes: 2 * 1024 * 1024,
    maxArtifactBytes: 50 * 1024 * 1024,
    maxSubprocesses: 1,
  },
  verification: {
    defaultStrategy: "exit_code",
    failureSignals: ["fatal:", "error:"],
  },
  provenance: {
    pack: "core",
    hash: CORE_HASH,
  },
  status: "active",
});

export const httpManifestV2: CapabilityManifestV2 = CapabilityManifestV2Schema.parse({
  id: "http",
  version: "1.0.0",
  name: "Governed Mutating HTTP Client",
  description: "Execute governed mutating HTTP requests against authorized external hosts",
  proposalKind: "http",
  riskTier: "R3",
  riskVector: {
    sideEffectScope: "external-system",
    networkScope: "egress-write",
    resourceIntensity: "bounded",
    dataSensitivity: "secret-bearer",
    injectionRisk: "untrusted-web",
  },
  sideEffects: ["external_network", "secret_access"],
  concurrency: "parallel",
  constraintsVocab: ["hosts", "methods", "secretNames"],
  requiredGrants: [],
  idempotency: "non_idempotent",
  timeoutMs: 30000,
  resourceLimits: {
    maxOutputBytes: 2 * 1024 * 1024,
    maxArtifactBytes: 50 * 1024 * 1024,
    maxSubprocesses: 0,
  },
  verification: {
    defaultStrategy: "http_status",
    failureSignals: ["status >= 400", "fetch failed"],
  },
  provenance: {
    pack: "core",
    hash: CORE_HASH,
  },
  status: "active",
});

export const searchManifestV2: CapabilityManifestV2 = CapabilityManifestV2Schema.parse({
  id: "search",
  version: "1.0.0",
  name: "Workspace File Search",
  description: "Deterministic read-only search across workspace files",
  proposalKind: "search",
  riskTier: "R0",
  riskVector: {
    sideEffectScope: "none",
    networkScope: "none",
    resourceIntensity: "bounded",
    dataSensitivity: "workspace-internal",
    injectionRisk: "none",
  },
  sideEffects: ["none"],
  concurrency: "parallel",
  constraintsVocab: ["paths"],
  requiredGrants: [],
  idempotency: "pure_read",
  timeoutMs: 30000,
  resourceLimits: {
    maxOutputBytes: 2 * 1024 * 1024,
    maxArtifactBytes: 50 * 1024 * 1024,
    maxSubprocesses: 0,
  },
  verification: {
    defaultStrategy: "artifact_ref",
    failureSignals: [],
  },
  provenance: {
    pack: "core",
    hash: CORE_HASH,
  },
  status: "active",
});

export const verifyManifestV2: CapabilityManifestV2 = CapabilityManifestV2Schema.parse({
  id: "verify",
  version: "1.0.0",
  name: "Mechanical Verification Engine",
  description: "Mechanically evaluate criteria expressions independently of model claims",
  proposalKind: "verify",
  riskTier: "R0",
  riskVector: {
    sideEffectScope: "none",
    networkScope: "none",
    resourceIntensity: "bounded",
    dataSensitivity: "public",
    injectionRisk: "none",
  },
  sideEffects: ["none"],
  concurrency: "parallel",
  constraintsVocab: [],
  requiredGrants: [],
  idempotency: "pure_read",
  timeoutMs: 60000,
  resourceLimits: {
    maxOutputBytes: 2 * 1024 * 1024,
    maxArtifactBytes: 50 * 1024 * 1024,
    maxSubprocesses: 1,
  },
  verification: {
    defaultStrategy: "exit_code",
    failureSignals: ["matched: false"],
  },
  provenance: {
    pack: "core",
    hash: CORE_HASH,
  },
  status: "active",
});

export const artifactManifestV2: CapabilityManifestV2 = CapabilityManifestV2Schema.parse({
  id: "artifact",
  version: "1.0.0",
  name: "Mission Artifact Capture",
  description: "Register content-addressed outputs as immutable mission artifacts",
  proposalKind: "artifact",
  riskTier: "R0",
  riskVector: {
    sideEffectScope: "workspace",
    networkScope: "none",
    resourceIntensity: "negligible",
    dataSensitivity: "workspace-internal",
    injectionRisk: "none",
  },
  sideEffects: ["workspace_fs"],
  concurrency: "parallel",
  constraintsVocab: ["paths"],
  requiredGrants: [],
  idempotency: "idempotent",
  timeoutMs: 30000,
  resourceLimits: {
    maxOutputBytes: 2 * 1024 * 1024,
    maxArtifactBytes: 50 * 1024 * 1024,
    maxSubprocesses: 0,
  },
  verification: {
    defaultStrategy: "artifact_ref",
    failureSignals: ["not found in artifact staging"],
  },
  provenance: {
    pack: "core",
    hash: CORE_HASH,
  },
  status: "active",
});

export const webSearchManifestV2: CapabilityManifestV2 = CapabilityManifestV2Schema.parse({
  id: "web_search",
  version: "1.0.0",
  name: "Governed Web Search",
  description: "Query search engine provider for web results with clean structured items",
  proposalKind: "web_search",
  riskTier: "R2",
  riskVector: {
    sideEffectScope: "none",
    networkScope: "egress-read",
    resourceIntensity: "bounded",
    dataSensitivity: "secret-bearer",
    injectionRisk: "untrusted-web",
  },
  sideEffects: ["external_network", "secret_access"],
  concurrency: "parallel",
  constraintsVocab: ["secretNames"],
  requiredGrants: [],
  idempotency: "pure_read",
  timeoutMs: 30000,
  resourceLimits: {
    maxOutputBytes: 2 * 1024 * 1024,
    maxArtifactBytes: 50 * 1024 * 1024,
    maxSubprocesses: 0,
  },
  verification: {
    defaultStrategy: "artifact_ref",
    failureSignals: ["error fetching web search"],
  },
  provenance: {
    pack: "core",
    hash: CORE_HASH,
  },
  status: "active",
});

export const webFetchManifestV2: CapabilityManifestV2 = CapabilityManifestV2Schema.parse({
  id: "web_fetch",
  version: "1.0.0",
  name: "Governed Web Fetch",
  description: "Fetch web pages with per-hop redirect validation, SSRF defenses, and Markdown conversion",
  proposalKind: "web_fetch",
  riskTier: "R2",
  riskVector: {
    sideEffectScope: "none",
    networkScope: "egress-read",
    resourceIntensity: "bounded",
    dataSensitivity: "public",
    injectionRisk: "untrusted-web",
  },
  sideEffects: ["external_network"],
  concurrency: "parallel",
  constraintsVocab: ["hosts"],
  requiredGrants: [],
  idempotency: "pure_read",
  timeoutMs: 30000,
  resourceLimits: {
    maxOutputBytes: 2 * 1024 * 1024,
    maxArtifactBytes: 50 * 1024 * 1024,
    maxSubprocesses: 0,
  },
  verification: {
    defaultStrategy: "http_status",
    failureSignals: ["status >= 400", "redirect escape", "SSRF blocked"],
  },
  provenance: {
    pack: "core",
    hash: CORE_HASH,
  },
  status: "active",
});

export const mcpCallManifestV2: CapabilityManifestV2 = CapabilityManifestV2Schema.parse({
  id: "mcp_call",
  version: "1.0.0",
  name: "Model Context Protocol Tool Invocation",
  description: "Invoke external MCP server tools governed by mcpTools constraints",
  proposalKind: "mcp_call",
  riskTier: "R3",
  riskVector: {
    sideEffectScope: "external-system",
    networkScope: "egress-write",
    resourceIntensity: "bounded",
    dataSensitivity: "public",
    injectionRisk: "untrusted-external-doc",
  },
  sideEffects: ["external_network", "process_spawn"],
  concurrency: "parallel",
  constraintsVocab: ["mcpTools"],
  requiredGrants: [],
  idempotency: "non_idempotent",
  timeoutMs: 60000,
  resourceLimits: {
    maxOutputBytes: 2 * 1024 * 1024,
    maxArtifactBytes: 50 * 1024 * 1024,
    maxSubprocesses: 1,
  },
  verification: {
    defaultStrategy: "artifact_ref",
    failureSignals: ["isError: true", "JSON-RPC error"],
  },
  provenance: {
    pack: "mcp-adapter",
    hash: CORE_HASH,
  },
  status: "active",
});

export const docParseManifestV2: CapabilityManifestV2 = CapabilityManifestV2Schema.parse({
  id: "doc_parse",
  version: "1.0.0",
  name: "Governed Document Ingestion",
  description: "Parse PDF, DOCX, XLSX, PPTX, CSV, images with bomb protection into structured text",
  proposalKind: "doc_parse",
  riskTier: "R0",
  riskVector: {
    sideEffectScope: "none",
    networkScope: "none",
    resourceIntensity: "bounded",
    dataSensitivity: "workspace-internal",
    injectionRisk: "untrusted-external-doc",
  },
  sideEffects: ["none"],
  concurrency: "parallel",
  constraintsVocab: ["paths"],
  requiredGrants: [],
  idempotency: "pure_read",
  timeoutMs: 60000,
  resourceLimits: {
    maxOutputBytes: 2 * 1024 * 1024,
    maxArtifactBytes: 50 * 1024 * 1024,
    maxSubprocesses: 0,
  },
  verification: {
    defaultStrategy: "artifact_ref",
    failureSignals: ["parse error", "zip bomb detected"],
  },
    provenance: {
    pack: "core",
    hash: CORE_HASH,
  },
  status: "active",
});

export const mcpServerStartManifestV2: CapabilityManifestV2 = CapabilityManifestV2Schema.parse({
  id: "mcp_server_start",
  version: "1.0.0",
  name: "MCP Server Lifecycle Start",
  description: "Start and initialize a configured Model Context Protocol server process",
  proposalKind: "mcp_server_start",
  riskTier: "R3",
  riskVector: {
    sideEffectScope: "process-lifecycle",
    networkScope: "loopback",
    resourceIntensity: "heavy-subprocess",
    dataSensitivity: "workspace-internal",
    injectionRisk: "trusted-schema",
  },
  sideEffects: ["process_spawn"],
  concurrency: "exclusive",
  constraintsVocab: ["mcpServers"],
  requiredGrants: ["mcp_server_start"],
  idempotency: "non_idempotent",
  timeoutMs: 30000,
  resourceLimits: {
    maxOutputBytes: 1024 * 1024,
    maxArtifactBytes: 5 * 1024 * 1024,
    maxSubprocesses: 1,
  },
  verification: {
    defaultStrategy: "exit_code",
    failureSignals: ["MCP_SERVER_START_FAILED", "connection closed"],
  },
  provenance: {
    pack: "core",
    hash: CORE_HASH,
  },
  status: "active",
});

export const mcpServerStopManifestV2: CapabilityManifestV2 = CapabilityManifestV2Schema.parse({
  id: "mcp_server_stop",
  version: "1.0.0",
  name: "MCP Server Lifecycle Stop",
  description: "Gracefully stop a running Model Context Protocol server process and its process tree",
  proposalKind: "mcp_server_stop",
  riskTier: "R2",
  riskVector: {
    sideEffectScope: "process-lifecycle",
    networkScope: "none",
    resourceIntensity: "negligible",
    dataSensitivity: "public",
    injectionRisk: "none",
  },
  sideEffects: ["none"],
  concurrency: "exclusive",
  constraintsVocab: ["mcpServers"],
  requiredGrants: ["mcp_server_stop"],
  idempotency: "idempotent",
  timeoutMs: 15000,
  resourceLimits: {
    maxOutputBytes: 1024 * 1024,
    maxArtifactBytes: 1024 * 1024,
    maxSubprocesses: 0,
  },
  verification: {
    defaultStrategy: "exit_code",
    failureSignals: ["failed to stop"],
  },
  provenance: {
    pack: "core",
    hash: CORE_HASH,
  },
  status: "active",
});

export const ALL_V2_MANIFESTS = [
  fsManifestV2,
  shellManifestV2,
  gitManifestV2,
  httpManifestV2,
  searchManifestV2,
  verifyManifestV2,
  artifactManifestV2,
  webSearchManifestV2,
  webFetchManifestV2,
  mcpCallManifestV2,
  mcpServerStartManifestV2,
  mcpServerStopManifestV2,
  docParseManifestV2,
] as const;
