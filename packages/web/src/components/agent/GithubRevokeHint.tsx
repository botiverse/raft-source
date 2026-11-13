import { useIntl } from "react-intl";
import { TextLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import Banner from "../ui/Banner";
import { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";
import { GITHUB_AUTHORIZED_APPS_URL } from "./agentConnectionApi";

/**
 * After a removal that took, when the server says the provider could not reach
 * a copy of the credential it had handed to an agent (`revokeOnGithub`): only
 * revoking the authorization on GitHub takes that copy back, at the cost of
 * every connection of that GitHub account. Shown only on that word, never as
 * a routine reminder, so people don't learn to skip it.
 */
export function GithubRevokeHint({ onClose }: { onClose: () => void }) {
  const { formatMessage } = useIntl();
  const linkLabel = formatMessage({ id: "agent.detail.connections.revokeOnGithubLink" });
  return (
    <Banner
      intent="warning"
      density="sm"
      withIcon
      data-testid="agent-connection-github-revoke-hint"
      onClose={onClose}
      closeLabel={formatMessage({ id: "agent.detail.connections.dismiss" })}
    >
      {formatMessage({ id: "agent.detail.connections.revokeOnGithub" }, {
        link: (
          <TextLink
            key="github-settings"
            variant="strong"
            render={(
              <a
                href={GITHUB_AUTHORIZED_APPS_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={opensInNewTabAriaLabel(formatMessage, linkLabel)}
              />
            )}
            data-testid="agent-connection-github-revoke-link"
          >
            {linkLabel}
            <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
          </TextLink>
        ),
      })}
    </Banner>
  );
}
