// What `raft focus` and `raft unfocus` print. Agent-facing: one fact per
// line, then the one command the agent most likely runs next (AGENTS.md §8).
// Nothing here says what focusing does to delivery: this part of Focus only
// keeps the list.

import type { AgentApiResponseByRoute } from "@botiverse/raft-shared";
import { foldAgentOneLineText, formatHint, parseAgentTaskRef, RAFT_HINTS } from "@botiverse/raft-shared/src/agentCliSurface";

type FocusEntry = AgentApiResponseByRoute["focusList"]["entries"][number];
type FocusListing = Pick<AgentApiResponseByRoute["focusList"], "entries" | "limit">;

/** `task #proj:#7` for a task's conversation, as `raft inbox check` names it; the target itself otherwise. */
export function focusTargetLabel(target: string): string {
  const oneLine = foldAgentOneLineText(target);
  return parseAgentTaskRef(oneLine) ? `task ${oneLine}` : oneLine;
}

/** `Focused (2 of 3): a, b`, or null when nothing is focused. */
function focusedLine({ entries, limit }: FocusListing): string | null {
  if (entries.length === 0) return null;
  return `Focused (${entries.length} of ${limit}): ${entries.map((entry) => focusTargetLabel(entry.target)).join(", ")}`;
}

function evictedLine(entry: FocusEntry): string {
  return `Unfocused ${focusTargetLabel(entry.target)} (least recently active). Its updates go to your inbox again. To return: ${formatHint(RAFT_HINTS.focus(entry.target))}`;
}

export function formatFocusResult(result: AgentApiResponseByRoute["focus"]): string {
  const listing = focusedLine(result);
  if (result.alreadyFocused) {
    return [
      `Already focused on ${focusTargetLabel(result.focused.target)}.`,
      ...(listing ? [listing] : []),
    ].join("\n");
  }
  return [
    `Focused ${focusTargetLabel(result.focused.target)}.`,
    ...result.evicted.map(evictedLine),
    ...(listing ? [listing] : []),
    `Unfocus: ${formatHint(RAFT_HINTS.unfocus(result.focused.target))}`,
  ].join("\n");
}

export function formatFocusList(listing: FocusListing): string {
  const line = focusedLine(listing);
  if (!line) return `Nothing focused. Focus a thread, DM or task conversation: ${formatHint(RAFT_HINTS.focus("<target>"))}`;
  return [line, `Unfocus one: ${formatHint(RAFT_HINTS.unfocus("<target>"))}`].join("\n");
}

export function formatUnfocusResult(result: AgentApiResponseByRoute["unfocus"]): string {
  const label = focusTargetLabel(result.target);
  if (!result.wasFocused) return `${label} was not focused.`;
  return [
    `Unfocused ${label}. Its updates go to your inbox.`,
    focusedLine(result) ?? "Nothing focused.",
  ].join("\n");
}
