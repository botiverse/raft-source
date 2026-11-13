
import {
  createRaftBareTaskRefRegex,
  createRaftChannelRefRegex,
  createRaftChannelTaskRefRegex,
  createRaftChannelThreadRefRegex,
  createRaftDmRefRegex,
  createRaftDmTaskRefRegex,
  createRaftDmThreadRefRegex,
  createRaftMalformedDmKindRefRegex,
  createRaftMessageRefRegex,
  createRaftStructuredUserRefRegex,
  createRaftUserRefRegex,
  formatRaftRefTarget,
  parseRaftRefTarget,
  resolveRaftMentionHandle,
} from "@botiverse/raft-shared";
import type { RaftRefTarget } from "@botiverse/raft-shared";
import type { Channel } from "../../store/channelStore";
import type { Agent } from "../../store/agentStore";

import type { Task } from "../../store/taskStore";
import {
  highlightSearchHitInTree,
  highlightThreadSearchInTree,
} from "./threadSearch";
import {
  messageTokenNode,
  plainTextOf,
  replaceLinksInTree,
  replaceTokensInTree,
} from "./remarkMessageTokens";
import type { TextTokenMatcher } from "./remarkMessageTokens";
import { repairGeneratedMarkdown, unwrapDmKindStrikethrough } from "./repairGeneratedMarkdown";
import type { Root as MdastRoot } from "mdast";
import type { VFile } from "vfile";
import { findDmByPeer, taskRefKey } from "../../utils/refTarget";
import { messageMarkdownSlotMatcher, writeMessageMarkdownSlotsAsText } from "./messageMarkdownSlots";
import type { MessageMarkdownSlots } from "./messageMarkdownSlots";

/** A name a message body may mention, and who it is. */
export interface MentionEntry {
  displayName: string;
  /** `external` = linked provider member — never linkable, renders as text. */
  type: "agent" | "user" | "external";
  id: string;
  agent?: Agent;
}

const mentionIdentityMapCache = new WeakMap<Map<string, MentionEntry>, Map<string, MentionEntry>>();

function buildMentionIdentityMap(mentionMap: Map<string, MentionEntry>): Map<string, MentionEntry> {
  const cached = mentionIdentityMapCache.get(mentionMap);
  if (cached) return cached;
  const map = new Map<string, MentionEntry>();
  for (const entry of mentionMap.values()) {
    map.set(`${entry.type}:${entry.id}`, entry);
  }
  mentionIdentityMapCache.set(mentionMap, map);
  return map;
}

// `<computer:…>` / `<app:…>` belonged to the dropped composer resource refs
// (composer_resource_references_v0). Such text, well-formed or not, reads as
// exactly what was typed: never a link, chip or mention.
export function isRetiredResourceRef(target: string): boolean {
  return /^\s*(?:computer|app):/i.test(target);
}

/** `#` is markup, not translatable copy. */
export function taskNumberSigil(taskNumber: number): string {
  return `#${taskNumber}`;
}

/** What the message refs plugin reads (MessageMarkdownBody's inputs). */
export interface MessageRefsPluginOptions {
  channels: Channel[];
  mentionMap: Map<string, MentionEntry>;
  structuredMentionMap: Map<string, MentionEntry>;
  taskContextChannelId?: string;
  taskByChannelNumber?: ReadonlyMap<string, Task>;
  resolveTaskRefChannelId: (ref: { channelName?: string; peerName?: string }) => string | null;
  localTaskRefLabel: (target: RaftRefTarget & { kind: "task" }) => string;
  threadRefAuthorityUnavailable: boolean;
  refAuthorityServerSlug?: string;
  currentServerSlug?: string;
  threadSearchHighlightQuery?: string;
  markedSearchHitQuery?: string;
  /** Structured inline parts the caller draws (messageMarkdownSlots). */
  slots?: MessageMarkdownSlots;
}

/**
 * Task #762: every ref below is recognised on the parsed markdown tree
 * (remarkMessageTokens), so code, links and escapes are skipped by the
 * parser itself. Matchers run in this order; each sees only the text the
 * earlier ones left alone, which is the precedence the old placeholders
 * enforced (thread refs before mentions, `dm:@peer` before `@peer`).
 * A caller's slots come first: their placeholders are never part of a ref.
 */
