import { useId } from "react";
import type { RefObject } from "react";
import { useIntl } from "react-intl";
import { Button, TextLink, ThreadPanelFooter } from "@botiverse/raft-ui";
import { JoinChannelIcon } from "@botiverse/ricons";
import { OpenInAppRowSlot } from "../../components/deeplinks/OpenInAppRowSlot";
import { composerHostClassName } from "../../components/message/composerHost";
import { AssistantOtterAnchor } from "../../assistant/AssistantOtter";
import type { Agent } from "../../store/agentStore";
import type { Channel } from "../../store/channelStore";
import type { Message } from "../../store/messageStore";
import type { Server } from "../../store/serverStore";
import { MessageInput } from "../composer/MessageInput";
import ReadOnlyComposer from "../../components/message/ReadOnlyComposer";
import RemovedAppBotDmNotice from "../../components/message/RemovedAppBotDmNotice";
import Banner from "../../components/ui/Banner";
import SelectModeToolbar from "../../components/message/SelectModeToolbar";
import type { SelectionShareHandlers } from "../../components/message/useSelectionShareHandlers";
import type { ForwardAvailability } from "../../components/message/forwardSelectionUtils";
import { PaywallShown } from "../../analytics/paywall";
import { THREAD_CHROME_LAYER_CLASS_NAME } from "./threadPanelChrome";
import { ExternalFrozenBanner } from "../channel/ChannelLimitBanners";

/**
 * The panel's footer: the reply composer, or in its place the select-mode
 * toolbar, a guest's or a joint channel's read-only banner, a removed App
 * Bot's notice, or the Join button.
 */
