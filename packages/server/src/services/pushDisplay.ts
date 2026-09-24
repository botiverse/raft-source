import { Marked } from "marked";
import markedPlaintify from "marked-plaintify";

const MAX_PUSH_BODY_LENGTH = 140;
const MAX_NOTIFICATION_MARKDOWN_SOURCE_LENGTH = 4_096;
const MARKDOWN_TO_PLAIN_TEXT = new Marked({ gfm: true }).use(markedPlaintify({
  code: ({ text }) => `${text}\n\n`,
  codespan: ({ text }) => text,
  html: () => "",
  image: ({ text }) => `${text || "Image"} `,
  link({ tokens }) {
    return this.parser.parseInline(tokens);
  },
}));

const HTML_ENTITY_REPLACEMENTS: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  "#39": "'",
  nbsp: " ",
};

function decodeCommonHtmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39|nbsp);/gi, (entity, name: string) => (
    HTML_ENTITY_REPLACEMENTS[name.toLowerCase()] ?? entity
  ));
}

/**
 * Produce notification-safe display text from message Markdown.
 *
 * This is intentionally a derived preview only: the persisted message body is
 * never rewritten. Keep the transform transport-agnostic so Web Push, mobile
 * socket notifications, and APNs cannot drift into separate display rules.
 */
export function toNotificationPlainText(content: string): string {
  const boundedSource = content.slice(0, MAX_NOTIFICATION_MARKDOWN_SOURCE_LENGTH);
  const rendered = MARKDOWN_TO_PLAIN_TEXT.parse(boundedSource);
  if (typeof rendered !== "string") {
    throw new Error("Notification Markdown renderer unexpectedly returned an async result");
  }
  return decodeCommonHtmlEntities(rendered).trim();
}

export function summarizePushBody(content: string, attachmentCount: number): string {
  const normalized = toNotificationPlainText(content).replace(/\s+/g, " ").trim();
  if (normalized) {
    return normalized.length <= MAX_PUSH_BODY_LENGTH
      ? normalized
      : `${normalized.slice(0, MAX_PUSH_BODY_LENGTH - 1)}…`;
  }
  if (attachmentCount === 1) return "Sent an attachment";
  if (attachmentCount > 1) return `Sent ${attachmentCount} attachments`;
  return "(no text)";
}

export function formatPushServerLabel(serverName: string | null | undefined, serverSlug: string): string {
  const trimmed = serverName?.trim();
  return trimmed || serverSlug;
}

export function formatPushSurfaceTitle(surface: string, serverLabel: string): string {
  return `${surface} · ${serverLabel}`;
}

export function formatPushBody(senderName: string, body: string, mentioned = false): string {
  return mentioned
    ? `${senderName} mentioned you: ${body}`
    : `${senderName}: ${body}`;
}
