// FORGE Archify — Deep repository scanning, architecture analysis, and Mermaid graph synthesis.
// Inspired by https://github.com/tt-a1i/archify and graphify.

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";

export interface ComponentInfo {
  name: string;
  path: string;
  type: "entrypoint" | "core" | "contract" | "storage" | "api" | "ui" | "utility" | "test";
  language: string;
  linesOfCode: number;
  dependencies: string[];
  exports: string[];
  summary: string;
}

export interface ArchitectureReport {
  projectName: string;
  projectType: string;
  totalFiles: number;
  totalLines: number;
  languages: Record<string, number>;
  frameworks: string[];
  components: ComponentInfo[];
  mermaidDiagram: string;
  dataFlow: Array<{ from: string; to: string; description: string }>;
  subsystems: Array<{
    name: string;
    description: string;
    files: string[];
  }>;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".forge",
  ".system_generated",
  ".next",
  "coverage",
  "__pycache__",
  ".pytest_cache",
]);

export function scanRepository(rootDir: string): ArchitectureReport {
  const allFiles: string[] = [];
  collectFiles(rootDir, rootDir, allFiles);

  const languages: Record<string, number> = {};
  let totalLines = 0;
  const components: ComponentInfo[] = [];

  for (const absPath of allFiles) {
    const rel = relative(rootDir, absPath).replace(/\\/g, "/");
    const ext = extname(absPath).toLowerCase();
    const lang = detectLanguage(ext);
    languages[lang] = (languages[lang] || 0) + 1;

    let content = "";
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n").length;
    totalLines += lines;

    // Only deeply analyze code files
    if (["TypeScript", "JavaScript", "Python", "Go", "Rust", "HTML", "CSS"].includes(lang)) {
      const comp = analyzeFile(rootDir, absPath, rel, lang, content, lines);
      components.push(comp);
    }
  }

  // Detect frameworks and project type
  const { projectType, frameworks } = detectProjectStack(rootDir, allFiles);

  // Group into subsystems
  const subsystems = identifySubsystems(components);

  // Generate Mermaid Architecture Diagram
  const mermaidDiagram = generateMermaid(subsystems, components);

  // Data flow connections
  const dataFlow = inferDataFlow(subsystems);

  return {
    projectName: basename(rootDir),
    projectType,
    totalFiles: allFiles.length,
    totalLines,
    languages,
    frameworks,
    components: components.slice(0, 50), // top components
    mermaidDiagram,
    dataFlow,
    subsystems,
  };
}

function collectFiles(baseDir: string, currentDir: string, out: string[]): void {
  if (!existsSync(currentDir)) return;
  const entries = readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".agents") continue;
    if (IGNORED_DIRS.has(entry.name)) continue;

    const full = join(currentDir, entry.name);
    try {
      if (entry.isDirectory()) {
        collectFiles(baseDir, full, out);
      } else if (entry.isFile()) {
        out.push(full);
      }
    } catch {
      // skip permission or unreadable errors
    }
  }
}

function detectLanguage(ext: string): string {
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "TypeScript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "JavaScript";
    case ".py":
      return "Python";
    case ".go":
      return "Go";
    case ".rs":
      return "Rust";
    case ".html":
      return "HTML";
    case ".css":
      return "CSS";
    case ".json":
      return "JSON";
    case ".md":
      return "Markdown";
    case ".yaml":
    case ".yml":
      return "YAML";
    default:
      return ext ? ext.slice(1).toUpperCase() : "Other";
  }
}

