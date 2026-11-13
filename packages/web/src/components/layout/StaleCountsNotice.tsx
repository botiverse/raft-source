import { PanelNotice, PanelNoticeContent, Spinner } from "@botiverse/raft-ui";
import { TriangleAlert } from "lucide-react";
import { useIntl } from "react-intl";
import type { MessageId } from "../../i18n/messages";
import { useRwOutOfDate, useRwUnconfigured } from "../../store/rwFreshness";
import type { RwSurface } from "../../store/rwFreshness";

/**
 * Task #164 (stdrc, O2): also show the unread-counts notice under the desktop
 * sidebar head while the person is in Chat. Pending stdrc's confirmation: if
 * the answer is no, set this to false; nothing else changes.
 */
export const SHOW_STALE_COUNTS_NOTICE_IN_DESKTOP_SIDEBAR = true;

/** What the Home / sidebar notice is about: the unread counts, followed threads and other servers' dots. */
export const UNREAD_COUNT_SURFACES: readonly RwSurface[] = ["unread", "followed", "summary"];
/** What the Activity notice is about. */
export const ACTIVITY_SURFACES: readonly RwSurface[] = ["inbox"];

type StaleCountsNoticeProps = {
  surfaces: readonly RwSurface[];
  messageId: MessageId;
  /** Said instead while one of the reads failed with 503 `rw_unconfigured`. */
  unavailableMessageId: MessageId;
  "data-testid"?: string;
};

/**
 * One notice under a panel head while the counts it shows may be out of date
 * (store/rwFreshness.ts): the last known values stay, unchanged, and this says
 * so once. Waiting is not a problem, so it is an `info` PanelNotice led by a
 * Spinner, not a warning (raft-ui Banner, "While something is still pending");
 * `role="status"` reads it politely. It goes away silently when a clean answer
 * arrives.
 *
 * RisingWave not configured (503 `rw_unconfigured`, Tenny 2026-10-30) will not
 * catch up on its own: the same notice says the reads are temporarily
 * unavailable, as a `warning` led by TriangleAlert instead of the Spinner.
 */
export function StaleCountsNotice({ surfaces, messageId, unavailableMessageId, "data-testid": testId }: StaleCountsNoticeProps) {
  const { formatMessage } = useIntl();
  const outOfDate = useRwOutOfDate(surfaces);
  const unconfigured = useRwUnconfigured(surfaces);
  if (!outOfDate) return null;
  if (unconfigured) {
    return (
      <PanelNotice status="warning" role="status" data-testid={testId} data-reason="rw_unconfigured">
        <TriangleAlert aria-hidden="true" />
        <PanelNoticeContent>{formatMessage({ id: unavailableMessageId })}</PanelNoticeContent>
      </PanelNotice>
    );
  }
  return (
    <PanelNotice status="info" role="status" data-testid={testId}>
      <Spinner aria-hidden="true" />
      <PanelNoticeContent>{formatMessage({ id: messageId })}</PanelNoticeContent>
    </PanelNotice>
  );
}
