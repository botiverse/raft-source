import { useIntl } from "react-intl";
import Banner from "../../components/ui/Banner";
import { focusOnMount } from "./focusOnMount";
import type { AccountLoginRefusal } from "./loginErrors";

/**
 * Why this account-mode sign-in can't go ahead, the card's first notice,
 * under its title: a refusal the page words itself (suspended, a
 * Server-scoped sign-in address), else `error` (what the lookups found).
 * Nothing when there is neither. `takeFocus`: the refusal answered a press
 * of Login with Raft, and the button pressed is gone; focusing it also
 * scrolls it into view (off screen on a phone). A refusal known when the
 * page loads doesn't take focus.
 */
export function AccountLoginRefusalBanner({ refusal, error, takeFocus }: {
  refusal: AccountLoginRefusal | null;
  error: string;
  takeFocus: boolean;
}) {
  const { formatMessage } = useIntl();
  const message = refusal === "rootIssuerRequired"
    ? formatMessage({ id: "pages.humanLogin.account.rootIssuerRequired" })
    : refusal === "installationSuspended"
      ? formatMessage({ id: "pages.humanLogin.account.installationSuspended" })
      : error;
  if (!message) return null;
  return (
    <Banner ref={takeFocus ? focusOnMount : undefined} tabIndex={-1} intent="warning" role="alert" className="mb-4 outline-none focus-visible:shadow-focus" data-testid="account-login-refusal">
      {message}
    </Banner>
  );
}
