import { useEffect, useState } from "react";
import api from "../../api/client";
import { FORWARD_CONVERSATION_TARGET_LIMIT, isConversationTarget } from "./forwardComposerModel";
import type { ForwardSearchTarget } from "./forwardComposerModel";

const NO_TARGETS: ForwardSearchTarget[] = [];

/**
 * The Forward picker's "Threads & tasks" group: the caller's most recent
 * threads and task discussions it can post in, fetched once as the dialog
 * opens. `currentChannelId`: the thread or task conversation the forward was
 * opened from, which the server puts first (flagged `current`). Null when the
 * host offers no such group (`enabled` false). A failed or empty answer is no
 * group: the picker shows Recent as before.
 */
export function useForwardConversationTargets({
  enabled,
  currentChannelId,
}: {
  enabled: boolean;
  currentChannelId: string | null;
}): ForwardSearchTarget[] {
  const [targets, setTargets] = useState<ForwardSearchTarget[]>(NO_TARGETS);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    api.get<{ targets?: ForwardSearchTarget[] }>("/messages/forward/targets/conversations", {
      params: {
        limit: FORWARD_CONVERSATION_TARGET_LIMIT,
        ...(currentChannelId ? { currentChannelId } : {}),
      },
    })
      .then((res) => {
        if (cancelled) return;
        const rows = Array.isArray(res.data?.targets) ? res.data.targets : NO_TARGETS;
        setTargets(orderConversationTargets(rows));
      })
      .catch(() => {
        if (!cancelled) setTargets(NO_TARGETS);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, currentChannelId]);
  return enabled ? targets : NO_TARGETS;
}

/** Only thread / task rows with a conversation to post in, the current one first, at most the group's limit. */
export function orderConversationTargets(rows: ForwardSearchTarget[]): ForwardSearchTarget[] {
  const usable = rows.filter((row) => isConversationTarget(row) && !!row.channelId);
  const current = usable.filter((row) => row.current === true).slice(0, 1);
  const rest = usable.filter((row) => !current.includes(row));
  return [...current, ...rest].slice(0, FORWARD_CONVERSATION_TARGET_LIMIT);
}
