import type { RefObject } from "react";
import { useIntl } from "react-intl";
import { X } from "lucide-react";
import { PanelAction } from "@botiverse/raft-ui";
import Tooltip from "../../components/ui/Tooltip";
import PanelHeader from "../../components/ui/PanelHeader";
import type { Server } from "../../store/serverStore";
import { ThreadRepliesLoadFailed, ThreadRepliesLoading } from "../../components/message/ThreadRepliesLoading";
import { ComposerBox } from "../../boot/bootSkeletons";
import { THREAD_CHROME_CONTAINER_PROPS, THREAD_MOBILE_BACK_PROPS } from "./threadPanelChrome";

/**
 * The panel while its thread channel is being found (first open): the
 * reply skeleton under the head, or the failure with Retry.
 */
export function ThreadPanelResolvingShell({
  panelClassName,
  showHeader,
  mobileBackHandler,
  handleClose,
  closeButtonClassName,
  resolveRegionRef,
  resolveFailed,
  handleRetryOpenThreadFocused,
  openThreadError,
  currentServer,
  repliesLoadingSince,
}: {
  panelClassName: string;
  showHeader: boolean;
  mobileBackHandler: () => void;
  handleClose: () => void;
  closeButtonClassName: string;
  resolveRegionRef: RefObject<HTMLDivElement | null>;
  resolveFailed: boolean;
  handleRetryOpenThreadFocused: () => void;
  openThreadError: { unavailable?: boolean } | null;
  currentServer: Server | null;
  repliesLoadingSince: number;
}) {
  const { formatMessage } = useIntl();
  return (
    <div className={panelClassName}>
      {/* Stryker disable all: header ownership is browser-smoke verified. */}
      {showHeader && <PanelHeader
        title={formatMessage({ id: "message.threadPanel.thread" })}
        onMobileBack={mobileBackHandler}
        mobileBackProps={THREAD_MOBILE_BACK_PROPS}
        containerProps={THREAD_CHROME_CONTAINER_PROPS}
        mobileBreakpoint="lg"
        actions={
          <Tooltip content={formatMessage({ id: "message.threadPanel.closeThread" })}>
          <PanelAction
            onClick={handleClose}
            className={closeButtonClassName}
            aria-label={formatMessage({ id: "common.close" })}
            data-testid="thread-close"
          >
            <X />
          </PanelAction>
          </Tooltip>
        }
      />}
      {/* Stryker restore all */}
      {/* The region that stays while the thread is found: busy from the
          start (DS Feedback), and where Retry leaves focus. */}
      <div ref={resolveRegionRef} tabIndex={-1} aria-busy={!resolveFailed || undefined} className="relative flex-1 outline-none">
        {resolveFailed ? (
          <ThreadRepliesLoadFailed
            onRetry={handleRetryOpenThreadFocused}
            retryTestId="thread-retry"
            unavailableFrom={openThreadError?.unavailable ? currentServer?.name ?? null : null}
          />
        ) : (
          <ThreadRepliesLoading key={repliesLoadingSince} since={repliesLoadingSince} />
        )}
      </div>
      {/* The composer's box stays where the boot skeleton drew it while the
          thread is found, so the bottom of a phone's thread doesn't empty
          and refill (DS Feedback: one placeholder, never swapped). */}
      {!resolveFailed && <ComposerBox />}
    </div>
  );
}
