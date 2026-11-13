import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import Banner from "../ui/Banner";
import type { SlackBridgeRawHealth } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages";
import { slackPairWaitingReasonId } from "../channel/slackSyncHeaderState";

type CardEditNotice = NonNullable<SlackBridgeRawHealth["cardEditNotices"]>[number];
type AttachmentSourceIssue = NonNullable<SlackBridgeRawHealth["attachmentSourceIssues"]>[number];

/**
 * RFC 082 §4.6: a pair's card notice, by kind (one line per channel and kind,
 * not per card, so the copy says "a card's"). It says "not confirmed", never
 * "failed" or "synced". `updates_cannot_be_shown` is the safe fallback for a
 * stored card message that has files anyway (a send with both is refused).
 */
const CARD_EDIT_NOTICE_ID: Record<CardEditNotice["kind"], MessageId> = {
  not_confirmed: "settings.slackBridge.cardEditNotice.not_confirmed",
  latest_update_not_shown: "settings.slackBridge.cardEditNotice.latest_update_not_shown",
  updates_cannot_be_shown: "settings.slackBridge.cardEditNotice.updates_cannot_be_shown",
  edit_waiting: "settings.slackBridge.cardEditNotice.edit_waiting",
};

/** The setup panel's card-edit notices: one line per pair and kind, only those the viewer may see (the server filters). */
export function SlackCardEditNoticeBanner({
  notices,
  channelNames,
}: {
  notices: readonly CardEditNotice[] | undefined;
  channelNames: ReadonlyMap<string, string>;
}) {
  const { formatMessage } = useIntl();
  if (!notices || notices.length === 0) return null;
  return (
    <Banner className="mt-4" intent="warning" density="sm" withIcon
      title={formatMessage({ id: "settings.slackBridge.cardEditNoticeTitle" })}
      data-testid="slack-card-edit-notice">
      <ul className="stack-y-1">
        {notices.map((notice) => (
          <li key={`${notice.bindingId}:${notice.kind}`}>
            {formatMessage({ id: CARD_EDIT_NOTICE_ID[notice.kind] }, {
              channel: channelNames.get(notice.raftChannelId) ?? formatMessage({ id: "settings.slackBridge.raftChannel" }),
              reason: notice.reason ? formatMessage({ id: slackPairWaitingReasonId({ reason: notice.reason }) }) : "",
            })}
          </li>
        ))}
      </ul>
    </Banner>
  );
}

/** The setup panel's attachment-source issues (moved from SlackBridgeSetupWizard.tsx unchanged). */
export function SlackAttachmentSourceBanner({
  issues,
  channelNames,
  busy,
  onRefresh,
}: {
  issues: readonly AttachmentSourceIssue[] | undefined;
  channelNames: ReadonlyMap<string, string>;
  busy: boolean;
  onRefresh: () => void;
}) {
  const { formatMessage } = useIntl();
  if (!issues || issues.length === 0) return null;
  return (
    <Banner className="mt-4" intent="warning" density="sm" withIcon
      title={formatMessage({ id: "settings.slackBridge.attachmentSourceTitle" })}
      data-testid="slack-attachment-source-issue">
      {issues.map((issue, index) => (
        <p key={`${issue.raftChannelId}:${issue.reason}:${index}`}>{formatMessage({
          id: issue.reason === "size_mismatch"
            ? "settings.slackBridge.attachmentSourceSizeMismatch"
            : "settings.slackBridge.attachmentSourceUnavailable",
        }, { channel: channelNames.get(issue.raftChannelId) ?? formatMessage({ id: "settings.slackBridge.raftChannel" }) })}</p>
      ))}
      <Button size="md" variant="ghost" disabled={busy} onClick={onRefresh}>
        {formatMessage({ id: "settings.slackBridge.refreshAndRecheck" })}
      </Button>
    </Banner>
  );
}
