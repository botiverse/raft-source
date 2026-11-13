/** 403 `session_family_required`: this sign-in can't delete the account; Sign In Again signs out. */
import { Button } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";

import Banner from "../../../components/ui/Banner";
import { signOutAfterDeletion } from "./deleteAccountFlow";

export function DeleteAccountSignInAgainBanner() {
  const { formatMessage } = useIntl();
  return (
    <Banner
      intent="warning"
      density="sm"
      data-testid="account-deletion-sign-in-again"
      actions={(
        <Button type="button" size="md" variant="outline" onClick={signOutAfterDeletion}>
          {formatMessage({ id: "accountDeletion.signInAgainButton" })}
        </Button>
      )}
    >
      {formatMessage({ id: "accountDeletion.signInAgain" })}
    </Banner>
  );
}
