import type { SyncScopeKey } from "@botiverse/raft-sync-core";

declare const entityRefBrand: unique symbol;
declare const discussionRefBrand: unique symbol;
declare const readPageBrand: unique symbol;
declare const syncScopeWindowBrand: unique symbol;

export interface MessageRef {
  kind: "message";
  serverId: string;
  id: string;
  [entityRefBrand]: "message";
}

export interface CommentRef {
  kind: "comment";
  serverId: string;
  id: string;
  [entityRefBrand]: "comment";
}

export type InteractionTarget = MessageRef | CommentRef;

export interface ReactionActorsRelation {
  kind: "reaction-actors";
  emoji: string;
}

export interface RepliesRelation {
  kind: "replies";
}

export interface MessageReactionActorsDiscussion {
  root: MessageRef;
  relation: ReactionActorsRelation;
  parentScopeKey: SyncScopeKey;
  backing: "read-cache";
  [discussionRefBrand]: "message-reaction-actors";
}

export interface MessageRepliesDiscussion {
  root: MessageRef;
  relation: RepliesRelation;
  parentScopeKey: SyncScopeKey;
  backing: "sync-scope";
  [discussionRefBrand]: "message-replies";
}

export type DiscussionRef =
  | MessageReactionActorsDiscussion
  | MessageRepliesDiscussion;

export interface ReadPage {
  kind: "read-page";
  pageCursor: string | null;
  discussionVersion: string | null;
  principalScope: string;
  [readPageBrand]: true;
}

export interface SyncScopeWindow {
  kind: "sync-scope-window";
  scopeCursor: string | null;
  epoch: string | null;
  [syncScopeWindowBrand]: true;
}

export const DISCUSSION_RELATION_REGISTRY = Object.freeze({
  messageReactionActors: Object.freeze({
    rootKind: "message",
    relation: "reaction-actors",
    backing: "read-cache",
    consistency: "read-page",
    provenance: Object.freeze({ count: "shared-parent-fold", previewK: "shared-parent-fold" }),
    invalidation: "parent-scope-epoch",
    allowedCommands: Object.freeze(["set-interaction"] as const),
  }),
  messageReplies: Object.freeze({
    rootKind: "message",
    relation: "replies",
    backing: "sync-scope",
    consistency: "sync-scope-window",
    provenance: Object.freeze({ replyCount: "shared-parent-fold" }),
    invalidation: "own-scope-rebaseline",
    allowedCommands: Object.freeze(["reply"] as const),
  }),
});

export const MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER = "message-service.thread-replies-window.v1";

export function messageRef(serverId: string, id: string): MessageRef {
  return { kind: "message", serverId, id } as MessageRef;
}

export function commentRef(serverId: string, id: string): CommentRef {
  return { kind: "comment", serverId, id } as CommentRef;
}

export function messageReactionActorsDiscussion(
  root: MessageRef,
  emoji: string,
  parentScopeKey: SyncScopeKey,
): MessageReactionActorsDiscussion {
  return {
    root,
    relation: { kind: "reaction-actors", emoji },
    parentScopeKey: { ...parentScopeKey },
    backing: "read-cache",
  } as MessageReactionActorsDiscussion;
}

export function messageRepliesDiscussion(
  root: MessageRef,
  parentScopeKey: SyncScopeKey,
): MessageRepliesDiscussion {
  return {
    root,
    relation: { kind: "replies" },
    parentScopeKey: { ...parentScopeKey },
    backing: "sync-scope",
  } as MessageRepliesDiscussion;
}

export function readPage(input: {
  pageCursor?: string | null;
  discussionVersion?: string | null;
  principalScope: string;
}): ReadPage {
  return {
    kind: "read-page",
    pageCursor: input.pageCursor ?? null,
    discussionVersion: input.discussionVersion ?? null,
    principalScope: input.principalScope,
  } as ReadPage;
}

export function syncScopeWindow(input: {
  scopeCursor?: string | null;
  epoch?: string | null;
} = {}): SyncScopeWindow {
  return {
    kind: "sync-scope-window",
    scopeCursor: input.scopeCursor ?? null,
    epoch: input.epoch ?? null,
  } as SyncScopeWindow;
}

export type DiscussionReadDescription =
  | { discussion: MessageReactionActorsDiscussion; window: ReadPage }
  | { discussion: MessageRepliesDiscussion; window: SyncScopeWindow };

export function listChildren(
  discussion: MessageReactionActorsDiscussion,
  window: ReadPage,
): DiscussionReadDescription;
export function listChildren(
  discussion: MessageRepliesDiscussion,
  window: SyncScopeWindow,
): DiscussionReadDescription;
export function listChildren(
  discussion: DiscussionRef,
  window: ReadPage | SyncScopeWindow,
): DiscussionReadDescription {
  return { discussion, window } as DiscussionReadDescription;
}

export interface ReplyCommandDescription {
  kind: "reply";
  discussion: MessageRepliesDiscussion;
  content: string;
}

export function sendReply(
  discussion: MessageRepliesDiscussion,
  content: string,
): ReplyCommandDescription {
  return { kind: "reply", discussion, content };
}

export interface SetInteractionCommandDescription {
  kind: "set-interaction";
  target: InteractionTarget;
  interaction: "reaction";
  value: { emoji: string; active: boolean };
}

export function setInteraction(
  target: InteractionTarget,
  interaction: "reaction",
  value: { emoji: string; active: boolean },
): SetInteractionCommandDescription {
  return { kind: "set-interaction", target, interaction, value };
}

export function syncScopeKeyString(key: SyncScopeKey): string {
  return JSON.stringify([key.serverId, key.scopeKind, key.scopeId]);
}

export function reactionActorsDiscussionKey(
  discussion: MessageReactionActorsDiscussion,
): string {
  return JSON.stringify([
    discussion.root.serverId,
    discussion.parentScopeKey.scopeKind,
    discussion.parentScopeKey.scopeId,
    discussion.root.id,
    discussion.relation.kind,
    discussion.relation.emoji,
  ]);
}
