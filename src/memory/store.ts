// FORGE memory — continuous learning, memory persistence, and auto-reflection.
// Inspired by Hermes memory, Gemini memory, and OpenCode knowledge persistence.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface MemoryItem {
  id: string;
  category: "preference" | "lesson" | "architecture" | "rule";
  title: string;
  content: string;
  source: "user" | "auto-reflection" | "system";
  confidence: number; // 0.0 - 1.0
  createdAt: string;
  updatedAt: string;
}

export class MemoryStore {
  private readonly filePath: string;
  private memories: MemoryItem[] = [];

  constructor(forgeDir: string) {
    mkdirSync(forgeDir, { recursive: true });
    this.filePath = join(forgeDir, "memory.json");
    this.load();
  }

  private load(): void {
    if (existsSync(this.filePath)) {
      try {
        const raw = readFileSync(this.filePath, "utf8");
        this.memories = JSON.parse(raw);
        return;
      } catch {
        // Fall back to default seeds if corrupt
      }
    }
    // Seed default baseline memories
    this.memories = [
      {
        id: "mem-sys-windows-env",
        category: "rule",
        title: "Platform Shell Policy",
        content: "On Windows environments, avoid Unix-only commands (e.g., 'ls -la'); use the 'search' capability for file listing or native powershell commands.",
        source: "system",
        confidence: 1.0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "mem-sys-clean-voice",
        category: "preference",
        title: "Senior Engineering Voice",
        content: "Communicate directly, concisely, and technically like Claude Code or Cursor. Do not parrot repetitive identity intros or dump raw JSON proposals into user chat.",
        source: "system",
        confidence: 0.95,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "mem-sys-governed-audit",
        category: "architecture",
        title: "Governed Substrate Invariant",
        content: "Narration is ephemeral; state is proof. Never tamper with the cryptographic ledger journal; execute through the Authority Gate.",
        source: "system",
        confidence: 1.0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    this.save();
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.memories, null, 2), "utf8");
    } catch {
      // non-fatal
    }
  }

  getAll(): MemoryItem[] {
    return [...this.memories];
  }

  get(id: string): MemoryItem | undefined {
    return this.memories.find((m) => m.id === id);
  }

  add(item: {
    category: MemoryItem["category"];
    title: string;
    content: string;
    source?: MemoryItem["source"];
    confidence?: number;
  }): MemoryItem {
    const mem: MemoryItem = {
      id: `mem-${Date.now()}-${randomBytes(3).toString("hex")}`,
      category: item.category,
      title: item.title,
      content: item.content,
      source: item.source || "user",
      confidence: item.confidence ?? 0.9,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.memories.unshift(mem);
    this.save();
    return mem;
  }

  update(id: string, updates: Partial<Pick<MemoryItem, "title" | "content" | "category" | "confidence">>): MemoryItem | undefined {
    const mem = this.memories.find((m) => m.id === id);
    if (!mem) return undefined;
    if (updates.title) mem.title = updates.title;
    if (updates.content) mem.content = updates.content;
    if (updates.category) mem.category = updates.category;
    if (updates.confidence !== undefined) mem.confidence = updates.confidence;
    mem.updatedAt = new Date().toISOString();
    this.save();
    return mem;
  }

  delete(id: string): boolean {
    const lenBefore = this.memories.length;
    this.memories = this.memories.filter((m) => m.id !== id);
    if (this.memories.length !== lenBefore) {
      this.save();
      return true;
    }
    return false;
  }

  /** Auto-learns from a runtime failure or error */
  learnFromFailure(action: string, errorDetail: string): MemoryItem | null {
    const title = `Lesson: ${action.slice(0, 40)}`;
    const content = `When performing '${action}', encountered error: '${errorDetail}'. Ensure prerequisite checks or alternative capabilities are used.`;
    
    // Prevent duplicate learning records
    const existing = this.memories.find((m) => m.content.includes(errorDetail.slice(0, 50)));
    if (existing) return null;

    return this.add({
      category: "lesson",
      title,
      content,
      source: "auto-reflection",
      confidence: 0.85,
    });
  }

  /** Returns top formatted context string to inject into agent prompt */
  formatContextForPrompt(): string {
    if (this.memories.length === 0) return "";
    const items = this.memories.slice(0, 10).map((m) => `• [${m.category.toUpperCase()}] ${m.title}: ${m.content}`);
    return `CONTINUOUS MEMORY & LEARNED RULES:\n${items.join("\n")}`;
  }
}
