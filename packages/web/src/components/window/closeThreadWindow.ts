export interface ThreadWindowCloseOptions {
  serverSlug?: string;
  closeThread: () => void;
  closeLegacyTask: () => void;
  closeBrowserWindow: () => void;
  isBrowserWindowClosed: () => boolean;
  navigate: (to: string, options: { replace: boolean }) => void;
}

export function buildTaskChannelUrl(
  serverSlug: string | undefined,
  channelId: string,
  messageId?: string | null,
  isLegacy = false,
  channelType: "channel" | "dm" = "channel",
): string {
  const routeKind = channelType === "dm" ? "dm" : "channel";
  const base = `/s/${encodeURIComponent(serverSlug ?? "")}/${routeKind}/${encodeURIComponent(channelId)}`;
  if (!isLegacy && messageId) return `${base}?msg=${encodeURIComponent(messageId)}`;
  return `${base}?chatTab=tasks`;
}

export function closeThreadWindow({ serverSlug, closeThread, closeLegacyTask, closeBrowserWindow, isBrowserWindowClosed, navigate }: ThreadWindowCloseOptions) {
  closeThread();
  closeLegacyTask();
  closeBrowserWindow();
  if (isBrowserWindowClosed()) return;
  navigate(serverSlug ? `/s/${encodeURIComponent(serverSlug)}` : "/", { replace: true });
}
