/**
 * Shared inert renderer for app-controlled third-party text.
 *
 * Contract:
 * - Input is app-controlled free text such as app name, developer display name,
 *   description, and declared data-access wording.
 * - Output is canonical agent-facing text. It is safe to place in marketplace,
 *   install disclosure, app metadata, and tool-result readouts.
 * - Markdown inline/fenced code is literal data; ref-shaped text inside it is
 *   never parsed or rewritten.
 * - Structured values such as normalized domains, callback URLs, categories, and
 *   closed scope enums do not belong here; those should be rendered from
 *   server-normalized values at the call site.
 * - Raft's own system apps' event content is not app-controlled and is not
 *   rendered here (docs/development/third-party-rendering.md).
 */

import { extractRaftRefTargets, type RaftRefTarget } from "./raftRefs";

export type ThirdPartyInertTextField =
  | "app_name"
  | "developer_name"
  | "publisher_name"
  | "description"
  | "when_to_use"
  | "data_access"
  | "tool_result";

export interface RenderThirdPartyInertTextInput {
  field: ThirdPartyInertTextField;
  value: string | null | undefined;
}

export interface RenderThirdPartyInertDisclosureFieldInput extends RenderThirdPartyInertTextInput {
  label: string;
}

const MAX_INERT_TEXT_LENGTH = 4_000;

function clampText(value: string): string {
  if (value.length <= MAX_INERT_TEXT_LENGTH) return value;
  return `${value.slice(0, MAX_INERT_TEXT_LENGTH)}\n[truncated]`;
}

function escapeAgentMarkupLiterals(value: string): string {
  return value.replace(/<\/?(?:result|preview|match)\b[^>]*>|<omit\s*\/>/gi, (tag) => tag
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;"));
}

/**
 * `owner/repo#123` or `PR#12`: a number glued to the word before it is an issue
 * reference, not a channel, so it reads as written. Latin only, so `看#123`
 * stays a ref, and numbers only: `foo#general` is still rewritten.
 */
function isGluedIssueNumber(value: string, ref: { start: number; end: number; target: RaftRefTarget }): boolean {
  return ref.target.kind === "channel"
    && ref.start > 0
    && /[A-Za-z0-9_/.-]/.test(value[ref.start - 1]!)
    && /^#[0-9]+$/.test(value.slice(ref.start, ref.end));
}

export function neutralizeRaftRefLiterals(value: string): string {
  const refs = extractRaftRefTargets(value, { dedupe: false, includeMarkdownCode: false })
    .filter((ref) => ref.start < ref.end && !isGluedIssueNumber(value, ref))
    .sort((a, b) => a.start - b.start || b.end - a.end);

  if (refs.length === 0) return value;

  let output = "";
  let cursor = 0;
  for (let index = 0; index < refs.length;) {
    const first = refs[index]!;
    if (first.start < cursor) {
      index++;
      continue;
    }

    const cluster = [first];
    let clusterEnd = first.end;
    index++;
    while (index < refs.length && refs[index]!.start < clusterEnd) {
      const next = refs[index]!;
      cluster.push(next);
      clusterEnd = Math.max(clusterEnd, next.end);
      index++;
    }

    output += value.slice(cursor, first.start);
    output += cluster.map((ref) => neutralRaftRefLabel(ref.target)).join(" ");
    cursor = clusterEnd;
  }
  output += value.slice(cursor);
  return output;
}

function neutralRaftRefLabel(target: RaftRefTarget): string {
  switch (target.kind) {
    case "user":
      return `user:${target.name}`;
    case "computer":
      return `computer:${target.machineId}`;
    case "app":
      return `app:${target.appId}`;
    case "channel":
      return `channel:${target.channelName}`;
    case "channel-thread":
      return `channel:${target.channelName}:${target.threadShortId}`;
    case "dm":
      return `dm:user:${target.peerName}`;
    case "dm-thread":
      return `dm:user:${target.peerName}:${target.threadShortId}`;
    case "task":
      // Fixed neutral spelling, independent of RAFT_TASK_REF_SEPARATOR: it
      // must never contain `#` / `@`, whatever the live ref syntax becomes.
      if (target.channelName !== undefined) return `task:channel:${target.channelName}/${target.taskNumber}`;
      if (target.peerName !== undefined) return `task:dm:user:${target.peerName}/${target.taskNumber}`;
      return `task:${target.taskNumber}`;
    case "message":
      return target.threadParentShortId
        ? `channel:${target.channelName}:${target.threadParentShortId} msg=${target.messageId}`
        : `channel:${target.channelName} msg=${target.messageId}`;
    case "dm-message":
      return target.threadParentShortId
        ? `dm:user:${target.peerName}:${target.threadParentShortId} msg=${target.messageId}`
        : `dm:user:${target.peerName} msg=${target.messageId}`;
  }
}

export function renderThirdPartyInertText(input: RenderThirdPartyInertTextInput): string {
  const raw = input.value ?? "";
  return neutralizeRaftRefLiterals(escapeAgentMarkupLiterals(clampText(raw)));
}

/**
 * `JSON.stringify` escapes every control character below U+0020 but leaves
 * NEL (U+0085) and the Unicode line and paragraph separators raw, and a
 * universal-newline reader breaks lines on them. They can only stand inside a
 * string there, so their `\u` escapes keep the JSON valid and equal.
 */
function stringifyPayloadJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Render an ingress-bounded JSON payload without hiding fields from the agent. */
export function renderThirdPartyInertJson(value: Record<string, unknown>): string {
  return neutralizeRaftRefLiterals(escapeAgentMarkupLiterals(stringifyPayloadJson(value)));
}

/**
 * An app event's payload as an agent reads it, on every client (the daemon's
 * runtime input, `raft message check|read`, the SDK): as written for Raft's
 * own system apps (`system_app`, which only the Server sets, from the event's
 * row), inert for every other app and whenever the marker is absent
 * (docs/development/third-party-rendering.md).
 */
export function renderThirdPartyEventPayload(event: { payload: Record<string, unknown>; system_app?: string | null }): string {
  return typeof event.system_app === "string" && event.system_app.length > 0
    ? stringifyPayloadJson(event.payload)
    : renderThirdPartyInertJson(event.payload);
}

export function renderThirdPartyInertDisclosure(fields: RenderThirdPartyInertDisclosureFieldInput[]): string {
  return fields
    .map((field) => `${field.label}: ${renderThirdPartyInertText(field)}`)
    .join("\n");
}
