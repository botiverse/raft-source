// The message renderer (moved out of MessageItem for #proj-workspace:#265): a
// message body's Markdown, mentions, Raft refs and links, under the message
// security rules (messageMarkdownSecurity). MessageItem draws a message with it;
// MessageMarkdownText draws a text that isn't a message (an Artifact comment).
import { MessageAppLink, markdownLinkText } from "./AppLinkChip";
import { appLinkBlockHosts } from "./appLinkBlockHosts";
import { memo, useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import {
  Badge,
  MessageReferenceChip,
  MessageReferenceText,
  Spinner,
} from "@botiverse/raft-ui";
import type { Components } from "react-markdown";

import {
  formatRaftRefTarget,
  parseRaftPermalink,
  parseRaftRefTarget,
} from "@botiverse/raft-shared";
import type {
  ExternalMessageAuthorProjection,
  RaftRefTarget,
} from "@botiverse/raft-shared";
import type { Channel } from "../../store/channelStore";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import type { ServerMember } from "../../store/serverStore";
import type { ChannelExternalMember } from "../../hooks/useChannelMembers";
import { findStoredChannel } from "../../store/storedChannel";
import { loungeAgentDisplayName } from "../agent/agentLounge";

import type { Task } from "../../store/taskStore";
import { useRaftPermalinkHostnames } from "../../store/raftAppHosts";
import {
  matchesUnavailableQuotedPermalink,
} from "./quotedMessagePermalink";
import MentionLink from "./MentionLink";
import { MessageWebLink } from "./MessageWebLink";
import { PermalinkReferenceChip } from "./PermalinkReferenceChip";
import { STATIC_MENTION_CLASS, STATIC_REFERENCE_CLASS, WRAPPED_CHIP_PRESS_CLASS } from "./clickableAffordance";
import MarkdownContent, {MarkdownCode, MarkdownLink} from "../markdown/MarkdownContent";
import { isCustomProtocolHref } from "../markdown/CustomProtocolLink";
import { MessageReadReceiptScopeProvider } from "./messageReadReceiptScope";
import type { MessageReadReceiptScope } from "./messageReadReceiptScope";
import { highlightInlineCode } from "./highlightInlineCode";
import { MessageTextMark } from "./MessageTextMark";
import type { TimeFormatOptions } from "../../utils/timeFormatting";
import type { ThreadRefIntent } from "../../utils/threadRefNavigation";
import { MESSAGE_MARKDOWN_REHYPE_PLUGINS, messageMarkdownRemarkPlugins } from "./messageMarkdownSecurity";
import {
  normalizeThreadSearchQuery,
  splitThreadSearchHighlight,
} from "./threadSearch";
import { splitSearchHighlight } from "../../features/search/searchHighlightParts";
import { findDmByPeer, findJointTaskRefChannel, findTaskRefChannel, taskRefKey } from "../../utils/refTarget";
import { createMessageRefsPlugin } from "./messageMarkdownRefs";
import type { MentionEntry } from "./messageMarkdownRefs";
import type { MessageMarkdownSlots } from "./messageMarkdownSlots";
import { ResolvingTaskRef, TaskRefBadge } from "./MessageTaskRefChips";

// A text hit in a message: thread search's (`thread-search-fragment-highlight`)
// or, without one, the search this message was opened from (task #83,
// `message-search-hit-mark`). The test ids name which search marked it.
const THREAD_SEARCH_MARK_TEST_ID = "thread-search-fragment-highlight";
const SEARCH_HIT_MARK_TEST_ID = "message-search-hit-mark";

function getRaftRefProp(node: any, prop: string): string | undefined {
  const value = node?.properties?.[prop] ?? node?.properties?.[`data-${prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`];
  return typeof value === "string" ? value : undefined;
}

/** A mention on a read-only projection: the member highlight, no link. */
function renderDisplayOnlyMention(children: ReactNode) {
  return (
    <MessageReferenceText variant="secondary" className={STATIC_MENTION_CLASS} render={<span data-message-mention="display-only" />}>
      {children}
    </MessageReferenceText>
  );
}

/** Render message content as Markdown with @mention and #channel highlighting.
    Hook-named: it memoizes the markdown components map and handlers (task #709),
    and is called exactly once, unconditionally, inside MessageMarkdownBody. */
function useRenderMessageMarkdown(
  content: string,
  channels: Channel[],
  mentionMap: Map<string, MentionEntry>,
  structuredMentionMap: Map<string, MentionEntry>,
  onNavigateChannel: (channel: Channel) => void,
  onNavigateDm: (channel: Channel) => void,
  onNavigateAgent: (agentId: string) => void,
  onNavigateHuman: (userId: string) => void,
  onNavigateExternal: ((profile: ExternalMessageAuthorProjection) => void) | undefined,
  onOpenThread?: (intent: ThreadRefIntent) => void | Promise<void>,
  resolvingThreadRefKey?: string | null,
  onOpenTaskRef?: (taskNumber: number, channelId?: string) => void,
  onOpenMessageRef?: (channel: Channel, messageId: string, threadParentShortId: string | null) => void | Promise<void>,
  onOpenPermalink?: (href: string) => void,
  currentServerSlug?: string,
  refAuthorityServerSlug?: string,
  threadRefAuthorityUnavailable = false,
  taskContextChannelId?: string,
  taskByChannelNumber?: ReadonlyMap<string, Task>,
  timeFormatOptions: TimeFormatOptions = {},
  threadSearchHighlightQuery?: string,
  formatMessage?: IntlShape["formatMessage"],
  channelParticipantAgentsById?: ReadonlyMap<string, Agent>,
  channelParticipantMembersById?: ReadonlyMap<string, ServerMember>,
  channelParticipantExternalsById?: ReadonlyMap<string, ChannelExternalMember>,
  unavailableQuotedPermalinkUrl?: string | null,
  mentionsDisplayOnly = false,
  searchHitQuery?: string,
  slots?: MessageMarkdownSlots,
) {
  // An open thread search owns the marks; the opened search hit's marks show
  // only without one.
  const markedSearchHitQuery = normalizeThreadSearchQuery(threadSearchHighlightQuery ?? "")
    ? undefined
    : searchHitQuery || undefined;
  const markTestId = markedSearchHitQuery ? SEARCH_HIT_MARK_TEST_ID : THREAD_SEARCH_MARK_TEST_ID;
  // The hosts a Raft message permalink is recognised on: the page's own and
  // the server's app hosts (a new list when they arrive, so the links on
  // screen are read again).
  const permalinkHostnames = useRaftPermalinkHostnames();
  const agents = useAgentStore((s) => s.agents); // a Lounge permalink chip's name
  // Inline task refs render rui's inline `TaskChip` when the referenced task is
  // loaded in the client store. The chip is designed for running text —
  // borderless and body-sized — so a mixed line (#mention-mix) keeps its
  // baseline; it reads the same `task-status-*` tokens as every other surface,
  // so the status colour still matches (task-status unification).
  // Unknown tasks keep a neutral badge so the chip never claims a status it
  // does not know.
  //
  // The inline badge shows the status icon + `#N` and deliberately NOT the
  // assignee: the badge sits inside the sender's sentence, and an `@name`
  // there reads as a mention the author never wrote (task #1252 — "等 #211
  // @peng 做完", where @peng came from the badge). The footer badge is not
  // inside a sentence and keeps the assignee; the task detail shows it too.
  //
  // No Tooltip wrapper here on purpose: the footer badge's tooltip mounts a
  // base-ui trigger with an auto-generated id, and the evidence contract in
  // tests/taskRefChannelScope.evidence.test.tsx (removed in the 2026-11 web DOM test prune) requires the rendered ref
  // markup to be byte-identical across renders of the same number.
  //
  // Tasks are looked up by (channel, number): a number is unique only inside
  // its channel, so a badge never shows another channel's task. A
  // channel-qualified ref (`#proj:#7`) keeps its full label on the chip.
  const renderTaskBadge = useCallback((channelId: string, taskNumber: number, label?: string) => {
    const task = taskByChannelNumber?.get(taskRefKey(channelId, taskNumber));
    if (!task) return null;
    return <TaskRefBadge task={task} label={label} channelId={channelId} onOpenTaskRef={onOpenTaskRef} />;
  }, [taskByChannelNumber, onOpenTaskRef]);
  // The local channel a task ref resolves in, or null when the reader cannot
  // resolve it (the ref then reads as plain text). Legacy `task #7` / `#7`
  // means the conversation being read. `#proj:#7` / `dm:@peer:#7` resolve by
  // the reader's local channel names. With another server's ref authority (a
  // joint channel's remote author) a local name may name a different channel,
  // so the name is looked up as the authoring server's name for one of the
  // reader's joint channels (its jointServers), which maps it to the reader's
  // own projection of that joint; otherwise it stays plain text.
  const resolveQualifiedTaskRefChannel = useCallback((ref: { channelName?: string; peerName?: string }): Channel | null => {
    if (threadRefAuthorityUnavailable) return null;
    const crossServerAuthority = !!refAuthorityServerSlug
      && !!currentServerSlug
      && refAuthorityServerSlug !== currentServerSlug;
    if (crossServerAuthority) return findJointTaskRefChannel(channels, ref, refAuthorityServerSlug) ?? null;
    return findTaskRefChannel(channels, ref) ?? null;
  }, [channels, currentServerSlug, refAuthorityServerSlug, threadRefAuthorityUnavailable]);
  const resolveTaskRefChannelId = useCallback((ref: { channelName?: string; peerName?: string }): string | null => {
    if (ref.channelName === undefined && ref.peerName === undefined) return taskContextChannelId ?? null;
    return resolveQualifiedTaskRefChannel(ref)?.id ?? null;
  }, [resolveQualifiedTaskRefChannel, taskContextChannelId]);
  // A ref shows the reader's name for its channel: a joint channel can be
  // named differently on the author's server. Names match case-insensitively,
  // so a ref differing only in case keeps the text as written.
  const localTaskRefLabel = useCallback((target: RaftRefTarget & { kind: "task" }): string => {
    const channel = target.channelName !== undefined ? resolveQualifiedTaskRefChannel(target) : null;
    return channel?.name && channel.name.toLowerCase() !== target.channelName?.toLowerCase()
      ? formatRaftRefTarget({ ...target, channelName: channel.name })
      : formatRaftRefTarget(target);
  }, [resolveQualifiedTaskRefChannel]);
  // Task #762: the refs are recognised on the parsed markdown tree (createMessageRefsPlugin).
  const messageRefsPlugin = useMemo(() => createMessageRefsPlugin({
    channels, mentionMap, structuredMentionMap, taskContextChannelId, taskByChannelNumber,
    resolveTaskRefChannelId, localTaskRefLabel, threadRefAuthorityUnavailable,
    refAuthorityServerSlug, currentServerSlug, threadSearchHighlightQuery, markedSearchHitQuery, slots,
  }), [
    channels, mentionMap, structuredMentionMap, taskContextChannelId, taskByChannelNumber,
    resolveTaskRefChannelId, localTaskRefLabel, threadRefAuthorityUnavailable,
    refAuthorityServerSlug, currentServerSlug, threadSearchHighlightQuery, markedSearchHitQuery, slots,
  ]);
  const remarkPlugins = useMemo(
    () => messageMarkdownRemarkPlugins(messageRefsPlugin),
    [messageRefsPlugin],
  );

  // Chat body shares its visual styling (code blocks, lists, headings, table,
  // etc.) with attachment preview via BASE_MARKDOWN_COMPONENTS in
  // MarkdownContent. We override only the elements that need chat-specific
  // behavior — `a` (mentions / channel refs / task refs / thread refs /
  // raft permalinks) and `span` (reminder receipts).
  // stdrc 2026-05-08 #proj-uiux:6110c1ce (task #137).
  const markdownComponents = useMemo(() => ({
    code: ({ children, className }) => (
      <MarkdownCode className={className}>
        {className
          ? children
          : markedSearchHitQuery
            ? highlightInlineCode(children, (text) => splitSearchHighlight(text, markedSearchHitQuery), markTestId)
            : highlightInlineCode(children, (text) => splitThreadSearchHighlight(text, threadSearchHighlightQuery ?? ""), markTestId)}
      </MarkdownCode>
    ),
    // Links — handle @mention, #channel, and regular URLs
    a: ({ href, children, node }) => {
          const raftRefTarget = getRaftRefProp(node, "dataRaftRefTarget");
          if (raftRefTarget) {
            const target = parseRaftRefTarget(raftRefTarget);
            if (!target) return <span>{children}</span>;

            if (target.kind === "user") {
              const entry = structuredMentionMap.get(target.name) ?? mentionMap.get(target.name);
              if (!entry) return <span>{children}</span>;
              if (mentionsDisplayOnly) return renderDisplayOnlyMention(children);
              return (
                <MentionLink
                  mentionType={entry.type}
                  mentionId={entry.id}
                  fallbackLabel={target.name}
                  fallbackAgent={entry.type === "agent" ? channelParticipantAgentsById?.get(entry.id) : undefined}
                  fallbackMember={entry.type === "user" ? channelParticipantMembersById?.get(entry.id) : undefined}
                  fallbackExternal={entry.type === "external" ? channelParticipantExternalsById?.get(entry.id) : undefined}
                  onNavigateAgent={onNavigateAgent}
                  onNavigateHuman={onNavigateHuman}
                  onNavigateExternal={onNavigateExternal}
                >
                  {children}
                </MentionLink>
              );
            }

            if (target.kind === "channel" || target.kind === "channel-thread" || target.kind === "message") {
              const crossServerAuthority = !!refAuthorityServerSlug
                && !!currentServerSlug
                && refAuthorityServerSlug !== currentServerSlug;
              const channel = channels.find(
                (entry) =>
                  entry.name.toLowerCase() === target.channelName.toLowerCase() &&
                  (entry.type === "channel" || entry.type === "private" || entry.type === "joint"),
              );
              const crossServerThreadTarget = crossServerAuthority
                && (target.kind === "channel-thread" || (target.kind === "message" && !!target.threadParentShortId));
              if (!channel && !crossServerThreadTarget) return <span>{children}</span>;

              if (target.kind === "channel") {
                if (!channel) return <span>{children}</span>;
                return (
                  <MessageReferenceChip
                    variant="accent"
                    render={
                      <a href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          onNavigateChannel(channel);
                        }}>
                        {children}
                      </a>
                    }
                  />
                );
              }

              if (target.kind === "channel-thread") {
                if (threadRefAuthorityUnavailable) return <span>{children}</span>;
                if (!onOpenThread) return <span>{children}</span>;
                const routeServerSlug = refAuthorityServerSlug ?? currentServerSlug;
                if (!routeServerSlug) return <span>{children}</span>;
                const parentChannelId = crossServerAuthority ? null : channel?.id ?? null;
                const threadRefKey = `${routeServerSlug}:${target.channelName.toLowerCase()}:${target.threadShortId.toLowerCase()}`;
                const isResolvingThreadRef = resolvingThreadRefKey === threadRefKey;
                return (
                  <MessageReferenceChip
                    variant="link"
                    className={isResolvingThreadRef ? "cursor-wait opacity-80" : undefined}
                    render={
                      <a href="#"
                        aria-busy={isResolvingThreadRef}
                        onClick={(e) => {
                          e.preventDefault();
                          if (isResolvingThreadRef) return;
                          void onOpenThread({
                            serverSlug: routeServerSlug,
                            parentChannelName: target.channelName,
                            parentChannelId,
                            shortId: target.threadShortId,
                          });
                        }}>
                        <span>{children}</span>
                        {isResolvingThreadRef ? (
                          <Spinner size="xs" className="align-[-1px]" aria-label={formatMessage?.({ id: "common.loadingLabel" })} />
                        ) : null}
                      </a>
                    }
                  />
                );
              }

              if (target.threadParentShortId && onOpenThread) {
                if (threadRefAuthorityUnavailable) return <span>{children}</span>;
                const routeServerSlug = refAuthorityServerSlug ?? currentServerSlug;
                if (!routeServerSlug) return <span>{children}</span>;
                return (
                  <MessageReferenceChip
                    variant="link"
                    render={
                      <a href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          void onOpenThread({
                            serverSlug: routeServerSlug,
                            parentChannelName: target.channelName,
                            parentChannelId: crossServerAuthority ? null : channel?.id ?? null,
                            shortId: target.threadParentShortId!,
                            focusedMessageId: target.messageId,
                          });
                        }}>
                        {children}
                      </a>
                    }
                  />
                );
              }

              if (!onOpenMessageRef) return <span>{children}</span>;
              if (!channel) return <span>{children}</span>;
              return (
                <MessageReferenceChip
                  variant="link"
                  render={
                    <a href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        void onOpenMessageRef?.(channel, target.messageId, target.threadParentShortId);
                      }}>
                      {children}
                    </a>
                  }
                />
              );
            }

            if (target.kind === "dm" || target.kind === "dm-thread") {
              const crossServerAuthority = !!refAuthorityServerSlug
                && !!currentServerSlug
                && refAuthorityServerSlug !== currentServerSlug;
              const dm = findDmByPeer(channels, target.peerName);
              if (!dm && !(crossServerAuthority && target.kind === "dm-thread")) return <span>{children}</span>;
              if (target.kind === "dm") {
                if (!dm) return <span>{children}</span>;
                return (
                  <MessageReferenceChip
                    variant="accent"
                    render={
                      <a href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          onNavigateDm(dm);
                        }}>
                        {children}
                      </a>
                    }
                  />
                );
              }
              if (!onOpenThread) return <span>{children}</span>;
              if (threadRefAuthorityUnavailable) return <span>{children}</span>;
              const routeServerSlug = refAuthorityServerSlug ?? currentServerSlug;
              if (!routeServerSlug) return <span>{children}</span>;
              return (
                <MessageReferenceChip
                  variant="link"
                  render={
                    <a href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        void onOpenThread({
                          serverSlug: routeServerSlug,
                          parentChannelName: crossServerAuthority ? target.peerName : dm!.name,
                          parentChannelType: "dm",
                          parentChannelId: crossServerAuthority ? null : dm!.id,
                          shortId: target.threadShortId,
                        });
                      }}>
                      {children}
                    </a>
                  }
                />
              );
            }

            if (target.kind === "task" && onOpenTaskRef) {
              const taskChannelId = resolveTaskRefChannelId(target);
              if (!taskChannelId) return <span>{children}</span>;
              const qualified = target.channelName !== undefined || target.peerName !== undefined;
              const taskBadge = renderTaskBadge(
                taskChannelId,
                target.taskNumber,
                qualified ? localTaskRefLabel(target) : undefined,
              );
              if (taskBadge) return taskBadge;
              return (
                <ResolvingTaskRef
                  channelId={taskChannelId}
                  taskNumber={target.taskNumber}
                  label={qualified ? localTaskRefLabel(target) : undefined}
                  onOpenTaskRef={onOpenTaskRef}>
                  {children}
                </ResolvingTaskRef>
              );
            }

            return <span>{children}</span>;
          }

          // @mention → clickable, navigates to agent or human detail
          const mentionName = node?.properties?.dataMention as string | undefined;
          if (mentionName) {
            const mentionType = node?.properties?.dataMentionType as string | undefined;
            const mentionId = node?.properties?.dataMentionId as string | undefined;

            if (mentionsDisplayOnly) return renderDisplayOnlyMention(children);
            if (!mentionId || (mentionType !== "agent" && mentionType !== "user" && mentionType !== "external")) {
              return (
                <span className="font-bold text-foreground select-text">
                  {children}
                </span>
              );
            }

            return (
              <MentionLink
                mentionType={mentionType}
                mentionId={mentionId}
                fallbackLabel={mentionName}
                fallbackAgent={mentionType === "agent" ? channelParticipantAgentsById?.get(mentionId) : undefined}
                fallbackMember={mentionType === "user" ? channelParticipantMembersById?.get(mentionId) : undefined}
                fallbackExternal={mentionType === "external" ? channelParticipantExternalsById?.get(mentionId) : undefined}
                onNavigateAgent={onNavigateAgent}
                onNavigateHuman={onNavigateHuman}
                onNavigateExternal={onNavigateExternal}
              >
                {children}
              </MentionLink>
            );
          }
          // Thread reference → clickable, opens thread panel
          const threadRef = node?.properties?.dataThreadRef as string | undefined;
          if (threadRef && onOpenThread) {
            if (threadRefAuthorityUnavailable) return <span>{children}</span>;
            const parentId = node?.properties?.dataThreadParent as string | undefined;
            const parentName = node?.properties?.dataThreadParentName as string | undefined;
            const parentType = node?.properties?.dataThreadParentType === "dm" ? "dm" : "channel";
            const routeServerSlug = refAuthorityServerSlug ?? currentServerSlug;
            const crossServerAuthority = !!refAuthorityServerSlug
              && !!currentServerSlug
              && refAuthorityServerSlug !== currentServerSlug;
            if (!routeServerSlug || !parentName || (!parentId && !crossServerAuthority)) {
              return (
                <MessageReferenceChip
                  variant="link"
                  className={STATIC_REFERENCE_CLASS}
                  render={
                    <span />}>
                  {children}
                </MessageReferenceChip>
              );
            }
            const threadRefKey = `${routeServerSlug}:${parentName.toLowerCase()}:${threadRef.toLowerCase()}`;
            const isResolvingThreadRef = resolvingThreadRefKey === threadRefKey;
            return (
              <MessageReferenceChip
                variant="link"
                className={isResolvingThreadRef ? "cursor-wait opacity-80" : undefined}
                render={
                  <a href="#"
                    aria-busy={isResolvingThreadRef}
                    onClick={(e) => {
                      e.preventDefault();
                      if (isResolvingThreadRef) return;
                      void onOpenThread({
                        serverSlug: routeServerSlug,
                        parentChannelName: parentName,
                        parentChannelType: parentType,
                        parentChannelId: crossServerAuthority ? null : parentId,
                        shortId: threadRef,
                      });
                    }}>
                    <span>{children}</span>
                    {isResolvingThreadRef ? (
                      <Spinner size="xs" className="align-[-1px]" aria-label={formatMessage?.({ id: "common.loadingLabel" })} />
                    ) : null}
                  </a>
                }
              />
            );
          }
          // #channel → clickable, navigates to channel
          const channelName = node?.properties?.dataChannel as string | undefined;
          if (channelName) {
            const channel = channels.find(
              (c) => c.name.toLowerCase() === channelName.toLowerCase() && (c.type === "channel" || c.type === "private" || c.type === "joint")
            );
            if (!channel) {
              return (
                <MessageReferenceChip
                  variant="accent"
                  className={STATIC_REFERENCE_CLASS}
                  render={
                    <span />}>
                  {children}
                </MessageReferenceChip>
              );
            }
            return (
              <MessageReferenceChip
                variant="accent"
                render={
                  <a href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigateChannel(channel);
                    }}>
                    {children}
                  </a>
                }
              />
            );
          }
          // #205 → clickable, resolves a task in the current channel context.
          // Task refs reuse the message-side task badge (task #662); a task the
          // page has not loaded is fetched for its status (ResolvingTaskRef).
          const taskRef = node?.properties?.dataTaskRef as string | undefined;
          if (taskRef && onOpenTaskRef) {
            const taskNumber = Number(taskRef);
            if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
              return (
                <span>
                  <Badge variant="muted">{children}</Badge>
                </span>
              );
            }
            const taskBadge = taskContextChannelId ? renderTaskBadge(taskContextChannelId, taskNumber) : null;
            if (taskBadge) return taskBadge;
            if (taskContextChannelId) {
              return (
                <ResolvingTaskRef
                  channelId={taskContextChannelId}
                  taskNumber={taskNumber}
                  onOpenTaskRef={onOpenTaskRef}>
                  {children}
                </ResolvingTaskRef>
              );
            }
            return (
              <a
                href="#"
                className={WRAPPED_CHIP_PRESS_CLASS}
                data-message-affordance="open-linked-task"
                onClick={(e) => {
                  e.preventDefault();
                  onOpenTaskRef(taskNumber, taskContextChannelId);
                }}>
                <Badge variant="muted">{children}</Badge>
              </a>
            );
          }
          const raftPermalink = href ? parseRaftPermalink(href, permalinkHostnames) : null;
          if (href && raftPermalink) {
            const quotedMessageUnavailable = matchesUnavailableQuotedPermalink(
              href,
              unavailableQuotedPermalinkUrl,
              permalinkHostnames,
            );
            const channel = findStoredChannel({ channels, dmChannels: [] }, raftPermalink.channelId);
            const channelLabel = quotedMessageUnavailable
              ? (formatMessage
                ? formatMessage({ id: "message.messageItem.unavailableLinkedMessage" })
                : "Unavailable linked message")
              : channel?.loungeAgentId && formatMessage
              ? formatMessage({ id: "agent.lounge.title" }, { name: loungeAgentDisplayName(agents.find((agent) => agent.id === channel.loungeAgentId), channel.name) })
              : channel
              ? channel.type === "dm"
                ? `@${channel.peerDisplayName || channel.peerName || channel.name}`
                : `#${channel.name}`
              : (formatMessage
                ? formatMessage({ id: "message.messageItem.linkedMessageFallback" })
                : "linked message");
            return (
              <PermalinkReferenceChip
                href={href}
                authorText={markdownLinkText(node)}
                quotedMessageUnavailable={quotedMessageUnavailable}
                channelLabel={channelLabel}
                onOpenPermalink={onOpenPermalink}
              />
            );
          }
          // Custom-protocol links (obsidian:// and friends, per the sanitize
          // href allowlist) delegate to the canonical MarkdownLink, which
          // confirms before handing off to the OS (task #734).
          if (isCustomProtocolHref(href)) {
            return <MarkdownLink href={href}>{children}</MarkdownLink>;
          }
          // A bare URL an App previews becomes its chip (protocol v3.2.3
          // addendum 5); any other link stays as the author wrote it.
          return (
            <MessageAppLink href={href} text={markdownLinkText(node)}>
              <MessageWebLink href={href}>{children}</MessageWebLink>
            </MessageAppLink>
          );
        },
        mark: ({ children }) => <MessageTextMark testId={markTestId}>{children}</MessageTextMark>,
        // A caller's structured part (messageMarkdownSlots), drawn as the caller draws it.
        ...(slots ? {
          span: ({ node, children, ...props }) => {
            const slot = getRaftRefProp(node, "dataMessageSlot");
            return slot === undefined ? <span {...props}>{children}</span> : <>{slots.render(Number(slot))}</>;
          },
        } : null),
      } as Components), [
      threadSearchHighlightQuery, markedSearchHitQuery, markTestId, structuredMentionMap, mentionMap,
      channelParticipantAgentsById, channelParticipantMembersById, channelParticipantExternalsById,
      onNavigateAgent, onNavigateHuman, onNavigateExternal, onNavigateChannel,
      onNavigateDm, onOpenThread, onOpenMessageRef, onOpenTaskRef, onOpenPermalink,
      formatMessage, channels, agents, refAuthorityServerSlug, currentServerSlug,
      threadRefAuthorityUnavailable, resolvingThreadRefKey, renderTaskBadge, resolveTaskRefChannelId, localTaskRefLabel,
      taskContextChannelId,
      unavailableQuotedPermalinkUrl, mentionsDisplayOnly, permalinkHostnames, slots,
    ]);
  // Paragraphs and list items, then their links' block cards: per text, the rest of the map stays text-independent.
  const withBlockHosts = useMemo(() => ({ ...markdownComponents, ...appLinkBlockHosts(content) }), [markdownComponents, content]);
  return (
    <MarkdownContent
      source={content}
      density="compact"
      enableMermaid
      remarkPlugins={remarkPlugins}
      rehypePlugins={MESSAGE_MARKDOWN_REHYPE_PLUGINS}
      components={withBlockHosts}
    />
  );
}

