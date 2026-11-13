/**
 * Released runtime form definitions, frozen.
 *
 * Installed clients parse a runtime form by its schemaVersion. Once a version
 * has shipped, the server answers requests for it with the exact definition
 * recorded here, never with whatever the current code would generate, so a
 * server change cannot break a build that is already on someone's phone.
 * See README.md for the rules.
 */
import type { AgentCreateFormDefinition } from "@botiverse/raft-shared";

import builtinPiCreateV3 from "../released/builtin-pi.create.v3.json" with { type: "json" };
import kimiSdkCreateV1 from "../released/kimi-sdk.create.v1.json" with { type: "json" };

export type ReleasedRuntimeFormProvenance = {
  schemaVersion: string;
  releasedIn: string;
  serverCommit: string;
  capturedAt: string;
  note: string;
};

export type ReleasedRuntimeForm = {
  provenance: ReleasedRuntimeFormProvenance;
  definition: AgentCreateFormDefinition;
  /** Option values that shipped with this version and must stay available. */
  releasedOptionIds?: { provider: string[] };
};

// The JSON files are the wire bodies the released server sent; this module is
// the one place they are typed.
const released = [builtinPiCreateV3, kimiSdkCreateV1] as unknown as ReleasedRuntimeForm[];

export const RELEASED_RUNTIME_FORMS: ReadonlyMap<string, ReleasedRuntimeForm> = new Map(
  released.map((form) => [form.definition.schemaVersion, form]),
);

export function releasedRuntimeFormDefinition(schemaVersion: string): AgentCreateFormDefinition | null {
  const form = RELEASED_RUNTIME_FORMS.get(schemaVersion);
  // Hand out a copy: callers must not be able to mutate the frozen record.
  return form ? (structuredClone(form.definition) as AgentCreateFormDefinition) : null;
}

export * from "./v2";
export * from "./v2State";
export * from "./v3Rules";
