import type { AgentVisibleExternalMessageProvenance } from "@botiverse/raft-shared";

/** Old agent clients strictly validate this optional object and require actor_id. */
export function legacyAgentProvenance(
  provenance: AgentVisibleExternalMessageProvenance,
  identityKind: "provider_actor" | "anonymous" | null | undefined,
): AgentVisibleExternalMessageProvenance | undefined {
  if (identityKind === "anonymous") return undefined;
  if (!provenance.actor_id.trim()) throw new Error("External provider actor is missing its identity");
  return provenance;
}