export interface MessageMarkdownBodyProps {
  content: string;
  channels: Channel[];
  mentionMap: Map<string, MentionEntry>;
  structuredMentionMap: Map<string, MentionEntry>;
  onNavigateChannel: (channel: Channel) => void;
  onNavigateDm: (channel: Channel) => void;
  onNavigateAgent: (agentId: string) => void;
  onNavigateHuman: (userId: string) => void;
  /** Click handler for `type:"external"` mentions — opens the
   *  external-identity panel via `openExternalProfile`. */
  onNavigateExternal: (profile: ExternalMessageAuthorProjection) => void;
  onOpenThread?: (intent: ThreadRefIntent) => void | Promise<void>;
  resolvingThreadRefKey?: string | null;
  /** Open task `taskNumber` of local channel `channelId` (legacy refs: the
   *  conversation being read). */
  onOpenTask?: (taskNumber: number, channelId?: string) => void;
  onOpenMessage?: (channel: Channel, messageId: string, threadParentShortId: string | null) => void | Promise<void>;
  onOpenPermalink?: (href: string) => void;
  serverSlug?: string;
  refAuthorityServerSlug?: string;
  threadRefAuthorityUnavailable?: boolean;
  /** The channel a legacy `task #7` / `#7` ref resolves in: the conversation
   *  being read (a thread's parent channel). */
  taskContextChannelId?: string;
  /** Task payloads for inline task refs, keyed by `taskRefKey(channelId,
   *  taskNumber)` (task #662: refs reuse the message-side task badge).
   *  Referentially stable via useMemo in the parent; an unstable map would
   *  defeat the memo above. */
  taskByChannelNumber?: ReadonlyMap<string, Task>;
  timeFormatOptions: TimeFormatOptions;
  threadSearchHighlightQuery?: string;
  /** The query of the search this message was opened from (task #83). */
  searchHitQuery?: string;
  /** #693 per-@mentioned-agent read badge. Primitives only, so the memo above
   *  still short-circuits — an object prop would defeat it. */
  readReceiptChannelId: string;
  readReceiptMessageSeq: number | undefined;
  readReceiptEnabled: boolean;
  channelParticipantAgentsById?: ReadonlyMap<string, Agent>;
  channelParticipantMembersById?: ReadonlyMap<string, ServerMember>;
  channelParticipantExternalsById?: ReadonlyMap<string, ChannelExternalMember>;
  unavailableQuotedPermalinkUrl?: string | null;
  /** Read-only projection: mentions are highlighted text, never profile links
   *  or hover cards (those read member stores and load profiles). */
  mentionsDisplayOnly?: boolean;
  /** Structured inline parts in `content` the caller draws itself (messageMarkdownSlots: an
   *  Artifact comment's mentions). Referentially stable, as the handlers are. */
  slots?: MessageMarkdownSlots;
}

