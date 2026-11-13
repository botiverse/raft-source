import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, Braces, CircleSlash, FileClock, Info, MonitorOff, SearchX, TriangleAlert } from "lucide-react";
import {
  Banner,
  BannerAction,
  BannerDescription,
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  MessageItem,
  MessageItemAvatarSlot,
  MessageItemBody,
  MessageItemContent,
  MessageItemHeader,
  MessageItemMeta,
  MessageItemSender,
  MessageItemTime,
  PanelAction,
  PanelBody,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelMeta,
  PanelNotice,
  PanelNoticeContent,
  PanelScrollContent,
  PanelScrollViewport,
  PanelSection,
  PanelStatus,
  PanelTitle,
  Skeleton,
  Spinner,
} from "@botiverse/raft-ui";
import { AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS, getRuntimeDisplayName } from "@botiverse/raft-shared";
import type { AgentContextViewSourceKind, AgentContextViewTooLargeCause } from "@botiverse/raft-shared";

import type { MessageId } from "../../i18n/messages/en";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { keepAgentContextViewFor, useAgentContextViewStore } from "../../store/agentContextViewStore";
import type { OpenAgentContextView } from "../../store/agentContextViewStore";
import { useStoredChannel } from "../../store/useStoredChannel";
import { useLoungeTitle } from "../agent/agentLounge";
import AvatarSlot from "../ui/AvatarSlot";
import { PHONE_MEDIA_QUERY } from "../ui/NarrowDialog";
import { SideSectionPortal } from "../task/ChannelSideArea";
import ChannelSideCard from "../task/ChannelSideCard";
import { usePhoneHistoryEntry } from "../../apps/artifacts";
import type { ColumnMenuItem } from "../layout/ColumnOverflowMenu";
import { showToast } from "../toastBridge";
import { copyTextToClipboard } from "../../utils/selectMarkdown";
import { useAgentContextViewStatus } from "./agentContextViewStatus";
import { agentContextViewBodyState, askAgentContextView } from "./agentContextViewState";
import type { AgentContextViewBannerReason, AgentContextViewBodyState } from "./agentContextViewState";
import { agentContextViewKey, useAgentContextViewAnswer, useAgentContextViewVerifiedSource, useAgentContextViewViewedBy } from "./agentContextViewResult";
import { AgentContextViewContent } from "./AgentContextViewContent";
import { AgentContextViewOpenComputerAction } from "./AgentContextViewOpenComputerAction";
import { AgentContextViewVerifiedMark } from "./AgentContextViewVerifiedMark";
import { AgentContextViewViewedBy } from "./AgentContextViewViewedBy";

/** A view with no verification says how far it can be trusted, by where it was restored from. */
const UNVERIFIED_COPY: Record<AgentContextViewSourceKind, MessageId> = {
  native: "agentContextView.unverified.native",
  captured: "agentContextView.unverified.captured",
};

const BANNER_COPY: Record<AgentContextViewBannerReason, MessageId> = {
  offline: "agentContextView.offline",
  old_daemon: "agentContextView.oldDaemon",
  status_failed: "agentContextView.statusFailed",
  agent_moved: "agentContextView.agentMoved",
  not_found: "agentContextView.notFound",
  expired: "agentContextView.expired",
  too_large: "agentContextView.tooLarge",
  read_failed: "agentContextView.readFailed",
  context_mismatch: "agentContextView.contextMismatch",
  media_removed: "agentContextView.mediaRemoved",
  newer_session_format: "agentContextView.newerSessionFormat",
  not_recorded: "agentContextView.notRecorded",
};

/** Why it was too large, where the Computer said (newer Computers); otherwise BANNER_COPY's general sentence. */
const TOO_LARGE_COPY: Record<AgentContextViewTooLargeCause, MessageId> = {
  session_file: "agentContextView.tooLarge.sessionFile",
  request: "agentContextView.tooLarge.request",
  restore_limit: "agentContextView.tooLarge.restoreLimit",
};

type EmptyReason = Extract<AgentContextViewBodyState, { kind: "empty" }>["reason"];

