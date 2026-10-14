// FORGE MCP (Model Context Protocol) — Core Types & Contracts.
// Governed external tool integration over JSON-RPC 2.0 stdio.
// ADR-010 / KERNEL primitive #6 integration.

export type McpConnectionState =
  | "created"
  | "starting"
  | "initializing"
  | "ready"
  | "closing"
  | "closed"
  | "failed";

export type McpErrorCode =
  | "MCP_SERVER_NOT_FOUND"
  | "MCP_SERVER_START_FAILED"
  | "MCP_INITIALIZATION_FAILED"
  | "MCP_PROTOCOL_ERROR"
  | "MCP_TOOL_NOT_FOUND"
  | "MCP_TOOL_CALL_FAILED"
  | "MCP_TIMEOUT"
  | "MCP_OUTPUT_LIMIT"
  | "MCP_SERVER_EXITED"
  | "MCP_INVALID_RESPONSE"
  | "MCP_AUTHORITY_DENIED"
  | "MCP_ABORTED"
  | "MCP_SERVER_NOT_RUNNING";

export class McpError extends Error {
  constructor(
    public readonly code: McpErrorCode,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = "McpError";
  }
}

/**
 * Governed configuration for an external MCP server process.
 */
export interface McpServerConfig {
  id: string; // e.g. "github", "postgres", "sqlite", "test-server"
  name: string;
  command: string; // e.g. "npx", "node", "python"
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
  timeoutMs?: number; // default: 30_000
  maxMessageBytes?: number; // default: 4 MiB
}

/**
 * Normalized tool metadata discovered from an initialized MCP server.
 */
export interface DiscoveredMcpTool {
  serverId: string;
  toolName: string;
  namespacedName: string; // "mcp.<serverId>.<toolName>"
  description: string;
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 Protocol Message Types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
    resources?: unknown;
    prompts?: unknown;
    logging?: unknown;
  };
  serverInfo: {
    name: string;
    version?: string;
  };
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolsListResult {
  tools: McpToolDefinition[];
  nextCursor?: string;
}

export interface McpContentItem {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolCallResult {
  content: McpContentItem[];
  isError?: boolean;
}
