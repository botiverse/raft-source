import { RUNTIME_MODELS, getDefaultModel } from "@botiverse/raft-shared";
import type { RuntimeModelInfo } from "@botiverse/raft-shared";

// Codex is a dynamic runtime source, but the create/detail model pickers still
// use Raft's bundled order for current host presets ahead of older live catalog
// entries. When the machine surfaces the bundled default, prefer it; otherwise
// fall back to the machine default or first ordered model.
//
// Kept as a pure module (no React/store imports) so it unit-tests without pulling
// the hook's dependency chain — same shape as reasoningEffortOptions.ts.
export function canonicalizeCodexPresentation(
  runtime: string,
  models: RuntimeModelInfo[],
  machineDefault: string | undefined,
): { models: RuntimeModelInfo[]; default: string | undefined } {
  if (runtime !== "codex") return { models, default: machineDefault };
  const canonicalOrder = (RUNTIME_MODELS.codex ?? []).map((entry) => entry.id);
  const rank = (id: string) => {
    const i = canonicalOrder.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  // Array.prototype.sort is stable (ES2019+), so live-only models (equal MAX rank)
  // retain their machine-reported relative order when appended after known models.
  const ordered = [...models].sort((a, b) => rank(a.id) - rank(b.id));
  const has = (id: string | undefined): id is string => !!id && ordered.some((entry) => entry.id === id);
  const preferred = getDefaultModel("codex"); // static RUNTIME_MODELS.codex[0]
  const nextDefault = has(preferred) ? preferred : has(machineDefault) ? machineDefault : ordered[0]?.id;
  return { models: ordered, default: nextDefault };
}
