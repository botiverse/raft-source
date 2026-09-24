export const TASK_INTENT_QUERY_PARAM = "task";
export const LEGACY_TASK_QUERY_PARAM = "legacyTask";

export interface OpenPanelWindowTarget {
  serverSlug: string;
  parentChannelId: string;
  parentMessageId: string;
  parentChannelType?: "channel" | "dm";
  focusedMessageId?: string | null;
}

export interface OpenPanelLocation {
  pathname: string;
  search: string;
  origin?: string;
}

function absoluteOrigin(origin?: string): string {
  if (origin) return origin;
  if (typeof window !== "undefined" && window.location.origin) return window.location.origin;
  return "";
}

/**
 * Build a same-origin URL that can cold-load the requested thread-only window.
 * Only panel-owned query keys are replaced; view/filter/tab state remains
 * intact so opening a second window does not mutate the first window's URL.
 */
export function buildThreadWindowUrl(
  location: OpenPanelLocation,
  target: OpenPanelWindowTarget,
  intent: "thread" | "task" = "thread",
): string {
  const routePath = `/s/${encodeURIComponent(target.serverSlug)}/thread-window`;
  const params = new URLSearchParams(location.search);
  params.delete("thread");
  params.delete("msg");
  params.delete("profile");
  params.delete(TASK_INTENT_QUERY_PARAM);
  params.delete(LEGACY_TASK_QUERY_PARAM);
  params.set("thread", `${target.parentChannelId}:${target.parentMessageId}`);
  params.set("msg", target.focusedMessageId ?? target.parentMessageId);
  if (intent === "task") params.set(TASK_INTENT_QUERY_PARAM, "1");
  const search = params.toString();
  const path = search ? `${routePath}?${search}` : routePath;
  const origin = absoluteOrigin(location.origin);
  return origin ? `${origin}${path}` : path;
}

export function buildLegacyTaskWindowUrl(
  location: OpenPanelLocation,
  target: { serverSlug: string; channelId: string; taskId: string; channelType?: "channel" | "dm" },
): string {
  const params = new URLSearchParams(location.search);
  params.delete("thread");
  params.delete("msg");
  params.delete("profile");
  params.delete(TASK_INTENT_QUERY_PARAM);
  params.set(LEGACY_TASK_QUERY_PARAM, `${target.channelId}:${target.taskId}`);
  params.set("chatTab", "tasks");
  const path = `/s/${encodeURIComponent(target.serverSlug)}/thread-window`;
  const search = params.toString();
  const origin = absoluteOrigin(location.origin);
  return `${origin}${path}${search ? `?${search}` : ""}`;
}

function openFallbackTab(url: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return true;
}

/** Must be called synchronously from the user gesture to avoid popup blockers. */
export function openPanelInNewTab(url: string): boolean {
  // A real anchor is the browser-native new-tab primitive. Unlike
  // window.open, target=_blank + rel=noopener is both a normal tab and an
  // enforceable opener boundary; no popup feature string or duplicate-tab
  // detection is needed.
  return openFallbackTab(url);
}
