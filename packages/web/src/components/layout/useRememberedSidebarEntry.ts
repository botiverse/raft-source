import { useEffect, useMemo } from "react";
import { useMyAssistant } from "../../assistant/assistantClient";
import { useAuthStore } from "../../store/authStore";
import { PERSONAL_ASSISTANT_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useServerStore } from "../../store/serverStore";
import { accessTokenSubject } from "../../utils/hostAccessTokenSync";
import { readSidebarEntryShown, sidebarEntryShown, writeSidebarEntryShown } from "./sidebarSectionRowCounts";
import type { SidebarEntryRow } from "./sidebarSectionRowCounts";

/**
 * Whether an entry that depends on a late answer (Drafts, Assistant) shows:
 * the answer once known (null until then), and until then whatever was shown
 * the last time it was known on this server (sidebarSectionRowCounts), so the
 * entry is there from the outset instead of pushing everything below it down
 * when the answer lands. A known answer is remembered unless `remember` is
 * false (a failed read, which fails closed but says nothing about next time).
 */
export function useRememberedEntryShown(
  userId: string | null | undefined,
  serverId: string | null | undefined,
  entry: SidebarEntryRow,
  answer: boolean | null,
  remember = true,
): boolean {
  const remembered = useMemo(
    () => readSidebarEntryShown(userId, serverId, entry),
    [userId, serverId, entry],
  );
  useEffect(() => {
    if (answer === null || !remember) return;
    writeSidebarEntryShown(userId, serverId, entry, answer);
  }, [userId, serverId, entry, answer, remember]);
  return sidebarEntryShown(answer, remembered);
}

/**
 * The Assistant entry (phone Home's row, the desktop rail's icon): shown once
 * the assistant API says `ready`, and until it has answered as last time on
 * this server. A `personal_assistant` flag that could not be read reads as
 * off (useMyAssistant) but is not remembered, so the next start does not hide
 * an entry that is there. `ask`: false in a frame whose server is still
 * loading (nothing is fetched; the remembered answer stands).
 */
export function useRememberedAssistantShown({ ask = true }: { ask?: boolean } = {}): boolean {
  const userId = useAuthStore((s) => s.user?.id ?? accessTokenSubject(s.accessToken));
  const serverId = useServerStore((s) => s.current?.id);
  const flagState = useServerFeatureFlag(PERSONAL_ASSISTANT_FLAG_KEY, { prefetch: false }).state;
  const status = useMyAssistant({ ask }).status;
  return useRememberedEntryShown(
    userId,
    serverId,
    "assistant",
    status === "loading" ? null : status === "ready",
    flagState !== "undetermined",
  );
}