// Keyed by reason (catalog ids, not copy): the empty state's title, sentence and icon.
const EMPTY_TITLE: Record<EmptyReason, MessageId> = {
  unsupported_runtime: "agentContextView.unsupportedRuntime.title",
  no_session: "agentContextView.noSession.title",
  no_computer: "agentContextView.noComputer.title",
};
const EMPTY_SENTENCE: Record<EmptyReason, MessageId> = {
  unsupported_runtime: "agentContextView.unsupportedRuntime",
  no_session: "agentContextView.noSession",
  no_computer: "agentContextView.noComputer",
};
const EMPTY_ICON: Record<EmptyReason, ReactNode> = {
  unsupported_runtime: <CircleSlash />,
  no_session: <FileClock />,
  no_computer: <MonitorOff />,
};

/** The message the context is for: two lines of it, under the header, in every state. */
function TheMessage({ view }: { view: OpenAgentContextView }) {
  const { formatMessage } = useIntl();
  const { formatMessageTime } = useTimeFormatter();
  // The host conversation: a channel, or an agent's Lounge (named after its agent).
  const host = useStoredChannel(view.hostChannelId);
  const hostLoungeTitle = useLoungeTitle(host?.loungeAgentId, host?.name);
  const channelName = host?.type === "channel" && !hostLoungeTitle ? host.name : undefined;
  return (
    <div className="pt-3 pb-1" data-testid="agent-context-view-message">
      <MessageItem>
        <MessageItemAvatarSlot>
          <AvatarSlot context="message-row" type="agent" agentAvatarUrl={view.agentAvatarUrl} />
        </MessageItemAvatarSlot>
        <MessageItemContent>
          <MessageItemHeader>
            <MessageItemSender>{view.agentName}</MessageItemSender>
            {hostLoungeTitle ? <MessageItemMeta>{hostLoungeTitle}</MessageItemMeta> : channelName ? <MessageItemMeta>{formatMessage({ id: "message.threadPanel.channelContext" }, { name: channelName })}</MessageItemMeta> : null}
            <MessageItemTime>{formatMessageTime(view.createdAt)}</MessageItemTime>
          </MessageItemHeader>
          <MessageItemBody>
            <span className="line-clamp-2 break-words">{view.content}</span>
          </MessageItemBody>
        </MessageItemContent>
      </MessageItem>
    </div>
  );
}

function LoadingBody() {
  return (
    <>
      <PanelSection className="grid gap-3 border-t-0 pt-3">
        {["w-24", "w-32", "w-20", "w-28", "w-24"].map((width, i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton variant="line" className="h-2.5 w-24" />
            <Skeleton variant="line" className={width} />
          </div>
        ))}
      </PanelSection>
      <PanelSection className="grid gap-4 border-t-0">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-start gap-3">
            <Skeleton variant="circle" className="size-9" />
            <div className="grid flex-1 gap-2 pt-1">
              <Skeleton variant="line" className="w-24" />
              <Skeleton variant="block" className="h-16 w-full" />
            </div>
          </div>
        ))}
      </PanelSection>
    </>
  );
}

/**
 * The phone page over the whole window: raft-ui's DialogContent with its
 * centred card undone (tailwind-merge drops the card's position, size,
 * radius, ring and padding), on the canvas, inside the safe areas.
 */
const PHONE_PAGE_CLASS = [
  "inset-0 left-0 top-0 h-dvh max-h-none w-full max-w-none translate-none",
  "flex flex-col gap-0 overflow-hidden rounded-none bg-layer-canvas p-0 shadow-none ring-0 outline-none",
  "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
].join(" ");

