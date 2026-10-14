// FORGE Marketplace & Plugin Registry — Curated plugin and skill ecosystem.
// Directly mirrors the rich ZCode / Hermes / Antigravity plugin marketplace.

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface PluginItem {
  id: string;
  name: string;
  category: "developer-tools" | "productivity" | "finance" | "utilities" | "other";
  description: string;
  icon: string; // SVG or color glyph representation
  iconBg: string; // Background color for badge
  badge?: string; // e.g. "Coding Plan", "Official", "MCP"
  installed: boolean;
  version: string;
  source: "builtin" | "hermes" | "system-skill" | "agency-agent";
  docsUrl?: string;
}

export class MarketplaceRegistry {
  private readonly configPath: string;
  private installedIds: Set<string> = new Set();
  private plugins: PluginItem[] = [];

  constructor(forgeDir: string) {
    mkdirSync(forgeDir, { recursive: true });
    this.configPath = join(forgeDir, "installed_plugins.json");
    this.loadInstalled();
    this.initializeCatalog();
  }

  private loadInstalled(): void {
    if (existsSync(this.configPath)) {
      try {
        const raw = readFileSync(this.configPath, "utf8");
        const list = JSON.parse(raw) as string[];
        this.installedIds = new Set(list);
        return;
      } catch {
        // fallback
      }
    }
    // Default installed plugins matching user's top carousel screenshot!
    this.installedIds = new Set([
      "pdf",
      "presentations",
      "spreadsheets",
      "documents",
      "android-emulator",
      "browser-use",
      "computer-use",
      "image-search",
      "ios-simulator",
      "plugin-creator",
      "skill-creator",
      "zcode-guide",
      "lark-cli",
      "obsidian",
      "video2code",
      "github",
      "code-security",
      "design-taste-frontend",
      "brandkit",
    ]);
    this.saveInstalled();
  }

  private saveInstalled(): void {
    try {
      writeFileSync(this.configPath, JSON.stringify([...this.installedIds], null, 2), "utf8");
    } catch {
      // non-fatal
    }
  }

