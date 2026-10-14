// FORGE capabilities — mcp (mcp_call).
// Governed Model Context Protocol (MCP) tool invocation over stdio JSON-RPC.
// Every invocation is gate-approved, executed through the MCP client,
// and captured into the artifact store and cryptographic ledger.

import type { CapabilityImpl, DispatchContext } from "../capability-host/types.js";
import type { Proposal } from "../contracts/index.js";
import { CapabilityManifestSchema } from "../contracts/grants.js";
import { McpRegistry } from "../mcp/registry.js";
import { McpError } from "../mcp/types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024; // 512 KiB

let globalRegistry: McpRegistry | null = null;

export function getMcpRegistry(forgeDir: string = ".forge"): McpRegistry {
  if (!globalRegistry) {
    globalRegistry = new McpRegistry(forgeDir);
  }
  return globalRegistry;
}

export function setMcpRegistry(reg: McpRegistry | null): void {
  globalRegistry = reg;
}

export const mcpCallImpl: CapabilityImpl = {
  manifest: CapabilityManifestSchema.parse({
    id: "mcp_call",
    version: "1.0.0",
    purpose: "invoke discovered tools on governed MCP servers over stdio JSON-RPC",
    environments: ["local", "container"],
    proposalKind: "mcp_call",
    constraintsVocab: ["mcpTools"],
    concurrency: "parallel",
    idempotent: false,
    riskClass: ["execute"],
    provenance: { pack: "core", hash: "0000000000000000000000000000000000000000000000000000000000000000" },
  }),

  async run(proposal: Proposal, ctx: DispatchContext, opts: { timeoutMs: number; signal: AbortSignal }) {
    if (proposal.capability !== "mcp_call") throw new Error("mismatch");
    const { serverId, toolName, arguments: toolArgs } = proposal.args;

    // 1. Capture request payload as content-addressed artifact
    const reqBytes = new TextEncoder().encode(JSON.stringify({ serverId, toolName, arguments: toolArgs }, null, 2));
    const requestRef = ctx.capture(reqBytes);

    const startTime = Date.now();
    const registry = getMcpRegistry();

    try {
      const client = registry.getClient(serverId);
      const callResult = await client.callTool(toolName, toolArgs as Record<string, unknown>, {
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      });

      const durationMs = Date.now() - startTime;
      const isError = Boolean(callResult.isError);

      // Extract and combine text contents from result with bounded memory
      let combined = "";
      let truncated = false;
      for (const item of callResult.content) {
        let chunkText = "";
        if (item.type === "text" && typeof item.text === "string") {
          chunkText = item.text;
        } else if (item.data) {
          chunkText = `[${item.type}: ${item.mimeType ?? "binary"} (${item.data.length} chars)]`;
        }
        if (combined.length + chunkText.length > DEFAULT_MAX_OUTPUT_BYTES) {
          combined += (combined ? "\n" : "") + chunkText.slice(0, Math.max(0, DEFAULT_MAX_OUTPUT_BYTES - combined.length));
          truncated = true;
          break;
        } else {
          combined = combined ? `${combined}\n${chunkText}` : chunkText;
        }
      }

      const resBytes = new TextEncoder().encode(combined);
      const resultRef = ctx.capture(resBytes);

      return {
        observationKind: "observation.mcp" as const,
        observation: {
          serverId,
          toolName,
          status: isError ? ("tool_error" as const) : ("success" as const),
          durationMs,
          requestRef,
          resultRef,
          error: isError ? (combined.slice(0, 1000) || "tool returned error") : null,
          truncated,
        },
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = String(err instanceof Error ? err.message : err);
      const isTimeout = err instanceof McpError && err.code === "MCP_TIMEOUT";

      // Capture error details as artifact
      const errBytes = new TextEncoder().encode(JSON.stringify({ error: errorMsg, durationMs }, null, 2));
      const resultRef = ctx.capture(errBytes);

      return {
        observationKind: "observation.mcp" as const,
        observation: {
          serverId,
          toolName,
          status: isTimeout ? ("timeout" as const) : ("protocol_error" as const),
          durationMs,
          requestRef,
          resultRef,
          error: errorMsg.slice(0, 4000),
          truncated: false,
        },
      };
    }
  },
};

export const mcpServerStartImpl: CapabilityImpl = {
  manifest: CapabilityManifestSchema.parse({
    id: "mcp_server_start",
    version: "1.0.0",
    purpose: "start and initialize a configured MCP server over stdio JSON-RPC",
    environments: ["local", "container"],
    proposalKind: "mcp_server_start",
    constraintsVocab: ["mcpServers"],
    concurrency: "exclusive",
    idempotent: false,
    riskClass: ["execute"],
    provenance: { pack: "core", hash: "0000000000000000000000000000000000000000000000000000000000000000" },
  }),

  async run(proposal: Proposal, ctx: DispatchContext, opts: { timeoutMs: number; signal: AbortSignal }) {
    if (proposal.capability !== "mcp_server_start") throw new Error("mismatch");
    const { serverId } = proposal.args;
    const startTime = Date.now();
    const registry = getMcpRegistry();
    const config = registry.getServer(serverId);
    if (!config) {
      throw new McpError("MCP_SERVER_NOT_FOUND", `server "${serverId}" not configured`);
    }

    try {
      const { client, tools } = await registry.startServer(serverId, { signal: opts.signal });
      const durationMs = Date.now() - startTime;
      return {
        observationKind: "observation.mcp_server_start" as const,
        observation: {
          serverId,
          command: config.command,
          args: config.args,
          pid: client.pid ?? null,
          status: "started" as const,
          discoveredTools: tools.map((t) => t.toolName),
          durationMs,
        },
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = String(err instanceof Error ? err.message : err);
      return {
        observationKind: "observation.mcp_server_start" as const,
        observation: {
          serverId,
          command: config.command,
          args: config.args,
          pid: null,
          status: "failed" as const,
          discoveredTools: [],
          durationMs,
          error: errorMsg,
        },
      };
    }
  },
};

export const mcpServerStopImpl: CapabilityImpl = {
  manifest: CapabilityManifestSchema.parse({
    id: "mcp_server_stop",
    version: "1.0.0",
    purpose: "gracefully terminate a running MCP server and its process tree",
    environments: ["local", "container"],
    proposalKind: "mcp_server_stop",
    constraintsVocab: ["mcpServers"],
    concurrency: "exclusive",
    idempotent: true,
    riskClass: ["execute"],
    provenance: { pack: "core", hash: "0000000000000000000000000000000000000000000000000000000000000000" },
  }),

  async run(proposal: Proposal, ctx: DispatchContext, opts: { timeoutMs: number; signal: AbortSignal }) {
    if (proposal.capability !== "mcp_server_stop") throw new Error("mismatch");
    const { serverId } = proposal.args;
    const startTime = Date.now();
    const registry = getMcpRegistry();

    try {
      await registry.stopServer(serverId);
      const durationMs = Date.now() - startTime;
      return {
        observationKind: "observation.mcp_server_stop" as const,
        observation: {
          serverId,
          status: "stopped" as const,
          durationMs,
        },
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = String(err instanceof Error ? err.message : err);
      return {
        observationKind: "observation.mcp_server_stop" as const,
        observation: {
          serverId,
          status: "failed" as const,
          durationMs,
          error: errorMsg,
        },
      };
    }
  },
};
