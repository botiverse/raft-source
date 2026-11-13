// No imports on purpose: list services (channels, saved) cut previews of
// messages behind the plan's history window with it, and must not pull in
// historyWindow's message reads (an import cycle through channelService).

/**
 * The most a preview may show of a message behind the window, where a header
 * can't do without one (a thread's first message in Activity, search and the
 * saved list; the DM list's last message): 40 characters on one line, as the
 * paywall's own previews (cindyz, task #8).
 */
export const HISTORY_PREVIEW_CHARS = 40;

export function historyLimitedPreview(text: string | null | undefined, chars = HISTORY_PREVIEW_CHARS): string | null {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  if (!line) return null;
  const codePoints = Array.from(line);
  return codePoints.length > chars ? `${codePoints.slice(0, chars - 1).join("")}…` : line;
}
