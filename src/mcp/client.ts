// FORGE MCP (Model Context Protocol) Client — stdio JSON-RPC 2.0 Connection Manager.
// Manages process lifecycle, handshake, tool discovery, and governed tool dispatch.
// Never allows malformed server output to crash the host or bypass authority.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  type McpServerConfig,
  type McpConnectionState,
  type DiscoveredMcpTool,
  type McpInitializeResult,
  type McpToolsListResult,
  type McpToolCallResult,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcResponse,
  McpError,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024; // 4 MiB
const STDERR_BUFFER_MAX = 4096;

interface PendingRequest {
  id: string | number;
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  public state: McpConnectionState = "created";
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private discoveredTools: DiscoveredMcpTool[] = [];
  public serverInfo: McpInitializeResult["serverInfo"] | null = null;

  public get pid(): number | undefined {
    return this.child?.pid;
  }

  constructor(public readonly config: McpServerConfig) {}

  /**
   * Launch the MCP server child process over stdio.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      this.state = "closed";
      throw new McpError("MCP_ABORTED", "connection aborted prior to startup");
    }

    if (this.state !== "created" && this.state !== "closed" && this.state !== "failed") {
      throw new McpError("MCP_PROTOCOL_ERROR", `cannot connect while in state "${this.state}"`);
    }

    this.state = "starting";
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    // Sanitize child environment: never leak ambient host secrets (API keys, tokens)
    const cleanEnv: Record<string, string> = {};
    for (const k of [
      "PATH", "Path", "SYSTEMROOT", "SystemRoot", "COMSPEC", "PATHEXT",
      "WINDIR", "windir", "TEMP", "TMP", "HOME", "USER", "LOGNAME",
      "SHELL", "LANG", "LC_ALL", "TMPDIR",
    ]) {
      const v = process.env[k];
      if (v !== undefined) cleanEnv[k] = v;
    }
    if (this.config.env) {
      for (const [k, v] of Object.entries(this.config.env)) {
        if (v !== undefined) cleanEnv[k] = v;
      }
    }

    try {
      this.child = spawn(this.config.command, this.config.args, {
        cwd: this.config.cwd ?? process.cwd(),
        env: cleanEnv,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.state = "failed";
      throw new McpError("MCP_SERVER_START_FAILED", `failed to spawn ${this.config.command}: ${String(err)}`, err);
    }

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          this.close().catch(() => {});
        },
        { once: true },
      );
    }

    this.child.on("error", (err) => {
      this.state = "failed";
      this.rejectAllPending(new McpError("MCP_SERVER_START_FAILED", `child process error: ${err.message}`, err));
    });

    this.child.on("exit", (code, signal) => {
      const priorState = this.state;
      this.state = priorState === "closing" ? "closed" : "failed";
      const exitNote = `MCP server "${this.config.id}" exited with code ${code}, signal ${signal}. Stderr: ${this.stderrBuffer.slice(-500)}`;
      this.rejectAllPending(new McpError("MCP_SERVER_EXITED", exitNote));
    });

    this.child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdoutChunk(chunk);
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrBuffer = (this.stderrBuffer + text).slice(-STDERR_BUFFER_MAX);
    });
  }

  /**
   * Perform the MCP handshake: `initialize` request + `notifications/initialized`.
   */
  async initialize(): Promise<McpInitializeResult> {
    if (this.state !== "starting") {
      throw new McpError("MCP_INITIALIZATION_FAILED", `must connect before initialize (current state: ${this.state})`);
    }

    this.state = "initializing";

    try {
      const initResult = (await this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        clientInfo: {
          name: "FORGE",
          version: "1.2.0",
        },
      })) as McpInitializeResult;

      this.serverInfo = initResult.serverInfo;

      // Send the mandatory initialized notification
      this.sendNotification("notifications/initialized", {});