/** The panel's body: the notice while loading, then the message and what can (not) be shown for it. */
export function AgentContextViewBody({ view }: { view: OpenAgentContextView }) {
  const { formatMessage } = useIntl();
  const entry = useAgentContextViewStatus(view.agentId);
  const key = agentContextViewKey(view);
  const answer = useAgentContextViewAnswer(key);
  const viewedBy = useAgentContextViewViewedBy(key);
  const state = agentContextViewBodyState(entry, answer);
  const retry = useCallback(() => {
    void askAgentContextView(view, { force: true });
  }, [view]);
  const status = entry?.status ?? null;
  // A failed view names the Computer as it is now; the status's otherwise.
  const failed = answer?.kind === "failed" ? answer : null;
  const computer = failed?.computer ?? status?.computer ?? null;
  // A failure the Server sent names the Computer and its owner as they are now; one the panel
  // concluded itself (a body that did not read) names neither, so the status's owner stands.
  const owner = failed?.computer ? failed.computerOwner : status?.computerOwner ?? null;
  const values = {
    agent: view.agentName,
    computer: computer?.name ?? "",
    owner: owner?.name ?? "",
    runtime: status ? getRuntimeDisplayName(status.runtime) : "",
    days: status?.retentionDays ?? AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS,
  };
  const bannerCopy = (banner: Extract<AgentContextViewBodyState, { kind: "banner" }>): MessageId => {
    if (banner.reason === "read_failed" && !owner) return "agentContextView.readFailedNoOwner";
    if (banner.reason === "too_large" && banner.tooLargeCause) return TOO_LARGE_COPY[banner.tooLargeCause];
    return BANNER_COPY[banner.reason];
  };
  const pending = entry?.pending || answer?.kind === "loading";
  return (
    <>
      {state.kind === "loading" ? (
        <PanelNotice status="info" data-testid="agent-context-view-loading">
          <Spinner size="sm" aria-hidden="true" />
          <PanelNoticeContent>{formatMessage({ id: "common.loading" })}</PanelNoticeContent>
        </PanelNotice>
      ) : null}
      {state.kind === "content" && state.context.trigger === null ? (
        <PanelNotice status="info" data-testid="agent-context-view-no-trigger">
          <SearchX aria-hidden="true" />
          <PanelNoticeContent>{formatMessage({ id: "agentContextView.triggerNotFound" }, { agent: view.agentName })}</PanelNoticeContent>
        </PanelNotice>
      ) : null}
      {/* Not an error: rebuilt by the runtime's own code and the count matched, but not checked exactly. */}
      {state.kind === "content" && state.context.verification === "count_matched" ? (
        <PanelNotice status="info" data-testid="agent-context-view-count-matched">
          <Info aria-hidden="true" />
          <PanelNoticeContent>{formatMessage({ id: "agentContextView.countMatched" }, { runtime: getRuntimeDisplayName(state.context.runtime) })}</PanelNoticeContent>
        </PanelNotice>
      ) : null}
      {/* No proof at all (no hash, no count): still shown, but said so. A captured view whose send call
          wasn't found (trigger null) already says it above, in other words: not twice. */}
      {state.kind === "content" && state.context.verification === undefined && !(state.context.source.kind === "captured" && state.context.trigger === null) ? (
        <PanelNotice status="info" data-testid="agent-context-view-unverified">
          <Info aria-hidden="true" />
          <PanelNoticeContent>
            {formatMessage({ id: UNVERIFIED_COPY[state.context.source.kind] }, { runtime: getRuntimeDisplayName(state.context.runtime) })}
          </PanelNoticeContent>
        </PanelNotice>
      ) : null}
      <PanelBody aria-busy={state.kind === "loading" ? true : undefined}>
        <PanelScrollViewport data-agent-context-view-scroll="">
          <PanelScrollContent className="flex min-h-full flex-col">
            <TheMessage view={view} />
            {state.kind === "loading" ? <LoadingBody /> : null}
            {state.kind === "content" ? (
              <AgentContextViewContent
                context={state.context}
                computerName={status?.computer?.name ?? null}
                retainedSince={status?.retainedSince ?? null}
                agentName={view.agentName}
                agentAvatarUrl={view.agentAvatarUrl}
                sentContent={view.content}
                sentAt={view.createdAt}
              />
            ) : null}
            {state.kind === "banner" ? (
              <PanelSection className="border-t-0 pt-2">
                <Banner status="warning" data-testid={`agent-context-view-${state.reason}`}>
                  <TriangleAlert />
                  <BannerDescription>{formatMessage({ id: bannerCopy(state) }, values)}</BannerDescription>
                  {state.retry ? (
                    <BannerAction>
                      <Button variant="default" size="md" onClick={retry} loading={pending} disabled={pending} data-testid="agent-context-view-retry">
                        {formatMessage({ id: "agentContextView.retry" })}
                      </Button>
                    </BannerAction>
                  ) : null}
                  {/* A session newer than the Computer's Raft: the fix is updating Raft there, so its page. */}
                  {state.reason === "newer_session_format" ? <AgentContextViewOpenComputerAction computerId={computer?.id ?? null} /> : null}
                </Banner>
              </PanelSection>
            ) : null}
            {state.kind === "empty" ? (
              <div className="flex min-h-[420px] flex-1 items-center justify-center px-(--column-margin)" data-testid={`agent-context-view-${state.reason}`}>
                <EmptyState>
                  <EmptyStateContent>
                    <EmptyStateIcon>{EMPTY_ICON[state.reason]}</EmptyStateIcon>
                    <EmptyStateTitle render={<h3>{formatMessage({ id: EMPTY_TITLE[state.reason] })}</h3>} />
                    <EmptyStateDescription>{formatMessage({ id: EMPTY_SENTENCE[state.reason] }, values)}</EmptyStateDescription>
                  </EmptyStateContent>
                </EmptyState>
              </div>
            ) : null}
            {/* Viewed by in every state, under the reason (spec v21 §10); hidden only where it didn't load. */}
            {viewedBy && state.kind !== "loading" ? <AgentContextViewViewedBy views={viewedBy} /> : null}
          </PanelScrollContent>
        </PanelScrollViewport>
      </PanelBody>
    </>
  );
}

