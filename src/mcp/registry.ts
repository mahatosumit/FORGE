// FORGE MCP Server Registry — Configuration & Lifecycle Management.
// Persists trusted server definitions and manages active connections.
// Discovered tools are cached with canonical namespace `mcp.<serverId>.<toolName>`.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type McpServerConfig, type DiscoveredMcpTool, McpError } from "./types.js";
import { McpClient } from "./client.js";

export class McpRegistry {
  private servers = new Map<string, McpServerConfig>();
  private clients = new Map<string, McpClient>();
  private toolCache = new Map<string, DiscoveredMcpTool[]>();
  private readonly configPath: string;

  constructor(forgeDir: string, initialServers?: McpServerConfig[]) {
    mkdirSync(forgeDir, { recursive: true });
    this.configPath = join(forgeDir, "mcp_servers.json");

    if (initialServers) {
      for (const s of initialServers) {
        this.servers.set(s.id, s);
      }
    } else {
      this.loadConfig();
    }
  }

  private loadConfig(): void {
    if (!existsSync(this.configPath)) return;
    try {
      const raw = readFileSync(this.configPath, "utf8");
      const list = JSON.parse(raw) as McpServerConfig[];
      if (Array.isArray(list)) {
        for (const s of list) {
          if (s && typeof s.id === "string") {
            this.servers.set(s.id, s);
          }
        }
      }
    } catch {
      // Non-fatal fallback
    }
  }

  public saveConfig(): void {
    try {
      const list = Array.from(this.servers.values());
      writeFileSync(this.configPath, JSON.stringify(list, null, 2), "utf8");
    } catch {
      // Non-fatal
    }
  }

  /**
   * Register or update an MCP server configuration.
   */
  public registerServer(config: McpServerConfig): void {
    this.servers.set(config.id, { ...config });
    this.saveConfig();
  }

  /**
   * Remove an MCP server configuration and terminate its client if running.
   */
  public async removeServer(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (client) {
      await client.close().catch(() => {});
      this.clients.delete(id);
    }
    this.servers.delete(id);
    this.toolCache.delete(id);
    this.saveConfig();
  }

  public getServer(id: string): McpServerConfig | undefined {
    return this.servers.get(id);
  }

  public listServers(): McpServerConfig[] {
    return Array.from(this.servers.values());
  }

  /**
   * Pure in-memory lookup of an already-running MCP client.
   * NEVER starts, connects, or spawns a server process.
   */
  public getClient(id: string): McpClient {
    const config = this.servers.get(id);
    if (!config) {
      throw new McpError("MCP_SERVER_NOT_FOUND", `no configured MCP server with id "${id}"`);
    }
    if (!config.enabled) {
      throw new McpError("MCP_AUTHORITY_DENIED", `MCP server "${id}" is currently disabled`);
    }

    const client = this.clients.get(id);
    if (!client || client.state !== "ready") {
      throw new McpError(
        "MCP_SERVER_NOT_RUNNING",
        `MCP server "${id}" is not running (requires authorized mcp_server_start proposal)`,
      );
    }

    return client;
  }

  /**
   * Explicit governed server start operation.
   * Invoked strictly through governed mcp_server_start capability execution.
   */
  public async startServer(
    id: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ client: McpClient; tools: DiscoveredMcpTool[] }> {
    const config = this.servers.get(id);
    if (!config) {
      throw new McpError("MCP_SERVER_NOT_FOUND", `no configured MCP server with id "${id}"`);
    }
    if (!config.enabled) {
      throw new McpError("MCP_AUTHORITY_DENIED", `MCP server "${id}" is currently disabled`);
    }

    let client = this.clients.get(id);
    if (client && client.state === "ready") {
      const cached = this.toolCache.get(id) ?? [];
      return { client, tools: cached };
    }
    if (client) {
      await client.close().catch(() => {});
    }

    client = new McpClient(config);
    this.clients.set(id, client);
    await client.connect(opts?.signal);
    await client.initialize();
    const tools = await client.listTools();
    this.toolCache.set(id, tools);
    return { client, tools };
  }

  /**
   * Explicit governed server stop operation.
   * Invoked strictly through governed mcp_server_stop capability execution.
   */
  public async stopServer(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (client) {
      await client.close().catch(() => {});
      this.clients.delete(id);
    }
    this.toolCache.delete(id);
  }

  /**
   * Return all discovered tools across all enabled servers.
   */
  public listAllDiscoveredTools(): DiscoveredMcpTool[] {
    const out: DiscoveredMcpTool[] = [];
    for (const tools of this.toolCache.values()) {
      out.push(...tools);
    }
    return out;
  }

  /**
   * Close all active MCP connections (e.g. on engine shutdown).
   */
  public async closeAll(): Promise<void> {
    const closes: Promise<void>[] = [];
    for (const client of this.clients.values()) {
      closes.push(client.close().catch(() => {}));
    }
    await Promise.all(closes);
    this.clients.clear();
  }
}
