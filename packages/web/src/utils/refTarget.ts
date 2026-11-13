import { formatRaftChannelTaskRef, formatRaftDmTaskRef, parseDmPeerRef } from "@botiverse/raft-shared";
// Shared reference resolve + navigate layer.
//
// This is the *only* piece shared between chat-message refs (rehype-AST
// path in MessageItem) and the Activity Diagnostics log (regex tokenizer in
// components/agent/RefText.tsx). It deliberately:
//
//   - has NO React imports
//   - is fully SYNCHRONOUS and side-effect free in `resolveRef` — callers
//     render dozens~hundreds of activity tokens, so resolve() must never
//     touch the network. Thread-parent backend resolution is deferred into
//     the returned `navigate()` closure (lazy, only when the user clicks).
//   - returns a descriptor; the *caller* triggers navigation.
//
// Seam contract locked with @Bugen 2026-05-18 #proj-uiux:2921feaf.
// A future MessageItem ref-renderer extraction collapses its onClick onto
// `resolveRef` without touching its (rehype) tokenization.

import type { Channel } from "../store/channelStore";
import type { ThreadSummary, FollowedThread, OpenThreadRequest } from "../store/threadStore";
import { captureThreadRouteAuthorityGuard, resolveThreadTargetByShortId } from "./threadRefNavigation";
import {
  createChannelTaskRefRegex,
  createChannelThreadRefRegex,
  createChannelRefRegex,
  createDmTaskRefRegex,
  createDmThreadRefRegex,
  createDmRefRegex,
} from "./messageReferencePatterns";
import type { MessageId } from "../i18n/messages";

export type RefKind = "channel" | "channel-thread" | "dm" | "dm-thread" | "task";

export interface RefParts {
  /** `#channel` / `#channel:shortid` */
  channelName?: string;
  /** `dm:@peer` / `dm:@peer:shortid` */
  dmPeer?: string;
  /** trailing `:shortid` on either form */
  threadShortId?: string;
  /** trailing `/7` on either form: a task of that channel / DM (task v2) */
  taskNumber?: number;
}

export interface RefNavContext {
  serverSlug: string;
  getAuthority: () => { serverSlug: string | null | undefined; serverEpoch: number };
  channels: Channel[];
  summaries: Record<string, ThreadSummary>;
  followedThreads: Pick<FollowedThread, "parentMessageId" | "parentChannelId">[];
  /** Injected async fn — NOT a store action. Mirrors MessageItem's
   *  handleOpenThreadRef loadContext: GET /messages/context/:shortId. */
  loadThreadContext: (
    parentChannelId: string,
    shortId: string,
  ) => Promise<{
    targetMessageId?: string | null;
    canonicalTarget?: {
      kind?: string;
      channelId?: string;
      messageId?: string;
      threadParentMessageId?: string;
      threadChannelId?: string | null;
    } | null;
  }>;
  toChannel: (channelId: string) => void;
  toDm: (dmChannelId: string) => void;
  toMessage: (channelId: string, messageId: string) => void;
  toDmMessage: (dmChannelId: string, messageId: string) => void;
  openThread: (request: OpenThreadRequest) => void | Promise<void>;
  /** Open the task dialog for a `#channel/7` / `dm:@peer/7` ref. Absent →
   *  task refs render as plain text. */
  openTask?: (channelId: string, taskNumber: number) => void | Promise<void>;
  /** Surfaced when a (legitimate) thread ref can't be resolved at click time. */
  onThreadUnavailable?: (message: MessageId) => void;
}

export interface ResolvedRef {
  kind: RefKind;
  /** Original, human-readable token text. Used verbatim for the plain-text
   *  fallback so unresolvable refs read identically to the source. */
  label: string;
  /** false → caller must render plain text, never a dead link. Only false
   *  when the channel/DM is not in the store, or it's not a ref at all.
   *  A thread ref whose parent isn't locally cached is still resolvable —
   *  navigate() awaits loadThreadContext. */
  resolvable: boolean;
  navigate: () => void | Promise<void>;
}

const THREAD_UNAVAILABLE: MessageId = "message.messageItem.threadUnavailable";

export function findChannelByName(channels: Channel[], name: string): Channel | undefined {
  const lower = name.toLowerCase();
  return channels.find(
    (c) => (c.type === "channel" || c.type === "private" || c.type === "joint") && c.name.toLowerCase() === lower,
  );
}