function detectProjectStack(rootDir: string, files: string[]): { projectType: string; frameworks: string[] } {
  const frameworks: string[] = [];
  let projectType = "Generic Repository";

  const pkgJsonPath = join(rootDir, "package.json");
  if (existsSync(pkgJsonPath)) {
    projectType = "Node.js / TypeScript";
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (allDeps["express"]) frameworks.push("Express");
      if (allDeps["next"]) frameworks.push("Next.js");
      if (allDeps["react"]) frameworks.push("React");
      if (allDeps["vue"]) frameworks.push("Vue");
      if (allDeps["typescript"]) frameworks.push("TypeScript");
      if (allDeps["vitest"] || allDeps["jest"]) frameworks.push("Test Suite");
    } catch {
      // ignore
    }
  }

  const pyproject = join(rootDir, "pyproject.toml");
  const reqTxt = join(rootDir, "requirements.txt");
  if (existsSync(pyproject) || existsSync(reqTxt)) {
    projectType = "Python";
    frameworks.push("Python Runtime");
  }

  return { projectType, frameworks };
}

function analyzeFile(rootDir: string, absPath: string, relPath: string, lang: string, content: string, lines: number): ComponentInfo {
  const base = basename(absPath);
  let type: ComponentInfo["type"] = "core";

  if (relPath.includes("test") || base.includes(".test.") || base.includes(".spec.")) {
    type = "test";
  } else if (relPath.includes("contract") || base.includes("contract") || base.includes("types")) {
    type = "contract";
  } else if (relPath.includes("api") || relPath.includes("server") || relPath.includes("route")) {
    type = "api";
  } else if (relPath.includes("ui") || relPath.includes("webui") || relPath.endsWith(".html") || relPath.endsWith(".css")) {
    type = "ui";
  } else if (relPath.includes("ledger") || relPath.includes("store") || relPath.includes("db")) {
    type = "storage";
  } else if (base.startsWith("cli") || base.startsWith("index") || base.startsWith("main")) {
    type = "entrypoint";
  }

  // Extract imports
  const dependencies: string[] = [];
  const importRegex = /(?:import\s+(?:[\w*\s{},]*)\s+from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\))/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const dep = match[1] || match[2];
    if (dep && !dep.startsWith("node:")) {
      dependencies.push(dep);
    }
  }

  // Extract exports
  const exports: string[] = [];
  const exportRegex = /export\s+(?:class|function|interface|const|type|enum)\s+([a-zA-Z0-9_]+)/g;
  while ((match = exportRegex.exec(content)) !== null) {
    if (match[1]) exports.push(match[1]);
  }

  // Generate concise summary
  let summary = `${type.toUpperCase()} module with ${lines} lines.`;
  if (exports.length > 0) {
    summary += ` Exposes: ${exports.slice(0, 3).join(", ")}${exports.length > 3 ? "..." : ""}.`;
  }

  return {
    name: base,
    path: relPath,
    type,
    language: lang,
    linesOfCode: lines,
    dependencies: [...new Set(dependencies)].slice(0, 8),
    exports: exports.slice(0, 10),
    summary,
  };
}

function identifySubsystems(components: ComponentInfo[]): ArchitectureReport["subsystems"] {
  const groups: Record<string, { desc: string; files: string[] }> = {
    "Execution Engine": { desc: "Core autonomous execution harness, state machine, and model dispatch", files: [] },
    "Governed Ledger": { desc: "Append-only SHA-256 hash-chained cryptographic ledger and verification receipts", files: [] },
    "Authority Gate": { desc: "Zero-trust capability broker, path constraints, and escalation management", files: [] },
    "Model Router": { desc: "Multi-provider LLM routing, auto-fallback, and live streaming", files: [] },
    "API & Control Plane": { desc: "REST server, real-time Server-Sent Events, and interactive web interface", files: [] },
    "Memory & Learning": { desc: "Persistent cross-session memory, learned rules, and reflection engine", files: [] },
    "Capabilities & Environment": { desc: "Sandboxed filesystem, shell, git, and HTTP capability executors", files: [] },
  };

  for (const c of components) {
    if (c.path.includes("engine") || c.path.includes("packs")) {
      groups["Execution Engine"]!.files.push(c.path);
    } else if (c.path.includes("ledger") || c.path.includes("codec")) {
      groups["Governed Ledger"]!.files.push(c.path);
    } else if (c.path.includes("gate") || c.path.includes("grants")) {
      groups["Authority Gate"]!.files.push(c.path);
    } else if (c.path.includes("model-router")) {
      groups["Model Router"]!.files.push(c.path);
    } else if (c.path.includes("api") || c.path.includes("cli") || c.path.includes("webui")) {
      groups["API & Control Plane"]!.files.push(c.path);
    } else if (c.path.includes("memory")) {
      groups["Memory & Learning"]!.files.push(c.path);
    } else if (c.path.includes("capabilities") || c.path.includes("environments") || c.path.includes("capability-host")) {
      groups["Capabilities & Environment"]!.files.push(c.path);
    }
  }

  return Object.entries(groups)
    .filter(([_, g]) => g.files.length > 0)
    .map(([name, g]) => ({ name, description: g.desc, files: g.files }));
}

