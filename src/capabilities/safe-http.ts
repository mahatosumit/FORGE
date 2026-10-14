// FORGE Governed Safe HTTP Client (Step 6 Hardening).
// Connection-level destination validation against SSRF and DNS rebinding.
// Pins raw TCP/TLS socket connections to validated non-private destination IPs.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { lookup } from "node:dns/promises";

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  urlAuthority?: (url: string) => boolean;
  maxHops?: number;
  allowLoopback?: boolean;
}

export interface SafeFetchResult {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  text: string;
  effectiveUrl: string;
  truncated: boolean;
  redirectBlocked: boolean;
}

/**
 * Checks if an IPv4 address string (or numeric representation) falls in private/reserved CIDRs.
 */
function isPrivateIpv4(ip: string, allowLoopback = false): boolean {
  // Support numeric forms (e.g. integer dword 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(ip)) {
    const num = Number(ip);
    if (!Number.isNaN(num) && num >= 0 && num <= 0xffffffff) {
      const a = (num >>> 24) & 255;
      const b = (num >>> 16) & 255;
      return isPrivateIpv4Octets(a, b, allowLoopback);
    }
  }

  // Handle octal/hex components
  const rawParts = ip.split(".");
  if (rawParts.length === 4) {
    const parts = rawParts.map((p) => {
      if (/^0x/i.test(p)) return parseInt(p, 16);
      if (/^0\d+/.test(p)) return parseInt(p, 8);
      return Number(p);
    });
    if (parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
      return isPrivateIpv4Octets(parts[0]!, parts[1]!, allowLoopback);
    }
  }

  return false;
}

function isPrivateIpv4Octets(a: number, b: number, allowLoopback = false): boolean {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return !allowLoopback; // Loopback 127.0.0.0/8
  if (a === 10) return !allowLoopback; // Private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return !allowLoopback; // Private 172.16.0.0/12
  if (a === 192 && b === 168) return !allowLoopback; // Private 192.168.0.0/16
  if (a === 169 && b === 254) return true; // Link-local / metadata 169.254.0.0/16 ALWAYS BLOCKED
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0) return true; // IETF Protocol 192.0.0.0/24 & 192.0.2.0/24
  if (a === 198 && (b === 51 || b >= 18 && b <= 19)) return true; // Benchmarking 198.18.0.0/15 & 198.51.100.0/24
  if (a === 203 && b === 0) return true; // Documentation 203.0.113.0/24
  if (a >= 224) return true; // Multicast 224.0.0.0/4 & Reserved 240.0.0.0/4
  return false;
}

/**
 * Checks if an IP address (v4 or v6) is private, loopback, link-local, CGNAT, or metadata.
 */
export function isPrivateOrReservedIp(ip: string, allowLoopback = false): boolean {
  const norm = ip.toLowerCase().trim();
  if (norm === "::1" || norm === "0:0:0:0:0:0:0:1" || norm === "::") return !allowLoopback;

  // IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (norm.startsWith("::ffff:")) {
    const rest = norm.slice(7);
    if (rest.includes(".")) return isPrivateIpv4(rest, allowLoopback);
    // hex format ::ffff:7f00:0001
    const hexParts = rest.split(":");
    if (hexParts.length === 2) {
      const val = parseInt(hexParts[0]!, 16) * 65536 + parseInt(hexParts[1]!, 16);
      return isPrivateIpv4(String(val), allowLoopback);
    }
    return true;
  }

  // Pure IPv4
  if (norm.includes(".") || /^\d+$/.test(norm)) {
    return isPrivateIpv4(norm, allowLoopback);
  }

  // IPv6 ULA (fc00::/7)
  if (norm.startsWith("fc") || norm.startsWith("fd")) return true;

  // IPv6 Link-Local (fe80::/10)
  if (
    norm.startsWith("fe8") ||
    norm.startsWith("fe9") ||
    norm.startsWith("fea") ||
    norm.startsWith("feb")
  ) {
    return true;
  }

  return false;
}

/**
 * Validates a URL destination against SSRF, resolving DNS and verifying that all resolved IPs are safe.
 * Returns the verified IP to pin the connection to.
 */
export async function resolveAndValidateDestination(url: URL, allowLoopback = false): Promise<string> {
  const hostname = url.hostname.toLowerCase().trim();

  // Strip brackets from IPv6
  const cleanHost = hostname.replace(/^\[|\]$/g, "");

  // Prohibit local / loopback host names if loopback is not allowed
  if (!allowLoopback) {
    if (
      cleanHost === "localhost" ||
      cleanHost === "0.0.0.0" ||
      cleanHost === "127.0.0.1" ||
      cleanHost === "::1" ||
      cleanHost.endsWith(".localhost") ||
      cleanHost.endsWith(".local") ||
      cleanHost.endsWith(".internal")
    ) {
      throw new Error(`SSRF blocked: request to local/loopback host "${cleanHost}" is prohibited`);
    }
  }

  // Direct IP in URL
  if (isPrivateOrReservedIp(cleanHost, allowLoopback)) {
    throw new Error(`SSRF blocked: destination IP "${cleanHost}" is a private or reserved network address`);
  }

  // Pre-flight DNS resolution
  const addrs = await lookup(cleanHost, { all: true });
  if (addrs.length === 0) {
    throw new Error(`DNS resolution failed for host "${cleanHost}"`);
  }

  // Check EVERY returned IP address
  for (const addr of addrs) {
    if (isPrivateOrReservedIp(addr.address, allowLoopback)) {
      throw new Error(`SSRF blocked: host "${cleanHost}" resolved to private/reserved IP "${addr.address}"`);
    }
  }

  // Prefer IPv4 if available for broad socket compatibility
  const chosen = addrs.find((a) => a.family === 4) ?? addrs[0]!;
  return chosen.address;
}

