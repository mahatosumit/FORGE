import test from "node:test";
import assert from "node:assert/strict";
import { selectCapabilityCards, capabilityCatalogLine, type CapabilityCardLite } from "../../src/engine/capability-selection.js";

const ALL: CapabilityCardLite[] = [
  { id: "fs", purpose: "read/write files in the workspace", constraintsVocab: ["paths"] },
  { id: "shell", purpose: "run shell commands", constraintsVocab: ["argvClass"] },
  { id: "search", purpose: "search the workspace", constraintsVocab: [] },
  { id: "verify", purpose: "execute completion criteria", constraintsVocab: [] },
  { id: "git", purpose: "git status, diff, commit", constraintsVocab: [] },
  { id: "web_search", purpose: "search the web for current information", constraintsVocab: [] },
  { id: "web_fetch", purpose: "fetch and extract a web page by url", constraintsVocab: ["hosts"] },
  { id: "doc_parse", purpose: "parse pdf, docx, xlsx, csv documents", constraintsVocab: ["paths"] },
  { id: "mcp_call", purpose: "call a tool on an MCP server", constraintsVocab: ["mcpTools"] },
  { id: "mcp_server_start", purpose: "start an MCP server", constraintsVocab: ["mcpServers"] },
  { id: "mcp_server_stop", purpose: "stop an MCP server", constraintsVocab: ["mcpServers"] },
  { id: "artifact", purpose: "store binary artifacts", constraintsVocab: ["paths"] },
];

test("capability selection: core loop cards are always present", () => {
  const out = selectCapabilityCards(ALL, "vague idea", "");
  const ids = out.map((c) => c.id);
  for (const c of ["fs", "shell", "search", "verify"]) assert.ok(ids.includes(c), `missing core ${c}`);
});

test("capability selection: document goals surface doc_parse, not web_fetch", () => {
  const out = selectCapabilityCards(ALL, "Parse report.pdf and summarize findings", "");
  const ids = out.map((c) => c.id);
  assert.ok(ids.includes("doc_parse"), `doc_parse should be selected: ${ids}`);
  assert.ok(!ids.includes("web_fetch"), `web_fetch should not be selected: ${ids}`);
});

test("capability selection: web research goals surface web tools", () => {
  const out = selectCapabilityCards(ALL, "Fetch https://example.com/spec and check the documentation", "");
  const ids = out.map((c) => c.id);
  assert.ok(ids.includes("web_fetch") || ids.includes("web_search"), `web tools expected: ${ids}`);
});

test("capability selection: nothing relevant means no extended cards", () => {
  const out = selectCapabilityCards(ALL, "update the readme", "");
  const ids = out.map((c) => c.id);
  assert.equal(out.length, 4, `only the 4 core cards: ${ids}`);
});

test("catalog line lists every capability so the model retains discovery", () => {
  const line = capabilityCatalogLine(ALL);
  for (const c of ALL) assert.ok(line.includes(c.id), `catalog missing ${c.id}`);
});
