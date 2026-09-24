// Canonical app-config reply formatting for agent-facing output.
// Moved verbatim from config.ts (print-seam S2); byte-pin test in
// _format.test.ts copies the pre-move literal shape.
// This is an AX contract, not an implementation detail.

import type { AgentApiAppConfigResponse } from "@botiverse/raft-shared";

import { axSurface } from "../../core/renderer.js";

export const formatAppConfig = axSurface(
  "Built-in app durable-config snapshot with per-key source and next action.",
  (snapshot: AgentApiAppConfigResponse): string => {
  const lines = [`App: ${snapshot.appId}`, `Revision: ${snapshot.revision}`, "Config:"];
  for (const key of Object.keys(snapshot.schema).sort()) {
    const source = Object.hasOwn(snapshot.overrides, key) ? "override" : "default";
    lines.push(`  ${key} = ${String(snapshot.effective[key])} (${source}; default ${String(snapshot.defaults[key])})`);
  }
  if (Object.keys(snapshot.schema).length === 0) lines.push("  (no configurable fields)");
  lines.push(`Next action: raft app config --app ${snapshot.appId}`);
  return (lines.join("\n"));
},
  {
    examples: [{ args: [{ appId: "cleaner", revision: 4, schema: { intervalMinutes: { type: "number" }, enabled: { type: "boolean" } }, defaults: { intervalMinutes: 30, enabled: true }, overrides: { intervalMinutes: 15 }, effective: { intervalMinutes: 15, enabled: true } } as never] }],
  },
);