export function findDmByPeer(channels: Channel[], peer: string): Channel | undefined {
  // `name~agent` / `name~human` pins the peer's kind when a human and an agent
  // share a name (see dmPeerRef in shared); an unknown kind matches nothing.
  // Matching is case-SENSITIVE: the name is a handle, the server is authoritative,
  // and a relaxed match would let the same target string resolve to different
  // objects here vs. the agent path.
  const parsed = parseDmPeerRef(peer);
  if (!parsed.ok) return undefined;
  const wantType = parsed.peerKind === "human" ? "user" : parsed.peerKind;
  return channels.find(
    (c) =>
      c.type === "dm" &&
      (c.peerName === parsed.peerName || c.name === parsed.peerName) &&
      (wantType === null || c.peerType === wantType),
  );
}

/**
 * The channel a task ref names, in the reader's local channel list: by name
 * for `#channel/7`, by peer for `dm:@peer/7`. Undefined when the reader cannot
 * see that channel — the ref then reads as plain text.
 */
export function findTaskRefChannel(
  channels: Channel[],
  ref: { channelName?: string; peerName?: string },
): Channel | undefined {
  if (ref.channelName !== undefined) return findChannelByName(channels, ref.channelName);
  if (ref.peerName !== undefined) return findDmByPeer(channels, ref.peerName);
  return undefined;
}

/**
 * The reader's joint channel a task ref from another server names. Channel
 * names are per server, so `#their-name:#7` written on `authorityServerSlug`
 * is looked up by that server's name for each joint channel the reader has
 * (`jointServers[].channelName`), never by the reader's own names: a local
 * channel that happens to share the name is a different channel. Task numbers
 * are one sequence across a joint, so the number carries over as is. DMs are
 * never joint, so `dm:@peer:#7` from another server does not resolve.
 */
export function findJointTaskRefChannel(
  channels: Channel[],
  ref: { channelName?: string; peerName?: string },
  authorityServerSlug: string,
): Channel | undefined {
  if (ref.channelName === undefined) return undefined;
  const lower = ref.channelName.toLowerCase();
  return channels.find((c) => c.type === "joint" && (c.jointServers ?? []).some(
    (server) => server.status === "active"
      && server.serverSlug === authorityServerSlug
      && server.channelName?.toLowerCase() === lower,
  ));
}

/** Lookup key for a task by (local channel id, task number). Task numbers are
 *  unique only inside a channel, so a number alone must never key a task. */
export function taskRefKey(channelId: string, taskNumber: number): string {
  return `${channelId}:${taskNumber}`;
}

function buildLabel(parts: RefParts): string {
  if (parts.taskNumber !== undefined) {
    return parts.dmPeer
      ? formatRaftDmTaskRef(parts.dmPeer, parts.taskNumber)
      : formatRaftChannelTaskRef(parts.channelName ?? "", parts.taskNumber);
  }
  if (parts.dmPeer) {
    return parts.threadShortId ? `dm:@${parts.dmPeer}:${parts.threadShortId}` : `dm:@${parts.dmPeer}`;
  }
  return parts.threadShortId
    ? `#${parts.channelName}:${parts.threadShortId}`
    : `#${parts.channelName}`;
}

function makeUnresolvable(kind: RefKind, label: string): ResolvedRef {
  return { kind, label, resolvable: false, navigate: () => {} };
}

/**
 * SYNCHRONOUS, side-effect-free. Returns a descriptor; the navigate() closure
 * carries the (possibly async) navigation that the caller triggers on click.
 */
