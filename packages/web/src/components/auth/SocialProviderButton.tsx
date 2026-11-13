import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Button, Separator, TextLink } from "@botiverse/raft-ui";
import type { SocialAuthProviderId } from "../../hooks/useAuthProviders";
import { cancelDesktopOAuthAttempt, useDesktopOAuthWaiting } from "../../utils/desktopOAuth";
import { DESKTOP_PASSKEY_PROVIDER } from "../../utils/desktopPasskeySignIn";
import { AppleLogo, GitHubLogo, GoogleLogo } from "../icons/ProviderLogos";

const SOCIAL_BUTTON_BASE = "w-full gap-3";

export default function SocialProviderButton({
  providerId,
  label,
  onClick,
  disabled,
}: {
  disabled?: boolean;
  providerId: SocialAuthProviderId;
  label: string;
  onClick: (providerId: SocialAuthProviderId) => void;
}) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => {
    onClick(providerId);
  }, [onClick, providerId]);
  const logo = providerId === "google"
    ? <GoogleLogo />
    : providerId === "github"
      ? <GitHubLogo />
      : <AppleLogo />;

  return (
    <Button
      disabled={disabled}
      type="button"
      variant="outline"
      size="lg"
      className={SOCIAL_BUTTON_BASE}
      onClick={handleClick}
    >
      {logo}
      <span>{formatMessage({ id: "auth.social.continueWith" }, { provider: label })}</span>
    </Button>
  );
}

/**
 * A sign-in page's third-party buttons under "or". While the deployment's
 * providers are on their way (`loading`), the same space kept empty for as
 * many as it showed last time (`expectedCount`, useAuthProviders), so the
 * form above doesn't move when they arrive (Raft DS: the first frame is the
 * settled one).
 */
export function SocialProviderSection({
  loading,
  expectedCount,
  providers,
  separator,
  disabled,
  onSelect,
}: {
  loading: boolean;
  expectedCount: number;
  providers: readonly { id: SocialAuthProviderId; label: string }[];
  separator: string;
  disabled?: boolean;
  onSelect: (providerId: SocialAuthProviderId) => void;
}) {
  if (loading) {
    if (expectedCount === 0) return null;
    return (
      <div aria-hidden="true" inert className="invisible" data-testid="social-providers-reserved">
        <Separator className="my-1">{separator}</Separator>
        <div className="stack-y-2">
          {Array.from({ length: expectedCount }, (_, index) => (
            <Button key={index} type="button" variant="outline" size="lg" className={SOCIAL_BUTTON_BASE} tabIndex={-1} disabled />
          ))}
        </div>
      </div>
    );
  }
  if (providers.length === 0) return null;
  return (
    <>
      <Separator className="my-1">{separator}</Separator>
      <div className="stack-y-2">
        {providers.map((provider) => (
          <SocialProviderButton
            key={provider.id}
            disabled={disabled}
            providerId={provider.id}
            label={provider.label}
            onClick={onSelect}
          />
        ))}
      </div>
      <DesktopSignInWaiting />
    </>
  );
}

/**
 * Raft Desktop: while a sign-in waits for the system browser, say so and offer
 * Cancel (the buttons stay live: another click starts over). Renders nothing in
 * a browser, which leaves the page for the provider instead. `passkey`: the
 * row under "Sign In with a Passkey", for the passkey handoff only; without
 * it, the third-party buttons' row, for everything else.
 */
export function DesktopSignInWaiting({ passkey = false }: { passkey?: boolean }) {
  const { formatMessage } = useIntl();
  const waiting = useDesktopOAuthWaiting();
  if (waiting?.kind !== "signIn" || (waiting.provider === DESKTOP_PASSKEY_PROVIDER) !== passkey) return null;
  return (
    <div role="status" className="mt-3 flex items-center justify-center gap-2 text-footnote text-foreground-muted" data-testid="desktop-sign-in-waiting">
      <span>{formatMessage({ id: "auth.desktopSignIn.waiting" })}</span>
      <TextLink onClick={cancelDesktopOAuthAttempt}>{formatMessage({ id: "auth.desktopSignIn.cancelWaiting" })}</TextLink>
    </div>
  );
}
