/**
 * Shared inert renderer for app-controlled third-party text.
 *
 * Contract:
 * - Input is app-controlled free text such as app name, developer display name,
 *   description, and declared data-access wording.
 * - Output is canonical agent-facing text. It is safe to place in marketplace,
 *   install disclosure, app metadata, and tool-result readouts.
 * - Structured values such as normalized domains, callback URLs, categories, and
 *   closed scope enums do not belong here; those should be rendered from
 *   server-normalized values at the call site.
 */

import { extractRaftRefTargets, type RaftRefTarget } from "./raftRefs.js";

export type ThirdPartyInertTextField =
  | "app_name"
  | "developer_name"
  | "publisher_name"
  | "description"
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

export function neutralizeRaftRefLiterals(value: string): string {
  const refs = extractRaftRefTargets(value, { dedupe: false, includeMarkdownCode: true })
    .filter((ref) => ref.start < ref.end)
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

/** Render an ingress-bounded JSON payload without hiding fields from the agent. */
export function renderThirdPartyInertJson(value: Record<string, unknown>): string {
  return neutralizeRaftRefLiterals(escapeAgentMarkupLiterals(JSON.stringify(value, null, 2)));
}

export function renderThirdPartyInertDisclosure(fields: RenderThirdPartyInertDisclosureFieldInput[]): string {
  return fields
    .map((field) => `${field.label}: ${renderThirdPartyInertText(field)}`)
    .join("\n");
}