      this.state = "ready";
      return initResult;
    } catch (err) {
      this.state = "failed";
      throw new McpError("MCP_INITIALIZATION_FAILED", `handshake failed with server "${this.config.id}": ${String(err)}`, err);
    }
  }

  /**
   * Discover available tools from the server via `tools/list`.
   */
  async listTools(): Promise<DiscoveredMcpTool[]> {
    this.assertReady();

    const raw = (await this.sendRequest("tools/list", {})) as McpToolsListResult;
    const tools = raw?.tools ?? [];

    this.discoveredTools = tools.map((t) => ({
      serverId: this.config.id,
      toolName: t.name,
      namespacedName: `mcp.${this.config.id}.${t.name}`,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object" },
    }));

    return [...this.discoveredTools];
  }

  /**
   * Invoke a tool on the server via `tools/call`.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<McpToolCallResult> {
    this.assertReady();

    const result = (await this.sendRequest(
      "tools/call",
      {
        name: toolName,
        arguments: args,
      },
      opts?.timeoutMs,
      opts?.signal,
    )) as McpToolCallResult;

    if (!result || typeof result !== "object" || !Array.isArray(result.content)) {
      throw new McpError("MCP_INVALID_RESPONSE", `malformed tool result from "${this.config.id}/${toolName}"`, result);
    }

    return result;
  }

  /**
   * Gracefully close the connection and kill the child process.
   */
  async close(): Promise<void> {
    if (this.state === "closed" || !this.child) {
      this.state = "closed";
      return;
    }

    this.state = "closing";
    this.rejectAllPending(new McpError("MCP_SERVER_EXITED", "connection closed by host"));

    try {
      this.child.stdin.end();
    } catch {}

    const child = this.child;
    const pid = child.pid;
    if (pid) {
      if (process.platform === "win32") {
        try {
          spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
        } catch {
          try { child.kill("SIGKILL"); } catch {}
        }
      } else {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try { child.kill("SIGKILL"); } catch {}
        }
      }
    }

    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        resolve();
      }, 500);

      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
    });

    this.child = null;
    this.state = "closed";
  }

  // -------------------------------------------------------------------------
  // JSON-RPC Transport Internals
  // -------------------------------------------------------------------------

  private sendRequest(
    method: string,
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.child || !this.child.stdin.writable) {
      throw new McpError("MCP_SERVER_EXITED", `cannot send request "${method}", child stdin is not writable`);
    }

    const id = this.nextRequestId++;
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const effectiveTimeout = timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new McpError("MCP_TIMEOUT", `request "${method}" (id: ${id}) timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);

      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(new McpError("MCP_TIMEOUT", `request "${method}" (id: ${id}) aborted by caller`));
        }, { once: true });
      }

      this.pendingRequests.set(id, { id, method, resolve, reject, timer });

      try {
        const payload = JSON.stringify(req) + "\n";
        this.child!.stdin.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new McpError("MCP_PROTOCOL_ERROR", `failed to write request to stdin: ${String(err)}`, err));
      }
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.child || !this.child.stdin.writable) return;
    const notif: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    try {
      this.child.stdin.write(JSON.stringify(notif) + "\n");
    } catch {}
  }

  private handleStdoutChunk(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");

    const maxBytes = this.config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    if (this.stdoutBuffer.length > maxBytes * 2) {
      this.state = "failed";
      this.rejectAllPending(new McpError("MCP_OUTPUT_LIMIT", `server exceeded maximum message buffer size (${maxBytes} bytes)`));
      this.close().catch(() => {});
      return;
    }

    let newlineIdx: number;
    while ((newlineIdx = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);

      if (!line) continue;
      this.processIncomingMessage(line);
    }
  }

  private processIncomingMessage(rawLine: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(rawLine) as JsonRpcResponse;
    } catch {
      // Non-JSON line from server stdout (e.g. debug logging leaked to stdout)
      return;
    }

    if (msg.id === undefined || msg.id === null) {
      // Server notification or protocol message without id
      return;
    }

    const pending = this.pendingRequests.get(msg.id);
    if (!pending) return;

    this.pendingRequests.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.error) {
      pending.reject(
        new McpError(
          "MCP_TOOL_CALL_FAILED",
          `server error [${msg.error.code}]: ${msg.error.message}`,
          msg.error.data,
        ),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pendingRequests.clear();
  }

  private assertReady(): void {
    if (this.state !== "ready") {
      throw new McpError("MCP_PROTOCOL_ERROR", `MCP client for "${this.config.id}" is in state "${this.state}", expected "ready"`);
    }
  }
}