// Memoized markdown body. `renderContent` runs the full markdown preprocessing
// + react-markdown parse, which the 2026-06-06 prod CPU trace showed to be ~33%
// of main-thread JS in the message list. Wrapping it in a memo'd component lets
// it skip that work whenever the parent MessageItem re-renders WITHOUT a change
// to the actual markdown inputs — provided callers pass referentially-stable
// props (the navigate/open handlers are now useCallback'd and useAppNavigate is
// memoized). #wg-frontend-perf.
export const MessageMarkdownBody = memo(function MessageMarkdownBody(props: MessageMarkdownBodyProps) {
  const { formatMessage } = useIntl();
  const readReceiptScope = useMemo<MessageReadReceiptScope>(() => ({
    channelId: props.readReceiptChannelId,
    messageSeq: props.readReceiptMessageSeq,
    enabled: props.readReceiptEnabled,
  }), [props.readReceiptChannelId, props.readReceiptMessageSeq, props.readReceiptEnabled]);
  const body = useRenderMessageMarkdown(
    props.content,
    props.channels,
    props.mentionMap,
    props.structuredMentionMap,
    props.onNavigateChannel,
    props.onNavigateDm,
    props.onNavigateAgent,
    props.onNavigateHuman,
    props.onNavigateExternal,
    props.onOpenThread,
    props.resolvingThreadRefKey,
    props.onOpenTask,
    props.onOpenMessage,
    props.onOpenPermalink,
    props.serverSlug,
    props.refAuthorityServerSlug,
    props.threadRefAuthorityUnavailable,
    props.taskContextChannelId,
    props.taskByChannelNumber,
    props.timeFormatOptions,
    props.threadSearchHighlightQuery,
    formatMessage,
    props.channelParticipantAgentsById,
    props.channelParticipantMembersById,
    props.channelParticipantExternalsById,
    props.unavailableQuotedPermalinkUrl,
    props.mentionsDisplayOnly,
    props.searchHitQuery,
    props.slots,
  );
  return (
    <MessageReadReceiptScopeProvider value={readReceiptScope}>
      {body}
    </MessageReadReceiptScopeProvider>
  );
});