  private initializeCatalog(): void {
    const catalog: PluginItem[] = [
      // ==========================================
      // DEVELOPER TOOLS
      // ==========================================
      {
        id: "github",
        name: "Github",
        category: "developer-tools",
        description: "GitHub CLI workflows for commits, pull requests, issues, and workflow dispatch.",
        icon: "🐙",
        iconBg: "#181717",
        installed: this.installedIds.has("github"),
        version: "2.4.0",
        source: "builtin",
      },
      {
        id: "gitlab",
        name: "Gitlab",
        category: "developer-tools",
        description: "GitLab CLI workflows based on GitLab's official Agent Server and merge request pipeline.",
        icon: "🦊",
        iconBg: "#fc6d26",
        installed: this.installedIds.has("gitlab"),
        version: "1.8.0",
        source: "builtin",
      },
      {
        id: "alibaba-cloud",
        name: "Alibaba Cloud CLI",
        category: "developer-tools",
        description: "Alibaba Cloud CLI workflows for credential setup, ECS orchestration, and OSS management.",
        icon: "☁️",
        iconBg: "#ff6a00",
        installed: this.installedIds.has("alibaba-cloud"),
        version: "1.2.1",
        source: "builtin",
      },
      {
        id: "cloudbase",
        name: "Cloudbase Skills",
        category: "developer-tools",
        description: "CloudBase development skills and MCP integration for serverless container deployment.",
        icon: "⚡",
        iconBg: "#0052d9",
        installed: this.installedIds.has("cloudbase"),
        version: "1.0.4",
        source: "builtin",
      },
      {
        id: "code-security",
        name: "Code Security Protection",
        category: "developer-tools",
        description: "Local-first security guardrails for FORGE with pre-write static analysis and secret detection.",
        icon: "🛡️",
        iconBg: "#dc2626",
        installed: this.installedIds.has("code-security"),
        version: "3.1.0",
        source: "builtin",
      },
      {
        id: "android-emulator",
        name: "Android Emulator",
        category: "developer-tools",
        description: "Provides Android development workflows and emulator automation via ADB bridge.",
        icon: "🤖",
        iconBg: "#3ddc84",
        installed: this.installedIds.has("android-emulator"),
        version: "2.0.1",
        source: "builtin",
      },
      {
        id: "ios-simulator",
        name: "iOS Simulator",
        category: "developer-tools",
        description: "Provides iOS development workflows and simulator automation with xcrun simctl.",
        icon: "📱",
        iconBg: "#007aff",
        installed: this.installedIds.has("ios-simulator"),
        version: "1.9.0",
        source: "builtin",
      },

      // ==========================================
      // PRODUCTIVITY
      // ==========================================
      {
        id: "presentations",
        name: "Presentations",
        category: "productivity",
        description: "PPTX presentation production skills, published as an official standard for automated deck synthesis.",
        icon: "📊",
        iconBg: "#d97706",
        installed: this.installedIds.has("presentations"),
        version: "2.1.0",
        source: "builtin",
      },
      {
        id: "documents",
        name: "Documents",
        category: "productivity",
        description: "DOCX document production skills, published as an official standard for rich text report generation.",
        icon: "📄",
        iconBg: "#2563eb",
        installed: this.installedIds.has("documents"),
        version: "2.0.0",
        source: "builtin",
      },
      {
        id: "spreadsheets",
        name: "Spreadsheets",
        category: "productivity",
        description: "XLSX spreadsheet production skills, published as an official standard for financial modeling.",
        icon: "📈",
        iconBg: "#16a34a",
        installed: this.installedIds.has("spreadsheets"),
        version: "2.2.0",
        source: "builtin",
      },
      {
        id: "pdf",
        name: "PDF",
        category: "productivity",
        description: "PDF document production skills, published as an official standard with vector rendering.",
        icon: "📕",
        iconBg: "#ef4444",
        installed: this.installedIds.has("pdf"),
        version: "3.0.0",
        source: "builtin",
      },
      {
        id: "browser-use",
        name: "Browser Use",
        category: "productivity",
        description: "Built-in browser automation runtime and guidance for web page interaction and recording.",
        icon: "🌐",
        iconBg: "#6366f1",
        installed: this.installedIds.has("browser-use"),
        version: "1.5.0",
        source: "builtin",
      },
      {
        id: "computer-use",
        name: "Computer Use",
        category: "productivity",
        description: "Computer Use: automate desktop apps with mouse, keyboard, and OS window navigation.",
        icon: "🖥️",
        iconBg: "#475569",
        installed: this.installedIds.has("computer-use"),
        version: "1.2.0",
        source: "builtin",
      },
      {
        id: "video2code",
        name: "Video2code",
        category: "productivity",
        description: "Records WebM through FORGE's built-in Browser Use to reconstruct UI components from screencasts.",
        icon: "🎬",
        iconBg: "#8b5cf6",
        installed: this.installedIds.has("video2code"),
        version: "1.1.0",
        source: "builtin",
      },
      {
        id: "video-agent",
        name: "Video Agent Kit",
        category: "productivity",
        badge: "Coding Plan",
        description: "Automated video editing toolkit: standard cloud script rendering, timeline cuts, and TTS voiceover.",
        icon: "🎥",
        iconBg: "#ec4899",
        installed: this.installedIds.has("video-agent"),
        version: "1.0.0",
        source: "builtin",
      },
      {
        id: "lark-cli",
        name: "Lark CLI",
        category: "productivity",
        description: "Lark CLI workflows for docs, sheets, Base, calendar, and collaborative workspace management.",
        icon: "🕊️",
        iconBg: "#06b6d4",
        installed: this.installedIds.has("lark-cli"),
        version: "1.4.2",
        source: "builtin",
      },
      {
        id: "tencent-meeting",
        name: "Tencent Meeting CLI",
        category: "productivity",
        description: "Tencent Meeting CLI workflows with OAuth2 setup, meeting room booking, and auto-transcripts.",
        icon: "👥",
        iconBg: "#0284c7",
        installed: this.installedIds.has("tencent-meeting"),
        version: "1.0.3",
        source: "builtin",
      },
      {
        id: "dingtalk-cli",
        name: "DingTalk CLI",
        category: "productivity",
        description: "DingTalk Workspace CLI workflows with OAuth/device authentication, attendance, and chat bots.",
        icon: "⚡",
        iconBg: "#0ea5e9",
        installed: this.installedIds.has("dingtalk-cli"),
        version: "1.2.0",
        source: "builtin",
      },
      {
        id: "wecom-cli",
        name: "WeCom CLI",
        category: "productivity",
        description: "WeCom CLI workflows for messages, docs, sheets, mail, and customer service bots.",
        icon: "💬",
        iconBg: "#10b981",
        installed: this.installedIds.has("wecom-cli"),
        version: "1.1.5",
        source: "builtin",
      },
      {
        id: "image-search",
        name: "Image Search",
        category: "productivity",
        description: "Official image search MCP server for finding high-resolution illustrations and graphics.",
        icon: "🖼️",
        iconBg: "#059669",
        installed: this.installedIds.has("image-search"),
        version: "2.0.0",
        source: "builtin",
      },
      {
        id: "obsidian",
        name: "Obsidian",
        category: "productivity",
        description: "Obsidian authoring skills from kepano/obsidian-skills: markdown links, vault indexing, and canvas.",
        icon: "💎",
        iconBg: "#7c3aed",
        installed: this.installedIds.has("obsidian"),
        version: "2.3.1",
        source: "builtin",
      },

      // ==========================================
      // FINANCE
      // ==========================================
      {
        id: "tianyancha",
        name: "Tianyancha",
        category: "finance",
        badge: "Coding Plan",
        description: "MCP service for Tianyancha company information, equity structure, litigation, and trademark search.",
        icon: "🏢",
        iconBg: "#0284c7",
        installed: this.installedIds.has("tianyancha"),
        version: "1.3.0",
        source: "builtin",
      },
      {
        id: "wind",
        name: "Wind",
        category: "finance",
        badge: "Coding Plan",
        description: "MCP services for Wind financial terminal: stock, global market indexes, futures, and bond yields.",
        icon: "📊",
        iconBg: "#dc2626",
        installed: this.installedIds.has("wind"),
        version: "2.0.4",
        source: "builtin",
      },
      {
        id: "financial-sec",
        name: "Financial Aggregated Services",
        category: "finance",
        badge: "Coding Plan",
        description: "MCP services for SEC EDGAR filing search, 10-K / 10-Q parsing, and automated financial ratio analysis.",
        icon: "🔎",
        iconBg: "#0d9488",
        installed: this.installedIds.has("financial-sec"),
        version: "1.8.0",
        source: "builtin",
      },
      {
        id: "royalflush",
        name: "RoyalFlush iFinD",
        category: "finance",
        description: "MCP services for RoyalFlush iFinD stock, global stock valuation, fundamentals, and macro indicators.",
        icon: "🃏",
        iconBg: "#b91c1c",
        installed: this.installedIds.has("royalflush"),
        version: "1.4.0",
        source: "builtin",
      },
      {
        id: "deal-modeling",
        name: "Deal Modeling",
        category: "finance",
        badge: "Coding Plan",
        description: "Transaction structuring and modeling: accretion/dilution analysis, LBO calculations, and sensitivity tables.",
        icon: "🧮",
        iconBg: "#ea580c",
        installed: this.installedIds.has("deal-modeling"),
        version: "2.1.0",
        source: "builtin",
      },
      {
        id: "corporate-fpa",
        name: "Corporate FP&A",
        category: "finance",
        badge: "Coding Plan",
        description: "Corporate finance and FP&A: management reporting, rolling forecasts, and variance breakdown.",
        icon: "🏛️",
        iconBg: "#1d4ed8",
        installed: this.installedIds.has("corporate-fpa"),
        version: "1.5.0",
        source: "builtin",
      },
      {
        id: "accounting-reporting",
        name: "Accounting & Reporting",
        category: "finance",
        description: "Accounting close and statutory reporting off the general ledger with GAAP & IFRS reconciliations.",
        icon: "📋",
        iconBg: "#ca8a04",
        installed: this.installedIds.has("accounting-reporting"),
        version: "1.2.0",
        source: "builtin",
      },
      {
        id: "equity-research",
        name: "Equity Research",
        category: "finance",
        badge: "Coding Plan",
        description: "End-to-end investment research reports, DCF valuation, comps table synthesis, and price target modeling.",
        icon: "📈",
        iconBg: "#e11d48",
        installed: this.installedIds.has("equity-research"),
        version: "2.4.0",
        source: "builtin",
      },
      {
        id: "macro-strategy",
        name: "Macro & Strategy",
        category: "finance",
        description: "Top-down macro and strategy work: macroeconomic dashboards, interest rate projections, and business cycle heatmaps.",
        icon: "🌐",
        iconBg: "#2563eb",
        installed: this.installedIds.has("macro-strategy"),
        version: "1.1.0",
        source: "builtin",
      },
      {
        id: "due-diligence",
        name: "Company Due Diligence",
        category: "finance",
        badge: "Coding Plan",
        description: "Counterparty and company due diligence: structured background check, risk factor registry, and compliance audit.",
        icon: "📑",
        iconBg: "#0284c7",
        installed: this.installedIds.has("due-diligence"),
        version: "1.6.0",
        source: "builtin",
      },
      {
        id: "fixed-income",
        name: "Fixed Income & Credit",
        category: "finance",
        description: "Fixed-income and credit research: bond profiles with yields, spread curves, duration, and default risk spreads.",
        icon: "💳",
        iconBg: "#d97706",
        installed: this.installedIds.has("fixed-income"),
        version: "1.0.8",
        source: "builtin",
      },
      {
        id: "fund-research",
        name: "Fund Research",
        category: "finance",
        badge: "Coding Plan",
        description: "Fund and fund-manager research: multi-criteria fund screening, Sharpe/Sortino ratios, and style drift analysis.",
        icon: "📉",
        iconBg: "#9333ea",
        installed: this.installedIds.has("fund-research"),
        version: "1.3.0",
        source: "builtin",
      },

      // ==========================================
      // UTILITIES & SKILLS
      // ==========================================
      {
        id: "plugin-creator",
        name: "Plugin Creator",
        category: "utilities",
        description: "Develop and validate FORGE plugins through a local development sandbox and manifest generator.",
        icon: "🧩",
        iconBg: "#2563eb",
        installed: this.installedIds.has("plugin-creator"),
        version: "1.0.0",
        source: "builtin",
      },
      {
        id: "skill-creator",
        name: "Skill Creator",
        category: "utilities",
        description: "Create, edit, and iterate local skills with YAML frontmatter, specialized prompts, and test validation.",
        icon: "✏️",
        iconBg: "#f59e0b",
        installed: this.installedIds.has("skill-creator"),
        version: "1.2.0",
        source: "builtin",
      },
      {
        id: "zcode-guide",
        name: "ZCode Guide",
        category: "utilities",
        description: "FORGE & ZCode usage and self-diagnosis guide: teaches agents to use tools properly with zero syntax errors.",
        icon: "📖",
        iconBg: "#334155",
        installed: this.installedIds.has("zcode-guide"),
        version: "2.0.0",
        source: "builtin",
      },
      {
        id: "node-repl-host",
        name: "Node Repl Host",
        category: "other",
        description: "Shared node_repl runtime host for official capabilities, ephemeral script execution, and debugging.",
        icon: "⚙️",
        iconBg: "#475569",
        installed: this.installedIds.has("node-repl-host"),
        version: "1.0.0",
        source: "builtin",
      },

      // Workspace Design & Taste Skills
      {
        id: "brandkit",
        name: "BrandKit Engine",
        category: "utilities",
        badge: "Official",
        description: "Premium brand-kit generation for high-end design systems, logo boards, and art-directed identity decks.",
        icon: "🎨",
        iconBg: "#8b5cf6",
        installed: this.installedIds.has("brandkit"),
        version: "2.1.0",
        source: "system-skill",
      },
      {
        id: "design-taste-frontend",
        name: "Design Taste Frontend",
        category: "utilities",
        badge: "Official",
        description: "Anti-slop frontend taste engine: enforces curated HSL color schemes, wide typography, and avoids generic AI templates.",
        icon: "✨",
        iconBg: "#ec4899",
        installed: this.installedIds.has("design-taste-frontend"),
        version: "2.0.0",
        source: "system-skill",
      },
      {
        id: "gpt-taste",
        name: "GSAP Motion & Bento UI",
        category: "utilities",
        badge: "Official",
        description: "Elite UX/UI & Advanced GSAP Motion Engineer with scroll triggers, gapless bento grids, and micro-interactions.",
        icon: "⚡",
        iconBg: "#10b981",
        installed: this.installedIds.has("gpt-taste"),
        version: "1.9.0",
        source: "system-skill",
      },
      {
        id: "graphify",
        name: "Graphify Knowledge Graph",
        category: "utilities",
        badge: "MCP",
        description: "Codebase understanding graph with god nodes, community detection, and architectural explainability.",
        icon: "🕸️",
        iconBg: "#0284c7",
        installed: this.installedIds.has("graphify"),
        version: "3.2.0",
        source: "system-skill",
      },
    ];

    this.plugins = catalog;
  }

  getAll(): PluginItem[] {
    return this.plugins.map((p) => ({
      ...p,
      installed: this.installedIds.has(p.id),
    }));
  }

  getInstalled(): PluginItem[] {
    return this.plugins.filter((p) => this.installedIds.has(p.id));
  }

  toggle(id: string): boolean {
    const item = this.plugins.find((p) => p.id === id);
    if (!item) return false;

    if (this.installedIds.has(id)) {
      this.installedIds.delete(id);
    } else {
      this.installedIds.add(id);
    }
    this.saveInstalled();
    return true;
  }

  isInstalled(id: string): boolean {
    return this.installedIds.has(id);
  }
}