function generateMermaid(subsystems: ArchitectureReport["subsystems"], components: ComponentInfo[]): string {
  const lines: string[] = [
    "flowchart TD",
    '  subgraph User_Plane ["Client & Control Interface"]',
    '    UI["Interactive Web Console (WebUI)"]',
    '    CLI["FORGE CLI Runner"]',
    '    API["Control Plane Server (REST & SSE)"]',
    "  end",
    "",
    '  subgraph Governance_Core ["Governed Execution Substrate"]',
    '    ENG["Engine / Orchestrator"]',
    '    GATE["Authority Gate (Policy & Path Checks)"]',
    '    LEDGER[("Cryptographic Ledger (SHA-256 Hash Chain)")]',
    '    MEM[("Continuous Memory & Learning Store")]',
    "  end",
    "",
    '  subgraph Execution_Boundary ["Sandboxed Capability Host"]',
    '    FS["Filesystem Capability"]',
    '    SHELL["Sandboxed Shell Capability"]',
    '    GIT["Git Worktree / VCS"]',
    '    HTTP["HTTP / External Capabilities"]',
    "  end",
    "",
    '  subgraph AI_Intelligence ["Model Router & Provider Mesh"]',
    '    ROUTER["Model Router (Auto-Fallback)"]',
    '    LLM["LLMs (NVIDIA NIM / Kimi K3 / Claude / OpenAI)"]',
    "  end",
    "",
    "  UI -->|Directives & Events| API",
    "  CLI -->|Directives| API",
    "  API -->|Opens Handle| ENG",
    "  ENG <-->|Learned Rules & Context| MEM",
    "  ENG -->|Proposes Action| GATE",
    "  GATE -->|Records Decision| LEDGER",
    "  GATE -->|Dispatches Allowed Action| FS",
    "  GATE -->|Dispatches Allowed Action| SHELL",
    "  GATE -->|Dispatches Allowed Action| GIT",
    "  GATE -->|Dispatches Allowed Action| HTTP",
    "  FS -->|Appends Observation| LEDGER",
    "  SHELL -->|Appends Observation| LEDGER",
    "  ENG <-->|Streams Deliberation| ROUTER",
    "  ROUTER <--> LLM",
  ];

  return lines.join("\n");
}

function inferDataFlow(subsystems: ArchitectureReport["subsystems"]): ArchitectureReport["dataFlow"] {
  return [
    { from: "Developer / WebUI", to: "Control Plane API", description: "Directives, task steering, model selections" },
    { from: "Control Plane API", to: "Engine Handle", description: "Single-writer mission lifecycle execution" },
    { from: "Engine", to: "Memory Store", description: "Context enrichment and auto-reflection on errors" },
    { from: "Engine", to: "Model Router", description: "Streaming reasoning prompts & tool invocations" },
    { from: "Engine", to: "Authority Gate", description: "Capability proposals with cryptographic citations" },
    { from: "Authority Gate", to: "Capability Host", description: "Constrained execution within active grants" },
    { from: "Capability Host", to: "Cryptographic Ledger", description: "Canonical SHA-256 observation hash chaining" },
  ];
}
