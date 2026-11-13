import { useIntl } from "react-intl";
import Banner from "../ui/Banner";

/**
 * Feedback inbox: most tickets are typed by hand, yet an agent can draft one
 * (a `feedback:submit` card the person reviews and confirms). It promotes one
 * feature at the top of a list page, so it is an info Banner (Raft Design
 * System › Banner: information, `status="info"` with its Info icon): one line
 * with a bold lead, no button, so New feedback stays the page's one action.
 * Part of the page rather than news, so it is not announced as live. Only on
 * the inbox: someone who opened the composer already chose to write it.
 *
 * It goes in the SDK inbox's `inboxNotice` slot: its own line under the
 * toolbar (New feedback at its end), above the ticket list. The slot brings
 * the inset, so this is the Banner alone, with no padding of its own.
 *
 * Gone once this person has sent an agent's draft (a `feedback:submit` card)
 * in this browser: they know. Per browser (feedback/agentFeedbackSentFlag.ts),
 * so another device shows it until they send one there. The page
 * (AboutFeedbackDialog) checks that and passes null to the slot instead: a
 * component that renders nothing would still leave the slot's empty inset.
 */
export function FeedbackAgentHint() {
  const { formatMessage } = useIntl();
  return (
    <Banner intent="info" density="sm" withIcon live={false} data-testid="settings-feedback-agent-hint">
      {formatMessage(
        { id: "settings.about.feedbackAgentHint" },
        { strong: (chunks) => <strong key="lead">{chunks}</strong> },
      )}
    </Banner>
  );
}
