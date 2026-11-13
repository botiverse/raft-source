// "Show the model name next to an agent's name" — an appearance option
// (@WAWQAQ 2026-09-10). On by default on web and desktop (see appearanceStore);
// once the toggle is stored, the display simply follows the toggle everywhere.
import { getModelLabel } from "@botiverse/raft-shared";
import { useAppearanceStore } from "../store/appearanceStore";
import { catalogModelLabel } from "../store/modelLabelCatalogStore";
import { useServerStore } from "../store/serverStore";

/**
 * The model label to render next to an agent's name, or null when there's
 * nothing meaningful to show. Uses the synchronous static label — the same
 * terminal fallback the richer profile-card helper resolves to — so it's cheap
 * enough to call per message row without a catalog fetch.
 */
export function agentModelLabel(
  agent: { runtime?: string | null; model?: string | null; machineId?: string | null } | null | undefined,
): string | null {
  if (!agent?.model) return null;
  // One shared catalog source (task #700): the name the daemon reported for
  // this machine's runtime beats local re-derivation; the bundled table is
  // only the fallback while a machine has not reported yet.
  const sharedLabel = catalogModelLabel(
    useServerStore.getState().current?.id,
    agent.machineId,
    agent.runtime,
    agent.model,
  );
  if (sharedLabel) return sharedLabel;
  const label = getModelLabel(agent.runtime ?? "", agent.model);
  return label || agent.model || null;
}

/** Whether to show the agent model name (reactive to the appearance toggle). */
export function useShowAgentModelName(): boolean {
  return useAppearanceStore((s) => s.showAgentModelName);
}
