import type { IntlShape } from "react-intl";
import type { Message } from "../store/messageStore";
import { dataUrlToBlob } from "./dataUrlBlob";

type FormatMessage = IntlShape["formatMessage"];

export type SelectableMessage = Message & { isThreadChild?: boolean };

/**
 * Render the selected messages as a markdown block suitable for pasting
 * elsewhere (Linear, GitHub, Notion, …).
 *
 * Format (locked with @huxijin in #proj-mobile:fd343bd8, 2026-04-28):
 *   **Sender**: message content
 *   <blank line>
 *   **Sender**: next message content
 *
 * v1.4 (2026-04-29): when a message is a thread child its block is
 * indented two spaces and prefixed with `↳ ` so it visually nests under
 * its parent in the rendered markdown. Plain prefix; no `>` blockquote
 * (would convert children into a different markdown construct than the
 * parent — we want them to read as the same kind of message, just nested).
 *
 * - Messages are sorted by `seq` (or `createdAt` fallback) so the output
 *   reads top-to-bottom in chat order regardless of click order.
 * - Inline markdown inside `content` (code spans, bold, links) is preserved
 *   verbatim — this is "copy markdown", not "copy plain text".
 * - No timestamps in v0; revisit when users ask.
 */
export function selectionToMarkdown(
  messages: SelectableMessage[],
  formatMessage?: FormatMessage,
): string {
  const unknownLabel = formatMessage
    ? formatMessage({ id: "message.author.unknown" })
    : "Unknown";
  const sorted = [...messages].sort((a, b) => {
    if (a.seq != null && b.seq != null) return a.seq - b.seq;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
  return sorted
    .map((m) => {
      const line = `**${m.senderName ?? unknownLabel}**: ${m.content.trim()}`;
      return m.isThreadChild ? `  ↳ ${line}` : line;
    })
    .join("\n\n");
}

export async function copyTextToClipboard(
  text: string,
  formatMessage?: FormatMessage,
): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for older WebKit / non-secure contexts. Insert a hidden
  // textarea, select its contents, run document.execCommand("copy"). This
  // is intentionally minimal — Slock targets modern browsers.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error(
        formatMessage
          ? formatMessage({ id: "message.share.clipboardRejected" })
          : "The browser rejected the clipboard copy command",
      );
    }
  } finally {
    ta.remove();
  }
}

/**
 * Copy a rendered PNG data URL to the system clipboard.
 *
 * Keep the blob conversion inside ClipboardItem's promise so
 * `navigator.clipboard.write()` runs in the original click activation. This
 * matters in WebKit, which can reject an image copy if we await `fetch()`
 * before invoking the clipboard API.
 */
export function isPngClipboardSupported(): boolean {
  if (typeof ClipboardItem === "undefined" || typeof navigator.clipboard?.write !== "function") {
    return false;
  }
  return typeof ClipboardItem.supports !== "function" || ClipboardItem.supports("image/png");
}

export interface PngClipboardCapability {
  available: boolean;
  permissionStatus: PermissionStatus | null;
}

/** Resolve support + the browser's current clipboard-write permission. */
export async function resolvePngClipboardCapability(): Promise<PngClipboardCapability> {
  if (!isPngClipboardSupported()) return { available: false, permissionStatus: null };
  if (typeof navigator.permissions?.query !== "function") {
    return { available: true, permissionStatus: null };
  }
  try {
    const permissionStatus = await navigator.permissions.query({
      name: "clipboard-write" as PermissionName,
    });
    return { available: permissionStatus.state !== "denied", permissionStatus };
  } catch {
    // Firefox and older WebKit can expose Permissions API while rejecting the
    // clipboard-write descriptor. The clipboard API itself remains the source
    // of truth there, so keep the action available.
    return { available: true, permissionStatus: null };
  }
}

export async function copyPngDataUrlToClipboard(dataUrl: string): Promise<void> {
  if (!isPngClipboardSupported()) {
    throw new Error("Image clipboard is not supported in this browser");
  }

  // Decoded in place, not fetched: Raft Desktop's page policy refuses `fetch` of a data URL (#triage:#352).
  const pngBlob = Promise.resolve().then(() => {
    const blob = dataUrlToBlob(dataUrl);
    return blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" });
  });

  await navigator.clipboard.write([
    new ClipboardItem({
      "image/png": pngBlob,
    }),
  ]);
}

export async function dataUrlToPngFile(dataUrl: string, filename: string): Promise<File> {
  return new File([dataUrlToBlob(dataUrl)], filename, { type: "image/png" });
}
