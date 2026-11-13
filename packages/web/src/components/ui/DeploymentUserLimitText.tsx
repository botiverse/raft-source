import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { RAFT_LICENSE_CONTACT_EMAIL } from "@botiverse/raft-shared";
import { TextLink } from "@botiverse/raft-ui";
import { RAFT_LICENSE_CONTACT_MAILTO } from "../../utils/deploymentUserLimit";

export type DeploymentUserLimitMessageId =
  | "deploymentUserLimit.refused"
  | "deploymentUserLimit.inviteNotice"
  | "deploymentUserLimit.registerNotice";

/**
 * The Raft License's user limit, said where it applies (a refusal, the invite
 * page, the sign-up page): the sentence with its contact address as a mail
 * link.
 */
export function DeploymentUserLimitText({ id = "deploymentUserLimit.refused" }: { id?: DeploymentUserLimitMessageId }) {
  const { formatMessage } = useIntl();
  return (
    <>
      {formatMessage({ id }, {
        mail: (chunks: ReactNode) => (
          <TextLink key="mail" variant="strong" render={<a href={RAFT_LICENSE_CONTACT_MAILTO} aria-label={RAFT_LICENSE_CONTACT_EMAIL} />}>
            {chunks}
          </TextLink>
        ),
      })}
    </>
  );
}