/**
 * Governed connection-pinned HTTP client with strict SSRF and DNS-rebinding protection.
 */
export async function safeConnectionFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxHops = opts.maxHops ?? 5;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const deadline = Date.now() + timeoutMs;

  let currentUrl = rawUrl;
  let redirectBlocked = false;

  for (let hop = 0; hop <= maxHops; hop++) {
    if (hop === maxHops) {
      return {
        status: 0,
        headers: {},
        body: new Uint8Array(0),
        text: "",
        effectiveUrl: currentUrl,
        truncated: false,
        redirectBlocked: true,
      };
    }

    let url: URL;
    try {
      url = new URL(currentUrl);
    } catch {
      throw new Error(`invalid fetch URL: ${currentUrl}`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`forbidden protocol: ${url.protocol}`);
    }

    // Connection-level DNS validation and socket IP pinning
    const pinnedIp = await resolveAndValidateDestination(url, opts.allowLoopback ?? false);

    const remainingTime = Math.max(100, deadline - Date.now());
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;

    const hopResult = await new Promise<{
      status: number;
      headers: Record<string, string>;
      body: Uint8Array;
      truncated: boolean;
      location: string | null;
    }>((resolve, reject) => {
      const controller = new AbortController();
      let aborted = false;

      const onAbort = () => {
        aborted = true;
        controller.abort();
        req.destroy();
        reject(new Error("fetch aborted via signal"));
      };

      if (opts.signal?.aborted) {
        onAbort();
        return;
      }

      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        aborted = true;
        req.destroy();
        reject(new Error("connection timeout"));
      }, remainingTime);

      const port = optionsPort(optionsPortFromUrl(url, isHttps));

      function optionsPortFromUrl(u: URL, httpsMode: boolean): number {
        return u.port ? Number(u.port) : httpsMode ? 443 : 80;
      }

      function optionsPort(fallback: number): number {
        return fallback;
      }

      const req = mod.request(
        url,
        {
          method: opts.method ?? "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
            Host: url.host,
            ...opts.headers,
          },
          // CRITICAL: Connection is pinned directly to the previously validated IP!
          // No unpinned DNS lookup occurs when the socket is created.
          createConnection: (options) => {
            const targetPort = Number(options.port || port);
            if (isHttps) {
              return tls.connect({
                host: pinnedIp,
                port: targetPort,
                servername: url.hostname,
              });
            } else {
              return net.connect({
                host: pinnedIp,
                port: targetPort,
              });
            }
          },
        },
        (res) => {
          clearTimeout(timer);
          const status = res.statusCode ?? 0;
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k.toLowerCase()] = v;
            else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
          }

          const location = headers["location"] ?? null;

          // If redirecting, drain and don't buffer body
          if (status >= 300 && status < 400 && location) {
            res.resume();
            resolve({ status, headers, body: new Uint8Array(0), truncated: false, location });
            return;
          }

          const chunks: Buffer[] = [];
          let totalBytes = 0;
          let truncated = false;
          let settled = false;

          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const combined = Buffer.concat(chunks);
            resolve({
              status,
              headers,
              body: new Uint8Array(combined),
              truncated,
              location,
            });
          };

          res.on("data", (chunk: Buffer) => {
            totalBytes += chunk.byteLength;
            if (totalBytes > maxBytes) {
              truncated = true;
              const allowed = Math.max(0, maxBytes - (totalBytes - chunk.byteLength));
              if (allowed > 0) chunks.push(chunk.subarray(0, allowed));
              try { req.destroy(); } catch {}
              try { res.destroy(); } catch {}
              finish();
            } else {
              chunks.push(chunk);
            }
          });

          res.on("end", () => {
            finish();
          });

          res.on("close", () => {
            finish();
          });

          res.on("error", (err) => {
            if (aborted || truncated) {
              finish();
            } else {
              clearTimeout(timer);
              reject(err);
            }
          });
        },
      );

      req.on("error", (err) => {
        clearTimeout(timer);
        if (!aborted) reject(err);
      });

      req.end();
    });

    if (hopResult.status >= 300 && hopResult.status < 400 && hopResult.location) {
      const next = new URL(hopResult.location, currentUrl).toString();
      if (opts.urlAuthority && !opts.urlAuthority(next)) {
        redirectBlocked = true;
        return {
          status: hopResult.status,
          headers: hopResult.headers,
          body: new Uint8Array(0),
          text: "",
          effectiveUrl: currentUrl,
          truncated: false,
          redirectBlocked: true,
        };
      }
      currentUrl = next;
      continue;
    }

    const text = new TextDecoder("utf-8", { fatal: false }).decode(hopResult.body);
    return {
      status: hopResult.status,
      headers: hopResult.headers,
      body: hopResult.body,
      text,
      effectiveUrl: currentUrl,
      truncated: hopResult.truncated,
      redirectBlocked,
    };
  }

  throw new Error("unexpected redirect loop termination");
}
