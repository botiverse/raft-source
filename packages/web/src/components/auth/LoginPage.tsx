import { useState, useCallback, useMemo } from "react";
import { Input, Button, TextSans, TextLink, MarkdownLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { useAccountLinkSignIn } from "../../hooks/useAccountLinkSignIn";
import { useAuthStore } from "../../store/authStore";
import type { SocialAuthProviderId } from "../../hooks/useAuthProviders";
import { useAuthProviders } from "../../hooks/useAuthProviders";
import { getCurrentReturnTo, getExternalBrowserLoginUrl, isEmbeddedBrowser } from "../../utils/socialAuth";
import { startSocialSignIn } from "../../utils/socialSignIn";
import AuthPageFrame, { AuthPageIntro } from "./AuthPageFrame";
import Banner from "../ui/Banner";
import { TraceIdNote } from "../errors/TraceIdNote";
import FormField from "../ui/FormField";
import { AUTH_MESSAGE_IDS, authServerErrorMessage, isValidEmailFormat } from "./authErrors";
import OpenInBrowserSignInGuide from "./OpenInBrowserSignInGuide";
import { DesktopSignInWaiting, SocialProviderSection } from "./SocialProviderButton";
import { SsoSignInEntry } from "./SsoSignInEntry";
import { PendingSecondFactorSignInStep, useSecondFactorSignInPending } from "./SecondFactorSignInStep";
import { EMAIL_AUTOCOMPLETE_WITH_PASSKEYS, usePasskeySignIn } from "./usePasskeySignIn";
import { signInFailureTraceId } from "./signInFailure";
import { desktopPasskeySignInShown, runDesktopPasskeySignIn } from "../../utils/desktopPasskeySignIn";

export interface AccountLinkSignIn {
  terminal: "expired" | "conflict" | null;
  restart: () => void;
  attemptId: string;
  provider: SocialAuthProviderId;
  providerLabel: string;
  email: string;
  signInMethods: { password: boolean; providers: SocialAuthProviderId[] };
  busy: boolean;
  error: string;
  signIn: (email: string, password: string) => Promise<void>;
  socialSignIn: (provider: SocialAuthProviderId) => void;
  cancel: () => void;
}

export interface LoginPageProps {
  accountLink?: AccountLinkSignIn;
  onSwitchToRegister?: () => void;
  onForgotPassword: () => void;
  /**
   * Why sign-in is asked for here, a line under the title above the form: an external app's link, or "Sign in to
   * open this Artifact" on a canonical Artifact link (back after #proj-workspace:#250: it tells people what's
   * happening; xxchan, Kirby). Sign-in stays at the page's address, so it opens once someone is signed in.
   */
  purpose?: string;
  /**
   * Strips about the whole window, under the brand bar and at the window's bottom (AuthBrandShell): the open-in-app
   * offers on the sign-in page of a landed workspace address (deeplinks/SignInPage). Only on the ordinary sign-in.
   */
  topStrip?: ReactNode;
  bottomStrip?: ReactNode;
}

export default function LoginPage(props: LoginPageProps) {
  const pendingAccountLink = useAccountLinkSignIn();
  const secondFactorPending = useSecondFactorSignInPending();
  const accountLink = props.accountLink ?? pendingAccountLink;
  // The password was right and two-step verification is on: the second step
  // takes the page until it signs in or goes back (design v2 step-code).
  if (secondFactorPending) return <PendingSecondFactorSignInStep />;
  return <LoginPageForm key={accountLink?.attemptId ?? "ordinary-login"} {...props} accountLink={accountLink} />;
}

function LoginPageForm({ onSwitchToRegister, onForgotPassword, accountLink, purpose, topStrip, bottomStrip }: LoginPageProps) {
  const { formatMessage } = useIntl();
  const login = useAuthStore((s) => s.login);
  const loading = useAuthStore((s) => s.loading);
  const { enabledProviders, loading: providersLoading, expectedCount: expectedProviderCount, ssoOffered } = useAuthProviders();
  const [email, setEmail] = useState(accountLink?.email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [errorTraceId, setErrorTraceId] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [showOpenInBrowserGuide, setShowOpenInBrowserGuide] = useState(false);
  // Passkeys (usePasskeySignIn.ts): the email field's autofill and the link
  // for every browser that can use them; the link's prompt also reaches a
  // passkey on a phone. Not for an account-link sign-in: a passkey sign-in
  // can't complete the pending link.
  const passkey = usePasskeySignIn(!accountLink);
  // Raft Desktop can't use a passkey itself: the link hands it to the browser
  // (design desk-login-waiting), only once this Desktop knows an account with
  // one (D8). No autofill there.
  const desktopPasskeyShown = useMemo(() => !accountLink && desktopPasskeySignInShown(), [accountLink]);
  const handleDesktopPasskey = useCallback(() => {
    void runDesktopPasskeySignIn(formatMessage);
  }, [formatMessage]);

  const signInProviders = useMemo(
    () => (accountLink ? enabledProviders.filter((provider) => accountLink.signInMethods.providers.includes(provider.id)) : enabledProviders),
    [accountLink, enabledProviders],
  );

  const handleSocialLogin = useCallback((providerId: SocialAuthProviderId) => {
    if (accountLink) {
      accountLink.socialSignIn(providerId);
      return;
    }
    if (isEmbeddedBrowser()) {
      setShowOpenInBrowserGuide(true);
      return;
    }
    startSocialSignIn(providerId, getCurrentReturnTo(), formatMessage);
  }, [accountLink, formatMessage]);

  const handleSsoInvalidEmail = useCallback(() => {
    setFieldErrors({ email: formatMessage({ id: AUTH_MESSAGE_IDS.invalidEmail }) });
  }, [formatMessage]);

  const handleBackFromGuide = useCallback(() => {
    setShowOpenInBrowserGuide(false);
  }, []);

  const handleEmailChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setEmail(e.target.value);
    if (fieldErrors.email) setFieldErrors((current) => ({ ...current, email: undefined }));
  }, [fieldErrors.email]);

  const handlePasswordChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
    if (fieldErrors.password) setFieldErrors((current) => ({ ...current, password: undefined }));
  }, [fieldErrors.password]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading || accountLink?.busy) return;
    setError("");
    setErrorTraceId(null);
    setFieldErrors({});
    if (!isValidEmailFormat(email)) {
      setFieldErrors({ email: formatMessage({ id: AUTH_MESSAGE_IDS.invalidEmail }) });
      return;
    }
    if (!password) {
      setFieldErrors({ password: formatMessage({ id: AUTH_MESSAGE_IDS.passwordRequired }) });
      return;
    }
    try {
      if (accountLink) await accountLink.signIn(email, password);
      else await login(email, password);
    } catch (err: any) {
      const failed = formatMessage({ id: "pages.login.failed" });
      const message = authServerErrorMessage(err, failed, formatMessage);
      setError(message);
      // Only the bare "Sign-in failed" says nothing: its trace id lets us find what happened.
      setErrorTraceId(message === failed ? signInFailureTraceId(err) : null);
    }
  };

  if (showOpenInBrowserGuide) {
    return (
      <OpenInBrowserSignInGuide
        loginUrl={getExternalBrowserLoginUrl()}
        onBack={handleBackFromGuide}
      />
    );
  }

  return (
    <AuthPageFrame topStrip={accountLink ? undefined : topStrip} bottomStrip={accountLink ? undefined : bottomStrip}>
      <div className="w-full">
        <AuthPageIntro
          title={formatMessage({ id: accountLink ? "auth.accountLink.title" : "pages.login.title" })}
          description={!accountLink && purpose ? <span data-testid="login-purpose">{purpose}</span> : undefined}
        />

        {accountLink && !accountLink.terminal && (
          <Banner intent="warning" className="mb-4">
            {formatMessage({ id: "auth.accountLink.description" }, { provider: accountLink.providerLabel })}
          </Banner>
        )}
        {accountLink?.error && <Banner intent="warning" className="mb-4">{accountLink.error}</Banner>}

        {error && (
          <Banner intent="warning" className="mb-4">
            {error}
            {errorTraceId ? <span className="mt-1 block"><TraceIdNote traceId={errorTraceId} /></span> : null}
          </Banner>
        )}
        {passkey.notice && (
          <Banner intent={passkey.notice.intent} className="mb-4">{passkey.notice.message}</Banner>
        )}

        {(!accountLink || (!accountLink.terminal && accountLink.signInMethods.password)) && <form onSubmit={handleSubmit} className="stack-y-4 md:pointer-fine:stack-y-3" autoComplete="on" noValidate>
          <FormField label={formatMessage({ id: "pages.login.emailLabel" })} error={fieldErrors.email} htmlFor="login-email">
            <Input
              id="login-email"
              name="username"
              type="email"
              autoComplete={accountLink ? "username" : EMAIL_AUTOCOMPLETE_WITH_PASSKEYS}
              value={email}
              onChange={handleEmailChange}
              data-invalid={fieldErrors.email ? true : undefined}
              required
            />
          </FormField>
          <FormField
            label={formatMessage({ id: "pages.login.passwordLabel" })}
            labelAction={(
              <TextLink className="text-footnote" onClick={onForgotPassword}>
                {formatMessage({ id: "pages.login.forgotPassword" })}
              </TextLink>
            )}
            error={fieldErrors.password}
            htmlFor="login-password"
          >
            <Input
              id="login-password"
              name="password"
              type="password"
              autoFocus={!!accountLink}
              autoComplete="current-password"
              value={password}
              onChange={handlePasswordChange}
              data-invalid={fieldErrors.password ? true : undefined}
              required
            />
          </FormField>
          <Button
            type="submit"
            disabled={loading || accountLink?.busy}
            size="xl"
            variant="accent"
            className="w-full"
          >
            {loading || accountLink?.busy
            ? formatMessage({ id: "pages.login.signingIn" })
            : accountLink
              ? formatMessage({ id: "auth.accountLink.submit" }, { provider: accountLink.providerLabel })
              : formatMessage({ id: "pages.login.submit" })}
          </Button>
        </form>}

        {accountLink && !accountLink.terminal && !accountLink.signInMethods.password && (
          <TextLink className="mb-4 text-footnote" onClick={onForgotPassword}>
            {formatMessage({ id: "pages.login.forgotPassword" })}
          </TextLink>
        )}

        {!accountLink?.terminal && (
          <SocialProviderSection
            loading={providersLoading}
            expectedCount={expectedProviderCount}
            providers={signInProviders}
            separator={formatMessage({ id: "pages.login.or" })}
            disabled={accountLink?.busy}
            onSelect={handleSocialLogin}
          />
        )}
        {!accountLink && ssoOffered && (
          <SsoSignInEntry email={email} disabled={loading} onInvalidEmail={handleSsoInvalidEmail} />
        )}

        {passkey.linkShown && (
          <div className="mt-4 text-center">
            <TextLink className="text-footnote" onClick={passkey.signInWithLink} disabled={passkey.busy}>
              {formatMessage({ id: "auth.passkey.signIn" })}
            </TextLink>
          </div>
        )}
        {desktopPasskeyShown && (
          <div className="mt-4 text-center">
            <TextLink className="text-footnote" onClick={handleDesktopPasskey}>
              {formatMessage({ id: "auth.passkey.signIn" })}
            </TextLink>
          </div>
        )}
        {/* Also after the second step's "Use a Passkey", which comes here without the link. */}
        <DesktopSignInWaiting passkey />

        {accountLink?.terminal === "expired" && (
          <Button type="button" variant="accent" size="xl" className="mt-4 w-full" onClick={accountLink.restart}>
            {formatMessage({ id: "auth.social.continueWith" }, { provider: accountLink.providerLabel })}
          </Button>
        )}
        {accountLink && (
          <Button type="button" variant="outline" size="lg" className="mt-4 w-full" disabled={accountLink.busy} onClick={accountLink.cancel}>
            {accountLink.terminal
              ? formatMessage({ id: "auth.backToSignIn.button" })
              : formatMessage({ id: "auth.accountLink.cancel" }, { provider: accountLink.providerLabel })}
          </Button>
        )}

        {!accountLink && onSwitchToRegister && (
          <TextSans size="small" className="mt-4 text-center">
            {formatMessage(
              { id: "pages.login.noAccountPrompt" },
              {
                create: (c: ReactNode) => (
                  <TextLink key="create" variant="strong" onClick={onSwitchToRegister}>
                    {c}
                  </TextLink>
                ),
              },
            )}
          </TextSans>
        )}

        <TextSans size="caption" className="mt-6 text-center">
          {formatMessage(
            { id: "pages.login.legalAgreement" },
            {
              terms: (c: ReactNode) => (
                <MarkdownLink
                  key="terms"
                  href={CURRENT_LEGAL_ACCEPTANCE.termsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {c}
                  <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
                </MarkdownLink>
              ),
              privacy: (c: ReactNode) => (
                <MarkdownLink
                  key="privacy"
                  href={CURRENT_LEGAL_ACCEPTANCE.privacyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {c}
                  <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
                </MarkdownLink>
              ),
            },
          )}
        </TextSans>
      </div>
    </AuthPageFrame>
  );
}
