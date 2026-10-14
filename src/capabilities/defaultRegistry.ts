// FORGE Default Capability Registry Factory (Step 6 Phase 3 & 9).
// Instantiates and registers all 11 built-in and adapter capabilities with V2 manifests.

import { CapabilityRegistry, type CapabilityImplV2 } from "./registry.js";
import {
  fsManifestV2,
  shellManifestV2,
  gitManifestV2,
  httpManifestV2,
  searchManifestV2,
  verifyManifestV2,
  artifactManifestV2,
  webSearchManifestV2,
  webFetchManifestV2,
  mcpCallManifestV2,
  mcpServerStartManifestV2,
  mcpServerStopManifestV2,
  docParseManifestV2,
} from "./manifests.js";
import { builtinCapabilities } from "./index.js";

export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  const builtins = builtinCapabilities();

  const registrations = [
    { manifest: fsManifestV2, id: "fs" },
    { manifest: shellManifestV2, id: "shell" },
    { manifest: gitManifestV2, id: "git" },
    { manifest: httpManifestV2, id: "http" },
    { manifest: searchManifestV2, id: "search" },
    { manifest: verifyManifestV2, id: "verify" },
    { manifest: artifactManifestV2, id: "artifact" },
    { manifest: webSearchManifestV2, id: "web_search" },
    { manifest: webFetchManifestV2, id: "web_fetch" },
    { manifest: mcpCallManifestV2, id: "mcp_call" },
    { manifest: mcpServerStartManifestV2, id: "mcp_server_start" },
    { manifest: mcpServerStopManifestV2, id: "mcp_server_stop" },
    { manifest: docParseManifestV2, id: "doc_parse" },
  ];

  for (const { manifest, id } of registrations) {
    const originalImpl = builtins.get(id);
    if (!originalImpl) {
      throw new Error(`missing builtin implementation for capability "${id}"`);
    }

    const artifactBytes = new TextEncoder().encode(`FORGE_BUILTIN_CAPABILITY_V1:${id}`);
    (originalImpl as any).artifactBytes = artifactBytes;
    const implV2: CapabilityImplV2 = {
      manifest,
      run: originalImpl.run,
      artifactBytes,
    };

    registry.register(manifest, implV2);
  }

  return registry;
}