export function createMessageRefsPlugin({
  channels, mentionMap, structuredMentionMap, taskContextChannelId, taskByChannelNumber,
  resolveTaskRefChannelId, localTaskRefLabel, threadRefAuthorityUnavailable,
  refAuthorityServerSlug, currentServerSlug, threadSearchHighlightQuery, markedSearchHitQuery, slots,
}: MessageRefsPluginOptions) {
  const channelNameSet = new Set(channels.map((c) => c.name.toLowerCase()));
  const crossServerAuthority = !!refAuthorityServerSlug
    && !!currentServerSlug
    && refAuthorityServerSlug !== currentServerSlug;
  let mentionIdentityMap: Map<string, MentionEntry> | null = null;
  const resolveMentionByIdentity = (type: "agent" | "user" | "external", id: string) => {
    mentionIdentityMap ??= buildMentionIdentityMap(mentionMap);
    return mentionIdentityMap.get(`${type}:${id}`);
  };
  const plain = (text: string) => messageTokenNode("span", text);
  const raftRefAnchor = (target: RaftRefTarget, label: string) =>
    messageTokenNode("a", label, {
      dataRaftRefKind: target.kind,
      dataRaftRefTarget: formatRaftRefTarget(target),
    });
  const mentionAnchor = (name: string, entry: MentionEntry) => {
    const resolvedMention = resolveMentionByIdentity(entry.type, entry.id);
    const visibleLabel = resolvedMention?.displayName ? `@${resolvedMention.displayName}` : `@${name}`;
    return messageTokenNode("a", visibleLabel, {
      dataMention: name,
      dataMentionType: entry.type,
      dataMentionId: entry.id,
    });
  };

  const matchers: TextTokenMatcher[] = [
    ...(slots ? [messageMarkdownSlotMatcher(slots)] : []),
    // `<target>` refs. `\<target>` is the escape: it stays literal text and
    // no later matcher may claim part of it.
    {
      pattern: /<([^<>\n]+)>/g,
      replace: (match, { escaped, inQuote }) => {
        if (isRetiredResourceRef(match[1])) return plain(match[0]);
        const target = parseRaftRefTarget(match[1]);
        if (!target) return false;
        if (escaped || (inQuote && target.kind === "user")) return plain(match[0]);
        return raftRefAnchor(target, formatRaftRefTarget(target));
      },
    },
    {
      pattern: createRaftMessageRefRegex(),
      replace: (match) => {
        const [, channelName, threadParentShortId, messageId] = match;
        const target = parseRaftRefTarget(
          threadParentShortId
            ? `#${channelName}:${threadParentShortId} msg=${messageId}`
            : `#${channelName} msg=${messageId}`,
        );
        return target ? raftRefAnchor(target, formatRaftRefTarget(target)) : false;
      },
    },
    // Thread refs MUST run before the mention matchers: `dm:@peer(:shortId)?`
    // contains `@peer`, and letting mentions claim it first breaks the ref
    // into `dm:` + mention chip (+ `:shortId`) — the production regression
    // where `dm:@artin:1f1def75` stopped being clickable.
    {
      pattern: createRaftChannelThreadRefRegex(),
      replace: (match) => {
        const [text, chanName, shortId] = match;
        if (threadRefAuthorityUnavailable) return plain(text);
        if (!channelNameSet.has(chanName.toLowerCase()) && !crossServerAuthority) return false;
        const chan = channels.find((c) => c.name.toLowerCase() === chanName.toLowerCase() && (c.type === "channel" || c.type === "private" || c.type === "joint"));
        return messageTokenNode("a", `#${chanName}:${shortId}`, {
          dataThreadRef: shortId,
          dataThreadParent: crossServerAuthority ? "" : chan?.id || "",
          dataThreadParentName: chanName,
        });
      },
    },
    {
      pattern: createRaftDmThreadRefRegex(),
      replace: (match) => {
        const [text, peerName, shortId] = match;
        if (threadRefAuthorityUnavailable) return plain(text);
        const dm = findDmByPeer(channels, peerName);
        // Unresolvable refs must read identically to the source — claim the
        // whole token as plain text instead of letting the mention matcher
        // chip `@peer` out of it.
        if (!dm && !crossServerAuthority) return plain(text);
        return messageTokenNode("a", `dm:@${peerName}:${shortId}`, {
          dataThreadRef: shortId,
          dataThreadParent: crossServerAuthority ? "" : dm?.id || "",
          dataThreadParentName: crossServerAuthority ? peerName : dm?.name || peerName,
          dataThreadParentType: "dm",
        });
      },
    },
    // Task refs qualified by their conversation (`#proj:#7`, `dm:@peer:#7`)
    // run before `dm:@peer`, mentions, bare `#N` and `#channel`, which
    // would otherwise split them (`#proj` link + `/7`). A channel the
    // reader cannot see claims the token as plain text.
    {
      pattern: createRaftChannelTaskRefRegex(),
      replace: (match) => {
        const [text, channelName, taskNumber] = match;
        const target = { kind: "task" as const, channelName, taskNumber: Number(taskNumber) };
        if (!resolveTaskRefChannelId(target)) return plain(text);
        return raftRefAnchor(target, localTaskRefLabel(target));
      },
    },
    {
      pattern: createRaftDmTaskRefRegex(),
      replace: (match) => {
        const [text, peerName, taskNumber] = match;
        const target: RaftRefTarget = { kind: "task", peerName, taskNumber: Number(taskNumber) };
        if (!resolveTaskRefChannelId(target)) return plain(text);
        return raftRefAnchor(target, text);
      },
    },
    // Bare `dm:@peer` refs: claim the whole token (same preemption rule) and
    // render through the raft-ref anchor path, which navigates to the DM.
    {
      pattern: createRaftDmRefRegex(),
      replace: (match) => {
        const [text, peerName] = match;
        if (!findDmByPeer(channels, peerName)) return plain(text);
        return raftRefAnchor({ kind: "dm", peerName }, text);
      },
    },
    // `dm:@name~bot` (unknown peer kind) is not a ref: keep it plain text so
    // neither `dm:@name` nor the mention matcher turns it into another target.
    { pattern: createRaftMalformedDmKindRefRegex(), replace: (match) => plain(match[0]) },
    // A selected mention is an identity-backed entity, not a fresh username
    // guess. Keep it mentionable after left-boundary edits such as
    // `草案@Mona` and before CJK suffixes such as `@Mona的`; a Latin right
    // boundary still prevents a stale `@Mona` entity from claiming `@Monica`.
    ...[...structuredMentionMap].flatMap(([name, entry]): TextTokenMatcher[] => {
      const pattern = createRaftStructuredUserRefRegex(name);
      return pattern ? [{ pattern, replace: (_match, { inQuote }) => !inQuote && mentionAnchor(name, entry) }] : [];
    }),
    // Free text still uses the conservative grammar so emails/package-like
    // strings never become notifications merely because a directory name
    // happens to match.
    {
      pattern: createRaftUserRefRegex(),
      replace: (match, { inQuote }) => {
        // A quoted `@name` is someone else's words, not a mention.
        if (inQuote) return false;
        const [, prefix, token] = match;
        const resolved = resolveRaftMentionHandle(
          token,
          (name) => structuredMentionMap.has(name) || mentionMap.has(name),
        );
        if (!resolved) return false; // Not a known name — keep as plain text
        const entry = structuredMentionMap.get(resolved.handle) ?? mentionMap.get(resolved.handle);
        if (!entry) return false;
        return [
          { type: "text", value: prefix },
          mentionAnchor(resolved.handle, entry),
          { type: "text", value: resolved.suffix },
        ];
      },
    },
    // "task #205" always links; bare "#205" only if it's a known task of
    // the conversation being read (the channel the click resolves in).
    {
      pattern: createRaftBareTaskRefRegex(),
      replace: (match) => {
        const [, prefix, taskKeyword, taskNumber] = match;
        // A text read in no conversation (an Artifact comment) has no task a bare number names.
        if (!taskContextChannelId) return false;
        if (
          !taskKeyword
          && !(taskContextChannelId && taskByChannelNumber?.has(taskRefKey(taskContextChannelId, Number(taskNumber))))
        ) return false;
        return [
          { type: "text", value: `${prefix}${taskKeyword ?? ""}` },
          messageTokenNode("a", `#${taskNumber}`, { dataTaskRef: taskNumber }),
        ];
      },
    },
    // #channel refs: only a known channel becomes a link.
    {
      pattern: createRaftChannelRefRegex(),
      replace: (match) => {
        const [, name] = match;
        if (!channelNameSet.has(name.toLowerCase())) return false;
        return messageTokenNode("a", `#${name}`, { dataChannel: name });
      },
    },
  ];

  return () => (tree: MdastRoot, file: VFile) => {
    repairGeneratedMarkdown(tree, file);
    unwrapDmKindStrikethrough(tree, file);
    if (slots) writeMessageMarkdownSlotsAsText(tree, slots);
    replaceLinksInTree(tree, (link, { inQuote }) => {
      // `[label](<target>)` and `<dm:@peer>`: the parser made these links,
      // and only the angle-bracket forms are refs (`[x](#general)` is not).
      const source = file.value ? String(file.value).slice(link.position?.start.offset ?? 0, link.position?.end.offset ?? 0) : "";
      const isLabelled = /\]\(<[^<>\n]+>\)$/.test(source);
      const isAutolink = source === `<${link.url}>`;
      if (!isLabelled && !isAutolink) return null;
      if (isRetiredResourceRef(link.url)) return plain(source);
      const target = parseRaftRefTarget(link.url);
      if (!target) return null;
      if (inQuote && target.kind === "user") return plain(source);
      return raftRefAnchor(target, isLabelled ? plainTextOf(link) : formatRaftRefTarget(target));
    });
    replaceTokensInTree(tree, matchers, file);
    highlightThreadSearchInTree(tree, threadSearchHighlightQuery ?? "");
    if (markedSearchHitQuery) highlightSearchHitInTree(tree, markedSearchHitQuery);
  };
}
