import { normalizeActivityMuteState, normalizeMessageDisplayPrefs } from "../../store/channelDomain";

export const normalizeActivityMuteSettings = normalizeActivityMuteState;
export const normalizeMessageDisplaySettings = normalizeMessageDisplayPrefs;

export function getThreadParentMessageIdFromParam(threadParam: string | null): string | null {
  if (!threadParam) return null;
  const idx = threadParam.indexOf(":");
  if (idx <= 0) return null;
  const parentMessageId = threadParam.slice(idx + 1);
  return parentMessageId || null;
}

export function resolveChatPanelQueryFocusMessageId(searchParams: URLSearchParams): string | null {
  const rawFocusMessageId = searchParams.get("msg");
  const threadParam = searchParams.get("thread");
  if (!threadParam) return rawFocusMessageId;

  const parentMessageId = getThreadParentMessageIdFromParam(threadParam);
  return rawFocusMessageId === parentMessageId ? rawFocusMessageId : null;
}

export const WORKING_ID_SEPARATOR = "\u0000";