export function resolveRef(parts: RefParts, ctx: RefNavContext): ResolvedRef {
  const isThread = !!parts.threadShortId;

  // ---- Task forms: `#channel/7`, `dm:@peer/7` -----------------------------
  if (parts.taskNumber !== undefined) {
    const label = buildLabel(parts);
    const chan = findTaskRefChannel(ctx.channels, { channelName: parts.channelName, peerName: parts.dmPeer });
    const openTask = ctx.openTask;
    if (!chan || !openTask) return makeUnresolvable("task", label);
    const taskNumber = parts.taskNumber;
    return { kind: "task", label, resolvable: true, navigate: () => openTask(chan.id, taskNumber) };
  }

  // ---- DM forms -----------------------------------------------------------
  if (parts.dmPeer) {
    const kind: RefKind = isThread ? "dm-thread" : "dm";
    const label = buildLabel(parts);
    const dm = findDmByPeer(ctx.channels, parts.dmPeer);
    if (!dm) return makeUnresolvable(kind, label);

    if (!isThread) {
      return { kind, label, resolvable: true, navigate: () => ctx.toDm(dm.id) };
    }
    return {
      kind,
      label,
      resolvable: true,
      navigate: () => navigateThread(ctx, dm.id, parts.threadShortId as string, true),
    };
  }

  // ---- Channel forms ------------------------------------------------------
  if (parts.channelName) {
    const kind: RefKind = isThread ? "channel-thread" : "channel";
    const label = buildLabel(parts);
    const chan = findChannelByName(ctx.channels, parts.channelName);
    if (!chan) return makeUnresolvable(kind, label);

    if (!isThread) {
      return { kind, label, resolvable: true, navigate: () => ctx.toChannel(chan.id) };
    }
    return {
      kind,
      label,
      resolvable: true,
      navigate: () => navigateThread(ctx, chan.id, parts.threadShortId as string, false),
    };
  }

  return makeUnresolvable("channel", buildLabel(parts));
}

export async function navigateThread(
  ctx: RefNavContext,
  parentChannelId: string,
  shortId: string,
  isDm: boolean,
): Promise<void> {
  const isRequestAuthorityCurrent = captureThreadRouteAuthorityGuard(ctx.serverSlug, ctx.getAuthority);
  // Local-first (sync hit is the common case); only falls through to the
  // injected backend loader when the parent isn't cached. This is the *only*
  // place async work happens, and only because the user clicked.
  const target = await resolveThreadTargetByShortId({
    serverSlug: ctx.serverSlug,
    parentChannelId,
    shortId,
    summaries: ctx.summaries,
    followedThreads: ctx.followedThreads,
    loadContext: ctx.loadThreadContext,
  });

  if (!isRequestAuthorityCurrent()) return;
  if (!target) {
    ctx.onThreadUnavailable?.(THREAD_UNAVAILABLE);
    return;
  }

  if (isDm) {
    ctx.toDmMessage(target.parentChannelId, target.parentMessageId);
  } else {
    ctx.toMessage(target.parentChannelId, target.parentMessageId);
  }
  if (!isRequestAuthorityCurrent()) return;
  // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
  await ctx.openThread({
    serverSlug: target.serverSlug,
    parentChannelId: target.parentChannelId,
    parentMessageId: target.parentMessageId,
    threadChannelId: target.threadChannelId,
    focusedMessageId: target.focusedMessageId,
  });
}

const SINGLE_TOKEN_PATTERNS: ReadonlyArray<{ re: () => RegExp; build: (m: RegExpExecArray) => RefParts }> = [
  { re: createChannelTaskRefRegex, build: (m) => ({ channelName: m[1], taskNumber: Number(m[2]) }) },
  { re: createDmTaskRefRegex, build: (m) => ({ dmPeer: m[1], taskNumber: Number(m[2]) }) },
  { re: createChannelThreadRefRegex, build: (m) => ({ channelName: m[1], threadShortId: m[2] }) },
  { re: createDmThreadRefRegex, build: (m) => ({ dmPeer: m[1], threadShortId: m[2] }) },
  { re: createChannelRefRegex, build: (m) => ({ channelName: m[1] }) },
  { re: createDmRefRegex, build: (m) => ({ dmPeer: m[1] }) },
];

/**
 * Parse a single, already-isolated token string into RefParts. Longest forms
 * first so `#c:shortid` isn't shadowed by `#c`. Returns null if not a ref.
 */
export function parseRefToken(token: string): RefParts | null {
  for (const { re, build } of SINGLE_TOKEN_PATTERNS) {
    const rx = re();
    const m = rx.exec(token);
    if (m && m[0] === token) return build(m);
  }
  return null;
}

/**
 * High-level convenience: parse a single token then resolve. The Activity
 * tokenizer does its own streaming scan and calls resolveRef directly; this
 * is the per-token entry point (and the contract-test surface).
 */
export function resolveRefTarget(raw: string, ctx: RefNavContext): ResolvedRef | null {
  const parts = parseRefToken(raw);
  if (!parts) return null;
  return resolveRef(parts, ctx);
}
