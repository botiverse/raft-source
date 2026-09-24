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
  createChannelThreadRefRegex,
  createChannelRefRegex,
  createDmThreadRefRegex,
  createDmRefRegex,
} from "./messageReferencePatterns";
import type { MessageId } from "../i18n/messages";

export type RefKind = "channel" | "channel-thread" | "dm" | "dm-thread";

export interface RefParts {
  /** `#channel` / `#channel:shortid` */
  channelName?: string;
  /** `dm:@peer` / `dm:@peer:shortid` */
  dmPeer?: string;
  /** trailing `:shortid` on either form */
  threadShortId?: string;
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

function findChannelByName(channels: Channel[], name: string): Channel | undefined {
  const lower = name.toLowerCase();
  return channels.find(
    (c) => (c.type === "channel" || c.type === "private" || c.type === "joint") && c.name.toLowerCase() === lower,
  );
}

function findDmByPeer(channels: Channel[], peer: string): Channel | undefined {
  const lower = peer.toLowerCase();
  return channels.find(
    (c) =>
      c.type === "dm" &&
      (c.peerName?.toLowerCase() === lower || c.name.toLowerCase() === lower),
  );
}

function buildLabel(parts: RefParts): string {
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

async function navigateThread(
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
