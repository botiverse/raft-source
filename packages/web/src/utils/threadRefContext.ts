import api from "../api/client";
import { readHistoryLimitedError } from "../store/hiddenHistoryStore";
import type { ContextCanonicalTarget } from "../store/hiddenHistoryStore";

/**
 * Where a thread ref points, from the context route. A thread whose first
 * message is behind the plan's history window still resolves, so it opens on
 * its history paywall (task #8, frame 7) wherever the ref was followed: in the
 * app, or from a link opened from outside it.
 */
export async function loadThreadRefContext(
  channelId: string,
  shortId: string,
): Promise<{ targetMessageId?: string | null; canonicalTarget?: ContextCanonicalTarget | null }> {
  try {
    const { data } = await api.get<{ targetMessageId?: string | null; canonicalTarget?: ContextCanonicalTarget | null }>(
      `/messages/context/${shortId}`,
      { params: { channelId } },
    );
    return data;
  } catch (error) {
    const hidden = readHistoryLimitedError(error);
    if (hidden) return hidden;
    throw error;
  }
}
