import { useIntl } from "react-intl";
import { Button, MessageActionCardActions } from "@botiverse/raft-ui";
import type { ActionCardMetadata } from "@botiverse/raft-shared";
import LeavingRaftMark, { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";
import { installedAppSetupUrl } from "./actionCardIntentFlows";

/**
 * An installed App's setup page (Continue setup), drawn by the spec card's
 * frame under a done install card's result, from the card's result and only
 * when safe (installedAppSetupUrl). The frame keeps such a card open, so it
 * shows without unfolding the card. Nothing for any other card.
 */
export function ActionCardContinueSetup({ metadata }: { metadata: ActionCardMetadata }) {
  const { formatMessage } = useIntl();
  const setupUrl = installedAppSetupUrl(metadata);
  if (setupUrl === null) return null;
  const label = formatMessage({ id: "appSetup.continue" });
  return (
    <MessageActionCardActions data-action-card-stack="actions">
      <Button
        size="md"
        variant="outline"
        className="max-w-full"
        nativeButton={false}
        role="link"
        render={<a href={setupUrl} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, label)} />}
        data-action-card-frame-button="continue-setup"
      >
        {label}
        <LeavingRaftMark data-icon="inline-end" />
      </Button>
    </MessageActionCardActions>
  );
}
