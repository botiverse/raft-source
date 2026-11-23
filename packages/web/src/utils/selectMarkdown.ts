import type { IntlShape } from "react-intl";
import type { Message } from "../store/messageStore";
import { dataUrlToBlob } from "./dataUrlBlob";
import { messageCardFallbackText } from "./messageCardFallbackText";

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
      const line = `**${m.senderName ?? unknownLabel}**: ${messageCardFallbackText(m.content).trim()}`;
      return m.isThreadChild ? `  ↳ ${line}` : line;
    })
    .join("\n\n");
}

/**
 * Where a copy is made: the window the person pressed Copy in (an object
 * window's, features/objectWindows: a browser lets only the focused
 * document write the clipboard). Default: the main window.
 */
export interface ClipboardTarget {
  view?: Window | null;
}

function clipboardViewOf(target: ClipboardTarget | undefined): Window {
  return target?.view ?? globalThis.window;
}

export async function copyTextToClipboard(
  text: string,
  formatMessage?: FormatMessage,
  target?: ClipboardTarget,
): Promise<void> {
  const view = clipboardViewOf(target);
  const clipboard = view === globalThis.window ? navigator.clipboard : view.navigator?.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Refused (some Android WebViews do): the fallback below.
    }
  }
  // Fallback for older WebKit / non-secure contexts, and where writeText was
  // refused. Insert a hidden textarea, select its contents, run
  // document.execCommand("copy"). This is intentionally minimal.
  const doc = view === globalThis.window ? document : view.document;
  const ta = doc.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  doc.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    if (!doc.execCommand("copy")) {
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
/** The window's ClipboardItem and clipboard (the main window's: the globals, as a test stubs them). */
function pngClipboardOf(target: ClipboardTarget | undefined): { Item: typeof ClipboardItem | undefined; clipboard: Clipboard | undefined } {
  const view = clipboardViewOf(target);
  if (view === globalThis.window) {
    return { Item: typeof ClipboardItem === "undefined" ? undefined : ClipboardItem, clipboard: navigator.clipboard };
  }
  const own = view as Window & { ClipboardItem?: typeof ClipboardItem };
  return { Item: own.ClipboardItem, clipboard: own.navigator?.clipboard };
}

export function isPngClipboardSupported(target?: ClipboardTarget): boolean {
  const { Item, clipboard } = pngClipboardOf(target);
  if (Item === undefined || typeof clipboard?.write !== "function") {
    return false;
  }
  return typeof Item.supports !== "function" || Item.supports("image/png");
}

export interface PngClipboardCapability {
  available: boolean;
  permissionStatus: PermissionStatus | null;
}

/** Resolve support + the browser's current clipboard-write permission. */
export async function resolvePngClipboardCapability(target?: ClipboardTarget): Promise<PngClipboardCapability> {
  if (!isPngClipboardSupported(target)) return { available: false, permissionStatus: null };
  const view = clipboardViewOf(target);
  const permissions = view === globalThis.window ? navigator.permissions : view.navigator?.permissions;
  if (typeof permissions?.query !== "function") {
    return { available: true, permissionStatus: null };
  }
  try {
    const permissionStatus = await permissions.query({
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

export async function copyPngDataUrlToClipboard(dataUrl: string, target?: ClipboardTarget): Promise<void> {
  if (!isPngClipboardSupported(target)) {
    throw new Error("Image clipboard is not supported in this browser");
  }
  const { Item, clipboard } = pngClipboardOf(target);
  if (!Item || !clipboard) throw new Error("Image clipboard is not supported in this browser");

  // Decoded in place, not fetched: Raft Desktop's page policy refuses `fetch` of a data URL (#triage:#352).
  const pngBlob = Promise.resolve().then(() => {
    const blob = dataUrlToBlob(dataUrl);
    return blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" });
  });

  await clipboard.write([
    new Item({
      "image/png": pngBlob,
    }),
  ]);
}

export async function dataUrlToPngFile(dataUrl: string, filename: string): Promise<File> {
  return new File([dataUrlToBlob(dataUrl)], filename, { type: "image/png" });
}
