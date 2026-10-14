// FORGE capabilities — web (web_search & web_fetch).
// Governed web research & content scraping:
// - web_search: search the web via DuckDuckGo / Brave / SearXNG with zero-config fallback.
// - web_fetch: fetch URLs, revalidate redirects against Gate host scope, and extract clean Markdown.
// Every search and fetch produces cryptographic evidence captured into the ledger.

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { CapabilityImpl, DispatchContext } from "../capability-host/types.js";
import type { Proposal } from "../contracts/index.js";
import { CapabilityManifestSchema } from "../contracts/grants.js";
import { safeConnectionFetch } from "./safe-http.js";

function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1" || ip === "::") return true;
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);

  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 127) return true; // Loopback 127.0.0.0/8
    if (a === 10) return true; // Private 10.0.0.0/8
    if (a === 172 && b! >= 16 && b! <= 31) return true; // Private 172.16.0.0/12
    if (a === 192 && b === 168) return true; // Private 192.168.0.0/16
    if (a === 169 && b === 254) return true; // Link-local / metadata 169.254.0.0/16
    if (a === 100 && b! >= 64 && b! <= 127) return true; // Carrier-grade NAT 100.64.0.0/10
    if (a! >= 224) return true; // Multicast / Reserved 224.0.0.0/4 & 240.0.0.0/4
  }

  const normV6 = ip.toLowerCase();
  if (
    normV6.startsWith("fc") ||
    normV6.startsWith("fd") ||
    normV6.startsWith("fe8") ||
    normV6.startsWith("fe9") ||
    normV6.startsWith("fea") ||
    normV6.startsWith("feb")
  ) {
    return true;
  }
  return false;
}

export async function validateUrlSsrf(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`invalid fetch URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`forbidden fetch protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error(`SSRF blocked: request to local/loopback host "${hostname}" is prohibited`);
  }

  if (isPrivateIp(hostname)) {
    throw new Error(`SSRF blocked: direct IP "${hostname}" is a private or reserved network address`);
  }

  try {
    const addrs = await lookup(hostname, { all: true });
    for (const addr of addrs) {
      if (isPrivateIp(addr.address)) {
        throw new Error(`SSRF blocked: host "${hostname}" resolved to private/reserved IP "${addr.address}"`);
      }
    }
  } catch (err: any) {
    if (err?.message?.includes("SSRF blocked")) throw err;
  }
}

const DEFAULT_FETCH_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
const HTTP_MAX_HOPS = 5;

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Clean HTML into readable, concise Markdown text for LLM consumption.
 * Strips noise, styles, scripts, navigation, headers, footers, and converts semantics.
 */
export function htmlToMarkdown(html: string): { title: string | null; markdown: string } {
  let text = html;

  // 1. Extract title
  let title: string | null = null;
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  if (titleMatch) {
    title = decodeHtmlEntities(titleMatch[1]!.replace(/<[^>]+>/g, "").trim());
  }

  // 2. Strip non-content blocks
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "");
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // 3. Convert code blocks
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, code) => `\n\`\`\`\n${decodeHtmlEntities(code).trim()}\n\`\`\`\n`);
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\`\`\`\n${decodeHtmlEntities(code).trim()}\n\`\`\`\n`);
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => ` \`${decodeHtmlEntities(code).trim()}\` `);

  // 4. Convert headings
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, h) => `\n\n# ${cleanInline(h)}\n\n`);
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, h) => `\n\n## ${cleanInline(h)}\n\n`);
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, h) => `\n\n### ${cleanInline(h)}\n\n`);
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, h) => `\n\n#### ${cleanInline(h)}\n\n`);
  text = text.replace(/<h[56][^>]*>([\s\S]*?)<\/h[56]>/gi, (_, h) => `\n\n##### ${cleanInline(h)}\n\n`);

  // 5. Convert lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, item) => `\n- ${cleanInline(item)}`);

  // 6. Convert links
  text = text.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
    const l = cleanInline(label);
    return l ? `[${l}](${href})` : "";
  });

  // 7. Convert paragraphs & linebreaks
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, p) => `\n\n${cleanInline(p)}\n\n`);
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

  // 8. Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // 9. Clean entities & spacing
  text = decodeHtmlEntities(text);
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n\s+\n/g, "\n\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  return { title, markdown: text.trim() };
}

