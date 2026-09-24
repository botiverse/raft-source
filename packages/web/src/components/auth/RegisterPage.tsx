import { useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import type { ReactNode } from "react";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { useAuthStore } from "../../store/authStore";
import type { AuthProvider, SocialAuthProviderId } from "../../hooks/useAuthProviders";
import { useAuthProviders } from "../../hooks/useAuthProviders";
import {
  buildSocialAuthStartUrl,
  getCurrentReturnTo,
  getExternalBrowserLoginUrl,
  isEmbeddedBrowser,
  PENDING_INVITE_STORAGE_KEY,
} from "../../utils/socialAuth";
import AuthPageFrame, { AuthPageIntro } from "./AuthPageFrame";
import Button from "../ui/Button";
import TextLink from "../ui/TextLink";
import Banner from "../ui/Banner";
import FormField from "../ui/FormField";
import LegalAcceptanceCheckbox from "./LegalAcceptanceCheckbox";
import OpenInBrowserSignInGuide from "./OpenInBrowserSignInGuide";
import SocialProviderButton from "./SocialProviderButton";
import { AUTH_MESSAGE_IDS, authServerErrorMessage, isValidEmailFormat } from "./authErrors";

interface RegisterPageProps {
  onSwitchToLogin: () => void;
  previewProviders?: AuthProvider[];
}

export default function RegisterPage({ onSwitchToLogin, previewProviders }: RegisterPageProps) {
  const { formatMessage } = useIntl();
  const register = useAuthStore((state) => state.register);
  const loading = useAuthStore((state) => state.loading);
  const { enabledProviders: configuredProviders } = useAuthProviders();
  const enabledProviders = previewProviders ?? configuredProviders;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [acceptedLegal, setAcceptedLegal] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [showOpenInBrowserGuide, setShowOpenInBrowserGuide] = useState(false);

  const handleSocialLogin = (providerId: SocialAuthProviderId) => {
    if (previewProviders) return;
    if (isEmbeddedBrowser()) {
      setShowOpenInBrowserGuide(true);
      return;
    }
    window.location.href = buildSocialAuthStartUrl(providerId, getCurrentReturnTo());
  };

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
      });
    } catch (err: any) {
      setError(authServerErrorMessage(err, formatMessage({ id: "pages.register.failed" }), formatMessage));
    }
  };

  if (showOpenInBrowserGuide) {
    return (
      <OpenInBrowserSignInGuide
        loginUrl={getExternalBrowserLoginUrl()}
        onBack={() => setShowOpenInBrowserGuide(false)}
      />
    );
  }

  return (
    <AuthPageFrame>
      <div className="w-full">
        <AuthPageIntro title={formatMessage({ id: "pages.register.title" })} />

        {error ? <Banner intent="warning" className="mb-4 font-bold">{error}</Banner> : null}

        <form onSubmit={handleSubmit} className="space-y-4" autoComplete="on" noValidate>
          <FormField label={formatMessage({ id: "pages.register.emailLabel" })} labelStyle="plain" error={fieldErrors.email} htmlFor="register-email">
            <input
              id="register-email"
              name="email"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                if (fieldErrors.email) setFieldErrors((current) => ({ ...current, email: undefined }));
              }}
              className="w-full border-2 border-black p-2 text-base shadow-brutal-sm focus:shadow-brutal focus:outline-none"
              autoComplete="email"
              required
            />
          </FormField>

          <FormField label={formatMessage({ id: "pages.register.passwordLabel" })} labelStyle="plain" error={fieldErrors.password} htmlFor="register-password">
            <input
              id="register-password"
              name="new-password"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                if (fieldErrors.password) setFieldErrors((current) => ({ ...current, password: undefined }));
              }}
              className="w-full border-2 border-black p-2 text-base shadow-brutal-sm focus:shadow-brutal focus:outline-none"
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
            size="lg"
            tone="pink"
            className="w-full"
          >
            {loading
              ? formatMessage({ id: "pages.register.creatingAccount" })
              : formatMessage({ id: "pages.register.submit" })}
          </Button>
        </form>

        {enabledProviders.length > 0 ? (
          <>
            <div className="my-4 flex items-center gap-3">
              <div className="h-0.5 flex-1 bg-black" />
              <span className="text-xs font-bold uppercase tracking-widest text-black/45">
                {formatMessage({ id: "pages.register.or" })}
              </span>
              <div className="h-0.5 flex-1 bg-black" />
            </div>
            <div className="space-y-2">
              {enabledProviders.map((provider) => (
                <SocialProviderButton
                  key={provider.id}
                  providerId={provider.id}
                  label={provider.label}
                  onClick={handleSocialLogin}
                />
              ))}
            </div>
          </>
        ) : null}

        <p className="mt-4 text-center text-sm">
          {formatMessage(
            { id: "pages.register.haveAccountPrompt" },
            {
              signin: (c: ReactNode) => (
                <TextLink key="signin" variant="primary" onClick={onSwitchToLogin}>
                  {c}
                </TextLink>
              ),
            },
          )}
        </p>
      </div>
    </AuthPageFrame>
  );
}