/**
 * Copy raw request (spec §10): the context as received (§7's JSON, unknown
 * fields and part kinds kept, indented), once there is one; the head's `{}`.
 */
function useCopyRaw(view: OpenAgentContextView): ColumnMenuItem | null {
  const { formatMessage } = useIntl();
  const answer = useAgentContextViewAnswer(agentContextViewKey(view));
  const raw = answer?.kind === "ok" ? answer.raw : null;
  return useMemo(() => {
    if (raw === null) return null;
    return {
      id: "copy-raw",
      label: formatMessage({ id: "agentContextView.copyRaw" }),
      icon: <Braces />,
      testId: "agent-context-view-copy-raw",
      onSelect: () => {
        copyTextToClipboard(raw, formatMessage).then(
          () => showToast({ title: formatMessage({ id: "agentContextView.copied" }), type: "success" }),
          () => showToast({ title: formatMessage({ id: "agentContextView.copyFailed" }), type: "error" }),
        );
      },
    };
  }, [raw, formatMessage]);
}

/** The header's meta line: the agent, then the message's time in mono. */
function useHeaderMeta(view: OpenAgentContextView): ReactNode {
  const { formatMessage } = useIntl();
  const { formatMessageTime } = useTimeFormatter();
  return formatMessage(
    { id: "agentContextView.meta" },
    { agent: view.agentName, time: <span key="time" className="font-mono">{formatMessageTime(view.createdAt)}</span> },
  );
}

/**
 * A desktop's context view: a section of the channel's row like Tasks and
 * Files (#189 row rules: full height, a seam on its left, flat, resizable,
 * movable, Expand and Close; stacked under the profile by default), placed by
 * ChannelSideArea, so the conversation stays in reach. Rendered by the channel
 * panel; closes when that panel shows another channel. A phone shows the page
 * (AgentContextViewPage) instead.
 */
export function AgentContextViewSection({ channelId }: { channelId: string }) {
  const { formatMessage } = useIntl();
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const view = useAgentContextViewStore((s) => s.open);
  const close = useAgentContextViewStore((s) => s.close);
  useEffect(() => keepAgentContextViewFor(channelId), [channelId]);
  if (phone || !view || view.hostChannelId !== channelId) return null;
  return <AgentContextViewColumn view={view} onClose={close} title={formatMessage({ id: "agentContextView.title" })} />;
}

