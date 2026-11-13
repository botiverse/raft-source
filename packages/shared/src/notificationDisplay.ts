// One display format for every notification surface (Web Push, mobile socket
// push, APNs and Raft Desktop). The server authors message notifications with
// these helpers; the desktop's local fallback path formats with the same ones,
// so a channel notification reads "#chan · Server" / "Sender: text" whichever
// side built it. Since the banner copy redesign the title is where a tap
// lands, the body `Sender: text` (a DM: the text alone, titled by the sender),
// and the server label is a separate subtitle shown only to members of
// several servers (server envelope.ts).
//
// Pure string helpers only. Markdown → plain text lives next to each author
// (the server renders with `marked`; clients use `notificationPlainText` below,
// which reads Markdown with the same parser the web renders messages with).

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { cjkFriendlyExtension } from "micromark-extension-cjk-friendly";
import type { Nodes } from "mdast";
import { formatNotificationCopy, type NotificationCopy } from "./notificationCopy";

export const MAX_NOTIFICATION_BODY_LENGTH = 140;
// Parse at most this much of a message for a notification: every surface shows
// far less (push 140 characters, desktop 512), and parsing is the server's
// per-message cost (about 2ms at this length, 4ms at 4KB).
const MAX_NOTIFICATION_MARKDOWN_SOURCE_LENGTH = 2_048;

export function formatPushServerLabel(serverName: string | null | undefined, serverSlug: string): string {
  const trimmed = serverName?.trim();
  return trimmed || serverSlug;
}

/** `title · context` for a title-only surface (Web Push, desktop folds): the subtitle joined to the title. */
export function formatPushSurfaceTitle(surface: string, serverLabel: string): string {
  return `${surface} · ${serverLabel}`;
}

/**
 * `Sender: text`. A mention reads the same (the "mentioned you" wording is
 * kept only for redacted previews, where the text is not shown).
 */
export function formatPushBody(senderName: string, body: string): string {
  return `${senderName}: ${body}`;
}

/** A task's title surface: `#12 Fix login`. */
export function formatTaskSurface(task: { number: number; title: string }): string {
  return `#${task.number} ${task.title}`;
}

export type NotificationSurface =
  | { kind: "dm" }
  | { kind: "channel"; channelName: string }
  | { kind: "thread"; parentKind: "dm" | "channel"; parentChannelName?: string | null };

/**
 * "DM", "#chan", "Thread in #chan" or "Thread in DM": the part before
 * " · Server". A channel thread whose parent name is unknown reads "Thread",
 * as the APNs title does.
 */
export function formatNotificationSurface(surface: NotificationSurface): string {
  if (surface.kind === "channel") return `#${surface.channelName}`;
  const copy = notificationSurfaceCopy(surface)!;
  return formatNotificationCopy(copy.key, copy.args);
}

/** The key of a surface label (notificationCopy.ts); null for `#chan`, which is a name. */
export function notificationSurfaceCopy(surface: NotificationSurface): NotificationCopy | null {
  if (surface.kind === "dm") return { key: "push.title.dm", args: [] };
  if (surface.kind === "channel") return null;
  if (surface.parentKind === "dm") return { key: "push.title.thread_in_dm", args: [] };
  return surface.parentChannelName
    ? { key: "push.title.thread_in_channel", args: [surface.parentChannelName] }
    : { key: "push.title.thread", args: [] };
}

/**
 * The key of a preview that is a fallback phrase (no text: "Sent an
 * attachment", "Sent 3 attachments", "(no text)"), or null when the preview
 * is the message text. With `senderName`, the `Sender: …` form of it.
 */
export function notificationPreviewCopy(plainText: string, attachmentCount: number, senderName?: string): NotificationCopy | null {
  if (plainText.replace(/\s+/g, " ").trim()) return null;
  const count = String(attachmentCount);
  if (senderName === undefined) {
    if (attachmentCount === 1) return { key: "push.body.attachment", args: [] };
    if (attachmentCount > 1) return { key: "push.body.attachments", args: [count] };
    return { key: "push.body.no_text", args: [] };
  }
  if (attachmentCount === 1) return { key: "push.body.sender_attachment", args: [senderName] };
  if (attachmentCount > 1) return { key: "push.body.sender_attachments", args: [senderName, count] };
  return { key: "push.body.sender_no_text", args: [senderName] };
}

/** Collapse whitespace and cut to the push preview length, with attachment fallbacks. */
export function boundNotificationPreview(plainText: string, attachmentCount: number): string {
  const normalized = plainText.replace(/\s+/g, " ").trim();
  if (normalized) {
    return normalized.length <= MAX_NOTIFICATION_BODY_LENGTH
      ? normalized
      : `${normalized.slice(0, MAX_NOTIFICATION_BODY_LENGTH - 1)}…`;
  }
  const copy = notificationPreviewCopy(normalized, attachmentCount)!;
  return formatNotificationCopy(copy.key, copy.args);
}

function collectPlainText(node: Nodes, out: string[]): void {
  switch (node.type) {
    case "text":
    case "inlineCode":
      out.push(node.value);
      return;
    case "code":
      out.push(node.value, "\n");
      return;
    case "html":
      return;
    case "image":
      out.push(node.alt || "Image", " ");
      return;
    case "imageReference":
      out.push(node.alt || "Image", " ");
      return;
    case "break":
      out.push("\n");
      return;
    case "thematicBreak":
    case "definition":
      return;
    case "table": {
      // Each body cell after its column's header, "Name: value", a row per
      // line: a table read as a run of words loses which value is which.
      const [header, ...rows] = node.children;
      const headings = (header?.children ?? []).map((cell) => {
        const text: string[] = [];
        collectPlainText(cell, text);
        return text.join("").trim();
      });
      for (const row of rows) {
        row.children.forEach((cell, index) => {
          const text: string[] = [];
          collectPlainText(cell, text);
          out.push(`${headings[index] ?? ""}: ${text.join("").trim()}`, "\n");
        });
      }
      return;
    }
    default:
      break;
  }
  if ("children" in node) {
    for (const child of node.children as Nodes[]) collectPlainText(child, out);
    if (node.type === "paragraph" || node.type === "heading" || node.type === "listItem" || node.type === "tableRow") out.push("\n");
    if (node.type === "tableCell") out.push(" ");
  }
}

/**
 * Notification-safe plain text from message Markdown: emphasis, links, code
 * fences and HTML never leak into an OS notification. A derived preview only.
 */
export function notificationPlainText(content: string): string {
  const source = content.slice(0, MAX_NOTIFICATION_MARKDOWN_SOURCE_LENGTH);
  try {
    const tree = fromMarkdown(source, { extensions: [gfm(), cjkFriendlyExtension()], mdastExtensions: [gfmFromMarkdown()] });
    const out: string[] = [];
    collectPlainText(tree, out);
    return out.join("").replace(/\n{2,}/g, "\n").trim();
  } catch {
    return source.trim();
  }
}
