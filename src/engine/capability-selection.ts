// FORGE capability card selection (progressive disclosure).
// Context is compiled, not dumped (INV-14): every model round previously carried
// every capability card. Relevance selects the cards a round actually needs while
// keeping the core read/write/run loop always present; the full catalog id list
// remains visible as an escape hatch (the Gate, not the prompt, enforces use).

export interface CapabilityCardLite {
  id: string;
  purpose: string;
  constraintsVocab: string[];
}

const CORE_IDS = new Set(["fs", "shell", "search", "verify"]);

const STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "your", "you",
  "are", "was", "will", "would", "should", "could", "about", "have", "has",
  "file", "code", "run", "task", "use", "via",
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^a-z0-9_]+/g)) {
    if (tok.length >= 3 && !STOP.has(tok)) out.add(tok);
  }
  return out;
}

/** Synonyms let plain goals reach card vocab: "the pdf" -> doc_parse, etc. */
const SYNONYMS: Record<string, readonly string[]> = {
  web_search: ["search", "web", "online", "google", "lookup", "internet"],
  web_fetch: ["fetch", "scrape", "scrape", "download", "url", "page", "site", "http", "https"],
  http: ["api", "endpoint", "request", "http", "https", "rest", "post", "get"],
  doc_parse: ["pdf", "docx", "pptx", "xlsx", "csv", "document", "report", "parse", "somnus", "spreadsheet", "slide", "invoice"],
  mcp_call: ["mcp"],
  mcp_server_start: ["mcp"],
  mcp_server_stop: ["mcp"],
  git: ["git", "commit", "branch", "diff", "repo", "repository", "status"],
  artifact: ["artifact", "screenshot", "diagram", "output", "report", "attach"],
};

export function selectCapabilityCards(
  all: ReadonlyArray<CapabilityCardLite>,
  goalText: string,
  tailText: string,
  opts: { maxExtended?: number } = {},
): CapabilityCardLite[] {
  const maxExtended = opts.maxExtended ?? 6;
  const queryTokens = tokenize(`${goalText}\n${tailText}`);
  const scored: Array<{ card: CapabilityCardLite; score: number }> = [];

  for (const card of all) {
    if (CORE_IDS.has(card.id)) continue;
    const hay = new Set([...tokenize(card.id), ...tokenize(card.purpose), ...card.constraintsVocab.flatMap((c) => [...tokenize(c)])]);
    const syn = SYNONYMS[card.id] ?? [];
    let score = 0;
    for (const t of queryTokens) {
      if (hay.has(t)) score += 2;
      for (const s of syn) {
        if (t === s) score += 1;
      }
    }
    // partial-word reach: "download" hits "download"
    for (const t of queryTokens) {
      for (const s of syn) if (t.includes(s) || s.includes(t)) score += 1;
      for (const h of hay) if (h.length >= 4 && (h.includes(t) || t.includes(h))) score += 0.5;
    }
    if (score > 0) scored.push({ card, score });
  }

  scored.sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
  const picked = scored.slice(0, maxExtended).map((s) => s.card);
  const core = all.filter((c) => CORE_IDS.has(c.id));
  return [...core, ...picked];
}

/** One-line escape hatch: every capability id stays discoverable. */
export function capabilityCatalogLine(all: ReadonlyArray<CapabilityCardLite>): string {
  return `Full capability catalog (propose any by id even if not carded): ${all.map((c) => c.id).join(", ")}`;
}