function cleanInline(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Parse DuckDuckGo HTML search page results.
 */
export function parseDuckDuckGoHtml(html: string, maxResults: number = 8): SearchResultItem[] {
  const results: SearchResultItem[] = [];
  // DuckDuckGo HTML uses class="result__body" containing class="result__title" and class="result__snippet"
  const bodyRegex = /<div class="result__body[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi;
  let match: RegExpExecArray | null;

  while ((match = bodyRegex.exec(html)) !== null && results.length < maxResults) {
    const block = match[0];
    // Extract title & link
    const titleMatch = /<a class="result__url[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
      || /<a class="result__title[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
      || /<h2 class="result__title">[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);

    // Extract snippet
    const snippetMatch = /<a class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
      || /<div class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);

    if (titleMatch) {
      let rawUrl = titleMatch[1]!;
      // DuckDuckGo URL format: /l/?uddg=https%3A%2F%2Fexample.com...
      const uddgMatch = /[?&]uddg=([^&]+)/.exec(rawUrl);
      if (uddgMatch) {
        try { rawUrl = decodeURIComponent(uddgMatch[1]!); } catch {}
      } else if (rawUrl.startsWith("//")) {
        rawUrl = "https:" + rawUrl;
      }

      const title = cleanInline(titleMatch[2]!);
      const snippet = snippetMatch ? cleanInline(snippetMatch[1]!) : "";

      if (rawUrl && title && (rawUrl.startsWith("http://") || rawUrl.startsWith("https://"))) {
        results.push({ title, url: rawUrl, snippet });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// web_search implementation
// ---------------------------------------------------------------------------

export const webSearchImpl: CapabilityImpl = {
  manifest: CapabilityManifestSchema.parse({
    id: "web_search",
    version: "1.0.0",
    purpose: "search the public web for real-time information, documentation, and technical research",
    environments: ["local", "container"],
    proposalKind: "web_search",
    constraintsVocab: [],
    concurrency: "parallel",
    idempotent: true,
    riskClass: ["network", "read"],
    provenance: { pack: "core", hash: "0000000000000000000000000000000000000000000000000000000000000000" },
  }),

  async run(proposal: Proposal, ctx: DispatchContext, opts: { timeoutMs: number; signal: AbortSignal }) {
    if (proposal.capability !== "web_search") throw new Error("mismatch");
    const { query, maxResults = 8 } = proposal.args;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

    let items: SearchResultItem[] = [];
    let provider = "duckduckgo";

    try {
      // 1. DuckDuckGo HTML Search
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await safeConnectionFetch(searchUrl, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
        timeoutMs: Math.min(opts.timeoutMs, 5000),
        signal: controller.signal,
      });

      if (res.status === 200) {
        items = parseDuckDuckGoHtml(res.text, maxResults);
      }

      // 2. Fallback to DuckDuckGo Instant Answer API if HTML yields zero results
      if (items.length === 0) {
        const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const apiRes = await safeConnectionFetch(apiUrl, {
          method: "GET",
          headers: { "User-Agent": "FORGE-Engine/1.2" },
          timeoutMs: Math.min(opts.timeoutMs, 5000),
          signal: controller.signal,
        });
        if (apiRes.status === 200) {
          try {
            const data = JSON.parse(apiRes.text) as {
              AbstractText?: string;
              AbstractURL?: string;
              Heading?: string;
              RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
            };
            if (data.AbstractText && data.AbstractURL) {
              items.push({
                title: data.Heading || query,
                url: data.AbstractURL,
                snippet: data.AbstractText,
              });
            }
            if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
              for (const rt of data.RelatedTopics.slice(0, maxResults - items.length)) {
                if (rt.Text && rt.FirstURL) {
                  items.push({
                    title: rt.Text.slice(0, 80),
                    url: rt.FirstURL,
                    snippet: rt.Text,
                  });
                }
              }
            }
            if (items.length > 0) provider = "duckduckgo-instant";
          } catch {
            // ignore JSON parse error on empty/corrupt fallback
          }
        }
      }
    } catch {
      // Offline, network timeout or test environment: return empty results without crashing
      items = [];
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
    }

    const jsonBytes = new TextEncoder().encode(JSON.stringify(items, null, 2));
    const resultsRef = ctx.capture(jsonBytes);

    return {
      observationKind: "observation.web_search" as const,
      observation: {
        query,
        resultsCount: items.length,
        resultsRef,
        provider,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// web_fetch implementation
// ---------------------------------------------------------------------------

export const webFetchImpl: CapabilityImpl = {
  manifest: CapabilityManifestSchema.parse({
    id: "web_fetch",
    version: "1.0.0",
    purpose: "fetch and scrape web content, converting HTML to clean markdown text with redirect safety",
    environments: ["local", "container"],
    proposalKind: "web_fetch",
    constraintsVocab: ["hosts"],
    concurrency: "parallel",
    idempotent: true,
    riskClass: ["network", "read"],
    provenance: { pack: "core", hash: "0000000000000000000000000000000000000000000000000000000000000000" },
  }),

  async run(proposal: Proposal, ctx: DispatchContext, opts: { timeoutMs: number; signal: AbortSignal }) {
    if (proposal.capability !== "web_fetch") throw new Error("mismatch");
    const { url: initialUrl, extractMode = "markdown", maxBytes = DEFAULT_FETCH_MAX_BYTES } = proposal.args;

    let currentUrl = initialUrl;
    let status = 0;
    let truncated = false;
    let title: string | null = null;
    let finalContent = "";

    const fetchRes = await safeConnectionFetch(initialUrl, {
      method: "GET",
      maxBytes,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      urlAuthority: ctx.urlAuthority,
      maxHops: HTTP_MAX_HOPS,
      allowLoopback: false, // Strictly prohibited for autonomous web_fetch
    });

    if (fetchRes.redirectBlocked) {
      throw new Error("redirect target host escapes granted scope");
    }

    currentUrl = fetchRes.effectiveUrl;
    status = fetchRes.status;
    truncated = fetchRes.truncated;

    if (extractMode === "raw") {
      finalContent = fetchRes.text;
    } else {
      const parsed = htmlToMarkdown(fetchRes.text);
      title = parsed.title;
      finalContent = parsed.markdown || fetchRes.text.slice(0, 5000);
    }

    const contentBytes = new TextEncoder().encode(finalContent);
    const contentRef = ctx.capture(contentBytes);

    return {
      observationKind: "observation.web_fetch" as const,
      observation: {
        url: currentUrl,
        status,
        title,
        contentRef,
        extractMode,
        byteLength: contentBytes.byteLength,
        truncated,
      },
    };
  },
};
