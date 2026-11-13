import { useCallback, useId, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Button, Input, TextSans, TextLink } from "@botiverse/raft-ui";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { useAuthStore } from "../../store/authStore";
import type { AuthProvider, SocialAuthProviderId } from "../../hooks/useAuthProviders";
import { useAuthProviders } from "../../hooks/useAuthProviders";
import {
  getCurrentReturnTo,
  getExternalBrowserLoginUrl,
  isEmbeddedBrowser,
  PENDING_INVITE_STORAGE_KEY,
} from "../../utils/socialAuth";
import { startSocialSignIn } from "../../utils/socialSignIn";
import AuthPageFrame, { AuthPageIntro } from "./AuthPageFrame";
import Banner from "../ui/Banner";
import FormField from "../ui/FormField";
import LegalAcceptanceCheckbox, { LegalAcceptanceUsageDataNotice } from "./LegalAcceptanceCheckbox";
import OpenInBrowserSignInGuide from "./OpenInBrowserSignInGuide";
import { DesktopSignInWaiting, SocialProviderSection } from "./SocialProviderButton";
import { AUTH_MESSAGE_IDS, authServerErrorMessage, isValidEmailFormat } from "./authErrors";
import { DeploymentUserLimitText } from "../ui/DeploymentUserLimitText";

interface RegisterPageProps {
  onSwitchToLogin: () => void;
  previewProviders?: AuthProvider[];
}

export default function RegisterPage({ onSwitchToLogin, previewProviders }: RegisterPageProps) {
  const { formatMessage } = useIntl();
  const register = useAuthStore((state) => state.register);
  const loading = useAuthStore((state) => state.loading);
  const {
    enabledProviders: configuredProviders,
    loading: providersLoading,
    expectedCount: expectedProviderCount,
    deploymentUserLimitReached,
  } = useAuthProviders();
  const enabledProviders = previewProviders ?? configuredProviders;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [acceptedLegal, setAcceptedLegal] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [showOpenInBrowserGuide, setShowOpenInBrowserGuide] = useState(false);
  const usageDataNoticeId = useId();

  const handleSocialLogin = useCallback((providerId: SocialAuthProviderId) => {
    if (previewProviders) return;
    if (isEmbeddedBrowser()) {
      setShowOpenInBrowserGuide(true);
      return;
    }
    startSocialSignIn(providerId, getCurrentReturnTo(), formatMessage);
  }, [formatMessage, previewProviders]);

  const handleCloseOpenInBrowserGuide = useCallback(() => {
    setShowOpenInBrowserGuide(false);
  }, []);

  const handleEmailChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
    if (fieldErrors.email) setFieldErrors((current) => ({ ...current, email: undefined }));
  }, [fieldErrors.email]);

  const handlePasswordChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setPassword(event.target.value);
    if (fieldErrors.password) setFieldErrors((current) => ({ ...current, password: undefined }));
  }, [fieldErrors.password]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setFieldErrors({});

    if (!isValidEmailFormat(email)) {
      setFieldErrors({ email: formatMessage({ id: AUTH_MESSAGE_IDS.invalidEmail }) });
      return;
    }
    if (password.length < 8) {
      setFieldErrors({ password: formatMessage({ id: AUTH_MESSAGE_IDS.passwordTooShort }) });
      return;
    }
    if (!acceptedLegal) {
      setError(formatMessage({ id: "pages.register.legalRequired" }));
      return;
    }

    try {
      await register(email, password, {
        acceptTerms: true,
        termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
        privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
        legalAcceptanceSource: window.localStorage.getItem(PENDING_INVITE_STORAGE_KEY) ? "invite" : "signup",
        // The page signed up from (an Artifact link): the verification email's link lands back on it, as third-party sign-up does.
      }, getCurrentReturnTo());
    } catch (err: any) {
      setError(authServerErrorMessage(err, formatMessage({ id: "pages.register.failed" }), formatMessage));
    }
  };

  if (showOpenInBrowserGuide) {
    return (
      <OpenInBrowserSignInGuide
        loginUrl={getExternalBrowserLoginUrl()}
        onBack={handleCloseOpenInBrowserGuide}
      />
    );
  }

  return (
    <AuthPageFrame>
      <div className="w-full">
        <AuthPageIntro title={formatMessage({ id: "pages.register.title" })} />

        {error ? <Banner intent="warning" className="mb-4">{error}</Banner> : null}
        {/* Signing up still works at the limit: only joining a server as one more person is refused. */}
        {deploymentUserLimitReached && !previewProviders ? (
          <Banner intent="info" withIcon className="mb-4" data-testid="register-user-limit-notice">
            <DeploymentUserLimitText id="deploymentUserLimit.registerNotice" />
          </Banner>
        ) : null}

        <form onSubmit={handleSubmit} className="stack-y-4 md:pointer-fine:stack-y-3" autoComplete="on" noValidate>
          <FormField label={formatMessage({ id: "pages.register.emailLabel" })} error={fieldErrors.email} htmlFor="register-email">
            <Input
              id="register-email"
              name="email"
              type="email"
              value={email}
              onChange={handleEmailChange}
              data-invalid={fieldErrors.email ? true : undefined}
              autoComplete="email"
              required
            />
          </FormField>

          <FormField label={formatMessage({ id: "pages.register.passwordLabel" })} error={fieldErrors.password} htmlFor="register-password">
            <Input
              id="register-password"
              name="new-password"
              type="password"
              value={password}
              onChange={handlePasswordChange}
              data-invalid={fieldErrors.password ? true : undefined}
              placeholder={formatMessage({ id: "pages.register.passwordPlaceholder" })}
              autoComplete="new-password"
              required
            />
          </FormField>

          <LegalAcceptanceCheckbox
            checked={acceptedLegal}
            onChange={setAcceptedLegal}
            disabled={loading}
          />

          <Button
            type="submit"
            disabled={loading || !acceptedLegal}
            aria-describedby={usageDataNoticeId}
            size="xl"
            variant="accent"
            className="w-full"
          >
            {loading
              ? formatMessage({ id: "pages.register.creatingAccount" })
              : formatMessage({ id: "pages.register.submit" })}
          </Button>

          <LegalAcceptanceUsageDataNotice id={usageDataNoticeId} />
        </form>

        <SocialProviderSection
          loading={!previewProviders && providersLoading}
          expectedCount={expectedProviderCount}
          providers={enabledProviders}
          separator={formatMessage({ id: "pages.register.or" })}
          onSelect={handleSocialLogin}
        />
        {/* Raft Desktop: a second step from these buttons can hand over to a passkey in the browser. */}
        <DesktopSignInWaiting passkey />

        <TextSans size="small" className="mt-4 text-center">
          {formatMessage(
            { id: "pages.register.haveAccountPrompt" },
            {
              signin: (c: ReactNode) => (
                <TextLink key="signin" variant="strong" onClick={onSwitchToLogin}>
                  {c}
                </TextLink>
              ),
            },
          )}
        </TextSans>
      </div>
    </AuthPageFrame>
  );
}
