// FORGE capabilities — http (GET/HEAD, byte-capped, redirect-safe).
// Redirects are followed MANUALLY: every hop's destination is revalidated
// against the dispatching grant's host scope (ctx.urlAuthority — bound by the
// engine to the gate-approved grant). A redirect to a non-granted host is
// refused: the effect must never exceed the granted scope (F-01, ADR-007 #14).
// The observation records the EFFECTIVE final URL.

import type { CapabilityImpl } from "../capability-host/types.js";
import type { Proposal } from "../contracts/index.js";
import type { DispatchContext } from "../capability-host/types.js";
import { CapabilityManifestSchema } from "../contracts/grants.js";
import { safeConnectionFetch } from "./safe-http.js";

export const HTTP_MAX_HOPS = 5;

export const httpImpl: CapabilityImpl = {
  manifest: CapabilityManifestSchema.parse({
    id: "http", version: "1.1.0", purpose: "fetch HTTP resources (GET/HEAD, byte-capped, redirect-revalidated)",
    environments: ["local", "container"], proposalKind: "http",
    constraintsVocab: ["hosts", "methods"], concurrency: "parallel",
    idempotent: true, riskClass: ["network"],
    provenance: { pack: "core", hash: "0000000000000000000000000000000000000000000000000000000000000000" },
  }),
  async run(proposal: Proposal, ctx: DispatchContext, opts: { timeoutMs: number; signal: AbortSignal }) {
    if (proposal.capability !== "http") throw new Error("mismatch");
    const { method, maxBytes } = proposal.args;
    const url = proposal.args.url;

    const fetchRes = await safeConnectionFetch(url, {
      method,
      maxBytes,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      urlAuthority: ctx.urlAuthority,
      maxHops: HTTP_MAX_HOPS,
      allowLoopback: true, // Governed by ctx.urlAuthority
    });

    const body = fetchRes.body;
    const bodyRef = body.byteLength > 0 ? ctx.capture(body) : null;
    return {
      observationKind: "observation.http",
      observation: {
        method,
        url: proposal.args.url,
        status: fetchRes.status,
        bodyRef,
        truncated: fetchRes.truncated,
        effectiveUrl: fetchRes.effectiveUrl,
        redirectBlocked: fetchRes.redirectBlocked,
      },
    };
  },
};
