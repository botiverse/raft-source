import { PanelNotice, PanelNoticeContent } from "@botiverse/raft-ui";
import { TriangleAlert } from "lucide-react";
import { useIntl } from "react-intl";
import type { MessageId } from "../../i18n/messages";
import { useRwUnconfigured } from "../../store/rwFreshness";
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
  /** Said while one of the reads failed with 503 `rw_unconfigured`. */
  unavailableMessageId: MessageId;
  "data-testid"?: string;
};

/**
 * One notice under a panel head while the counts it shows cannot be read
 * (store/rwFreshness.ts): RisingWave not configured (503 `rw_unconfigured`,
 * Tenny 2026-10-30) will not catch up on its own, so it says the reads are
 * temporarily unavailable, as a `warning` led by TriangleAlert. The last known
 * values stay, unchanged.
 *
 * An answer that may only be out of date (`X-Raft-Stale`, a 503
 * `rw_overloaded`, values seeded from the saved copy) says nothing: it catches
 * up on its own and the list updates silently (artin, #triage:#517, which
 * dropped the "may be out of date" notice task #164 had added).
 */
export function StaleCountsNotice({ surfaces, unavailableMessageId, "data-testid": testId }: StaleCountsNoticeProps) {
  const { formatMessage } = useIntl();
  const unconfigured = useRwUnconfigured(surfaces);
  if (!unconfigured) return null;
  return (
    <PanelNotice status="warning" role="status" data-testid={testId} data-reason="rw_unconfigured">
      <TriangleAlert aria-hidden="true" />
      <PanelNoticeContent>{formatMessage({ id: unavailableMessageId })}</PanelNoticeContent>
    </PanelNotice>
  );
}
