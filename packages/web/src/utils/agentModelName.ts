// "Show the model name next to an agent's name" — an appearance option
// (@WAWQAQ 2026-09-10). It's a normal web feature whose DEFAULT differs by
// platform (on in the desktop shell, off on web/mobile — see appearanceStore);
// once the toggle is stored, the display simply follows the toggle everywhere.
import { getModelLabel } from "@botiverse/raft-shared";
import { useAppearanceStore } from "../store/appearanceStore";

/**
 * The model label to render next to an agent's name, or null when there's
 * nothing meaningful to show. Uses the synchronous static label — the same
 * terminal fallback the richer profile-card helper resolves to — so it's cheap
 * enough to call per message row without a catalog fetch.
 */
export function agentModelLabel(
  agent: { runtime?: string | null; model?: string | null } | null | undefined,
): string | null {
  if (!agent?.model) return null;
  const label = getModelLabel(agent.runtime ?? "", agent.model);
  return label || agent.model || null;
}

/** Whether to show the agent model name (reactive to the appearance toggle). */
export function useShowAgentModelName(): boolean {
  return useAppearanceStore((s) => s.showAgentModelName);
}
