# Governed Model Context Protocol (MCP) Client

FORGE implements native, fully-governed Model Context Protocol (MCP) client support over stdio JSON-RPC 2.0.

Unlike unstructured agent frameworks where the model directly connects to or executes arbitrary MCP tools, FORGE maintains its core invariant:

$$\text{Model} \to \text{Proposal} \to \text{Authority Gate} \to \text{Capability Host} \to \text{MCP Client} \to \text{Evidence Capture} \to \text{Cryptographic Ledger}$$

---

## 1. Core Principles

1. **Gate Authority Invariant**: Tool discovery is distinct from tool authorization. Discovering a tool from an MCP server does NOT grant authority to invoke it.
2. **Deny-by-Default Execution**: Every `mcp_call` requires an explicit, active grant matching the target server and tool name.
3. **Capture-Time Redaction**: Request payloads and tool outputs are captured into content-addressed storage with automatic secret scrubbing. Granted secrets never leak into persistent artifacts or context.
4. **Adversarial Output Isolation**: Outputs returned by external MCP tools are classified as untrusted external data and fenced with injection-resistant delimiters (`<<< UNTRUSTED_MCP_OUTPUT (...) >>>`).
5. **Deterministic Ledger Anchoring**: Every MCP call records a runtime-authored `observation.mcp` entry into the append-only cryptographic journal (`journal.jsonl`) with `requestRef`, `resultRef`, `durationMs`, and status.

---

## 2. Protocol & Transport

- **Transport**: `stdio` child process execution (`spawn`), communicating via line-buffered JSON-RPC 2.0.
- **Handshake**:
  1. FORGE launches child process and issues `initialize` request (`protocolVersion: "2024-11-05"`).
  2. Server responds with server metadata and tool capabilities.
  3. FORGE sends `notifications/initialized`.
  4. Server is transitioned to `ready` state.
- **Discovery**: `tools/list` enumerates all available tools, cached namespaced as `mcp.<serverId>.<toolName>`.
- **Execution**: `tools/call` executes approved tools with timeout enforcement and process isolation.

---

## 3. Grant Vocabulary & Authorization Patterns

The `mcp_call` capability is governed by the `mcpTools` constraint:

```typescript
{
  capability: "mcp_call",
  constraints: {
    mcpTools: ["github.*", "echo.message", "*"]
  }
}
```

Pattern Matching:
- Universal Wildcard: `*` grants all MCP tools across all servers.
- Server Wildcard: `github.*` grants any tool on server `github`.
- Exact Match: `github.create_issue` grants only that specific tool.

---

## 4. Proposal & Observation Contracts

### Proposal Schema (`mcp_call`)
```json
{
  "capability": "mcp_call",
  "args": {
    "serverId": "filesystem",
    "toolName": "read_file",
    "arguments": {
      "path": "/workspace/README.md"
    }
  }
}
```

### Observation Record (`observation.mcp`)
```json
{
  "kind": "observation.mcp",
  "author": "runtime",
  "body": {
    "serverId": "filesystem",
    "toolName": "read_file",
    "status": "success",
    "durationMs": 42,
    "requestRef": "a1b2c3...",
    "resultRef": "d4e5f6...",
    "error": null,
    "truncated": false
  }
}
```

---

## 5. Server Registry Configuration

MCP servers are registered in `.forge/mcp_servers.json`:

```json
[
  {
    "id": "github",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "..."
    },
    "enabled": true
  }
]
```