function AgentContextViewColumn({ view, onClose, title }: { view: OpenAgentContextView; onClose: () => void; title: string }) {
  const meta = useHeaderMeta(view);
  const copyRaw = useCopyRaw(view);
  const verified = useAgentContextViewVerifiedSource(agentContextViewKey(view));
  const ownActions = useMemo(() => (copyRaw ? [copyRaw] : []), [copyRaw]);
  return (
    <SideSectionPortal section="context" title={title}>
      <ChannelSideCard
        title={title}
        lead={<AvatarSlot context="panel-header" type="agent" agentAvatarUrl={view.agentAvatarUrl} />}
        meta={meta}
        titleStatus={verified ? <AgentContextViewVerifiedMark source={verified} /> : undefined}
        ownActions={ownActions}
        closeLabelId="agentContextView.close"
        onClose={onClose}
        testId="agent-context-view-section"
      >
        <AgentContextViewBody key={`${view.agentId}:${view.messageId}`} view={view} />
      </ChannelSideCard>
    </SideSectionPortal>
  );
}

/**
 * A phone's context view: a page of its own pushed over the app, as a thread
 * or a profile is, with Back first and no Close (DS page structure). Opened
 * from the long-press menu, wherever the message is (a channel or a thread page).
 *
 * A modal page (raft-ui Dialog): focus moves to Back on open, stays inside,
 * and the app behind is inert to touch and screen readers; Escape and the
 * system or browser Back close it (it owns a history entry, as the Artifact
 * viewer does); closing returns focus to the message it was opened from.
 */
export function AgentContextViewPage() {
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const view = useAgentContextViewStore((s) => s.open);
  const close = useAgentContextViewStore((s) => s.close);
  if (!phone || !view) return null;
  return <AgentContextViewPhonePage key={agentContextViewKey(view)} view={view} onBack={close} />;
}

/** Back to the message the page was opened from (focusable for that moment if it is not already). */
function focusMessage(messageId: string) {
  const message = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!message) return;
  if (!message.hasAttribute("tabindex")) message.setAttribute("tabindex", "-1");
  message.focus({ preventScroll: true });
}

function AgentContextViewPhonePage({ view, onBack }: { view: OpenAgentContextView; onBack: () => void }) {
  const { formatMessage } = useIntl();
  const meta = useHeaderMeta(view);
  const title = formatMessage({ id: "agentContextView.title" });
  const back = formatMessage({ id: "agentContextView.back" });
  const copyRaw = useCopyRaw(view);
  const verified = useAgentContextViewVerifiedSource(agentContextViewKey(view));
  const backRef = useRef<HTMLButtonElement>(null);
  usePhoneHistoryEntry(true, onBack);
  const messageId = view.messageId;
  useEffect(() => () => focusMessage(messageId), [messageId]);
  const onOpenChange = useCallback((open: boolean) => {
    if (!open) onBack();
  }, [onBack]);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        overlay={false}
        initialFocus={backRef}
        finalFocus={false}
        aria-label={title}
        data-testid="agent-context-view-page"
        className={PHONE_PAGE_CLASS}
      >
        <PanelHeader>
          <PanelAction ref={backRef} aria-label={back} onClick={onBack} data-testid="agent-context-view-back">
            <ArrowLeft />
          </PanelAction>
          <AvatarSlot context="panel-header" type="agent" agentAvatarUrl={view.agentAvatarUrl} />
          <PanelHeaderContent>
            <PanelHeading>
              <PanelTitle render={<h2>{title}</h2>} />
              {verified ? <PanelStatus><AgentContextViewVerifiedMark source={verified} /></PanelStatus> : null}
            </PanelHeading>
            <PanelMeta>{meta}</PanelMeta>
          </PanelHeaderContent>
          {copyRaw ? (
            <PanelAction aria-label={copyRaw.label} onClick={copyRaw.onSelect} data-testid={copyRaw.testId}>
              {copyRaw.icon}
            </PanelAction>
          ) : null}
        </PanelHeader>
        <AgentContextViewBody view={view} />
      </DialogContent>
    </Dialog>
  );
}