export function ThreadPanelComposer({
  toastFloorRef,
  overlayComposer,
  mobilePage,
  threadChromeLayerClassName,
  isGuest,
  parentJoined,
  parentChannelId,
  parentChannel,
  parentLoungeReadOnly,
  threadSelectScopedHere,
  selectModeChannelId,
  panelRef,
  picCapturing,
  cancelPicCapture,
  picCaptureProgress,
  copiedMd,
  forwardState,
  openForwardComposer,
  copySelectedLinks,
  onSavePic,
  onCopyMd,
  selectableIds,
  selectableComplete,
  parentJointFeatureLocked,
  parentExternalFrozen,
  openJointUpgrade,
  currentServer,
  parentDmAppBotRemoved,
  parentDmAgent,
  threadChannelId,
  conversationKey,
  hideParentMessage,
  handleWillSend,
  taskV2,
  ensureSurfaceThreadChannel,
  handleThreadChannelResolved,
  composerAutoFocus,
  messages,
  parentMessageId,
  parentMessage,
  handleJoinParentChannel,
  joiningParentChannel,
}: {
  toastFloorRef: (element: Element | null) => (() => void) | undefined;
  overlayComposer: boolean;
  mobilePage: boolean;
  threadChromeLayerClassName: string;
  isGuest: boolean;
  parentJoined: boolean | undefined;
  parentChannelId: string | null;
  /** The parent conversation's stored row, from any slice (useThreadParentChannel). */
  parentChannel: Channel | null;
  /** The parent is a Lounge this person may only read (`canPost: false`). */
  parentLoungeReadOnly: boolean;
  threadSelectScopedHere: boolean;
  selectModeChannelId: string;
  panelRef: RefObject<HTMLDivElement | null>;
  picCapturing: SelectionShareHandlers["picCapturing"];
  cancelPicCapture: SelectionShareHandlers["cancelPicCapture"];
  picCaptureProgress: SelectionShareHandlers["picCaptureProgress"];
  copiedMd: SelectionShareHandlers["copiedMd"];
  forwardState: ForwardAvailability;
  openForwardComposer: () => void;
  copySelectedLinks: () => void;
  onSavePic: SelectionShareHandlers["onSavePic"];
  onCopyMd: SelectionShareHandlers["onCopyMd"];
  selectableIds: readonly string[];
  /** False while some of the thread's messages are not loaded (SelectModeToolbar). */
  selectableComplete: boolean;
  parentJointFeatureLocked: boolean;
  /** The lock is the free plan's external channel freeze (its own message, no joint paywall). */
  parentExternalFrozen: boolean;
  openJointUpgrade: () => void;
  currentServer: Server | null;
  parentDmAppBotRemoved: boolean;
  parentDmAgent: Agent | undefined;
  threadChannelId: string | null;
  conversationKey: string;
  hideParentMessage: boolean;
  handleWillSend: () => Promise<void>;
  taskV2: boolean;
  ensureSurfaceThreadChannel: () => Promise<string>;
  handleThreadChannelResolved: (resolvedThreadChannelId: string) => void;
  composerAutoFocus: boolean;
  messages: Message[];
  parentMessageId: string | null;
  parentMessage: Message | null;
  handleJoinParentChannel: () => void;
  joiningParentChannel: boolean;
}) {
  const { formatMessage } = useIntl();
  // The assistant's otter on this composer's frame (AssistantOtter), at 80%:
  // a thread's reply under a message; a task's own conversation has none.
  const otterHostId = useId();
  // Stryker disable all: parent reply/join chrome is existing ThreadPanel
  // behavior; forward tests exercise the toolbar branch separately.
  // A Guest replies in its own channel's threads like a member (matrix §1). It
  // never joins a channel itself, so it gets no Join.
  const canReplyInParentThread = parentJoined === true;
  const showJoinParentChannel = parentJoined === false && !isGuest;
  const threadMentionChannelId = parentChannelId || undefined;
  const isChannelThreadInput = (() => {
    if (!parentChannelId) return false;
    return parentChannel?.type !== "dm";
  })();
  // Stryker restore all
  // Stryker disable all: composer ownership and chrome are browser-smoke verified.
  const composerContainerClassName = `${composerHostClassName(overlayComposer && !mobilePage)} ${THREAD_CHROME_LAYER_CLASS_NAME}`;
  const composerTestId = mobilePage ? "thread-window-composer" : undefined;
  // Stryker restore all

  return (
    <ThreadPanelFooter
      ref={toastFloorRef}
      className={composerContainerClassName}
      data-testid={composerTestId}
    >
    <OpenInAppRowSlot />
    <div className={`${threadChromeLayerClassName} min-w-0 w-full flex-1`}>
      {threadSelectScopedHere ? (
        <SelectModeToolbar
          channelId={selectModeChannelId}
          focusScopeRef={panelRef}
          capturing={picCapturing}
          onCancelCapture={cancelPicCapture}
          captureProgressLabel={picCaptureProgress && picCaptureProgress.pageCount > 1
            ? formatMessage({ id: "message.selectModeToolbar.renderingPage" }, { page: picCaptureProgress.pageNumber, count: picCaptureProgress.pageCount })
            : null}
          copied={copiedMd}
          onForward={forwardState !== "hidden" ? openForwardComposer : undefined}
          forwardPending={forwardState === "pending"}
          onCopyLinks={copySelectedLinks}
          onSavePic={onSavePic}
          onCopyMd={onCopyMd}
          selectableIds={selectableIds}
          selectableComplete={selectableComplete}
        />
      ) : parentJointFeatureLocked && parentExternalFrozen ? (
        <ExternalFrozenBanner plan={currentServer?.plan} onUpgrade={openJointUpgrade} />
      ) : parentJointFeatureLocked ? (
        <div className="bg-layer-canvas p-3">
          <Banner intent="warning" className="justify-center text-center font-bold">
            {formatMessage({ id: "message.chatPanel.jointLocked" })}{" "}
            <PaywallShown gate="joint_channel_read_only" />
            <TextLink
              onClick={openJointUpgrade}
              variant="strong"
            >
              {formatMessage({ id: currentServer?.plan === "free" ? "billing.upgradeToPro" : "message.chatPanel.viewBilling" })}
            </TextLink>
          </Banner>
        </div>
      ) : parentDmAppBotRemoved && parentDmAgent ? (
        <ReadOnlyComposer notice={<RemovedAppBotDmNotice handle={parentDmAgent.name} />} />
      ) : parentLoungeReadOnly ? (
        <ReadOnlyComposer />
      ) : canReplyInParentThread ? (
        /* Thread message input — use parent channel members for @mention autocomplete */
        <MessageInput
          channelId={threadChannelId ?? `pending-thread:${conversationKey}`}
          placeholder={formatMessage({ id: hideParentMessage ? "message.threadPanel.taskComposerPlaceholder" : "message.threadPanel.composerPlaceholder" })}
          channelName={formatMessage({ id: "message.composer.threadChannelName" })}
          onWillSend={handleWillSend}
          asTaskShortcutDisabled={taskV2}
          resolveChannelId={threadChannelId ? undefined : ensureSurfaceThreadChannel}
          onChannelResolved={threadChannelId ? undefined : handleThreadChannelResolved}
          migrateDraftFromChannelId={threadChannelId ? `pending-thread:${conversationKey}` : undefined}
          mentionChannelId={threadMentionChannelId}
          isChannelThread={isChannelThreadInput}
          threadMessages={messages}
          autoFocus={composerAutoFocus}
          frameEdge={parentMessageId && parentChannelId
            ? (
              <AssistantOtterAnchor
                hostId={otterHostId}
                channelId={parentChannelId}
                threadParentMessageId={parentMessageId}
                threadParentText={parentMessage && parentMessage.id === parentMessageId ? parentMessage.content : null}
                scale={0.8}
              />
            )
            : undefined}
        />
      ) : showJoinParentChannel ? (
        <div className="flex flex-col items-center gap-2 bg-layer-canvas p-3">
          <Button size="lg" variant="accent" onClick={handleJoinParentChannel} className="w-full" loading={joiningParentChannel} disabled={joiningParentChannel}>
            <JoinChannelIcon width={14} height={14} />
            {formatMessage({ id: "message.threadPanel.joinChannelToReply" })}
          </Button>
        </div>
      ) : null}
    </div>
    </ThreadPanelFooter>
  );
}
