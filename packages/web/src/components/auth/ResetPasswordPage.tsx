import { useCallback, useState } from "react";
import { Input, Button, TextSans, TextLink } from "@botiverse/raft-ui";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import { useAuthStore } from "../../store/authStore";
import { ArrowLeft } from "lucide-react";
import AuthPageFrame, { AuthPageIntro } from "./AuthPageFrame";
import Banner from "../ui/Banner";
import FormField from "../ui/FormField";
import { AUTH_MESSAGE_IDS, authServerErrorMessage } from "./authErrors";

interface ResetPasswordPageProps {
  token: string;
  onBack: () => void;
}

export default function ResetPasswordPage({ token, onBack }: ResetPasswordPageProps) {
  const { formatMessage } = useIntl();
  const resetPassword = useAuthStore((s) => s.resetPassword);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; confirmPassword?: string }>({});

  const handlePasswordChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
    if (fieldErrors.password) setFieldErrors((current) => ({ ...current, password: undefined }));
  }, [fieldErrors.password]);

  const handleConfirmPasswordChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setConfirmPassword(e.target.value);
    if (fieldErrors.confirmPassword) setFieldErrors((current) => ({ ...current, confirmPassword: undefined }));
  }, [fieldErrors.confirmPassword]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setFieldErrors({});

    if (password.length < 8) {
      setFieldErrors({ password: formatMessage({ id: AUTH_MESSAGE_IDS.passwordTooShort }) });
      return;
    }
    if (password !== confirmPassword) {
      setFieldErrors({ confirmPassword: formatMessage({ id: AUTH_MESSAGE_IDS.passwordsDoNotMatch }) });
      return;
    }

    setLoading(true);
    try {
      await resetPassword(token, password);
      setSuccess(true);
      // Clean up URL — drop ONLY the reset token; preserve any other query params
      // (invite/verify/etc.) so a following flow isn't silently lost.
      const url = new URL(window.location.href);
      url.searchParams.delete("reset");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    } catch (err: any) {
      setError(authServerErrorMessage(err, formatMessage({ id: "pages.resetPassword.failed" }), formatMessage));
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <AuthPageFrame>
        <div className="w-full">
          <AuthPageIntro
            title={formatMessage({ id: "pages.resetPassword.successTitle" })}
            description={formatMessage({ id: "pages.resetPassword.successDescription" })}
          />
          <Button
            onClick={onBack}
            size="xl"
            variant="accent"
            className="w-full"
          >
            <ArrowLeft size={16} />
            {formatMessage({ id: "auth.backToSignIn.button" })}
          </Button>
        </div>
      </AuthPageFrame>
    );
  }

  return (
    <AuthPageFrame>
      <div className="w-full">
        <AuthPageIntro title={formatMessage({ id: "pages.resetPassword.title" })} />

        {error && (
          <Banner intent="warning" className="mb-4">{error}</Banner>
        )}

        <Banner intent="info" className="mb-4">{formatMessage({ id: "pages.resetPassword.deviceLoginNotice" })}</Banner>

        <form onSubmit={handleSubmit} className="stack-y-4 md:pointer-fine:stack-y-3" noValidate>
          <FormField label={formatMessage({ id: "pages.resetPassword.newPasswordLabel" })} error={fieldErrors.password}>
            <Input
              type="password"
              value={password}
              onChange={handlePasswordChange}
              data-invalid={fieldErrors.password ? true : undefined}
              placeholder={formatMessage({ id: "pages.resetPassword.passwordPlaceholder" })}
              required
            />
          </FormField>
          <FormField label={formatMessage({ id: "pages.resetPassword.confirmPasswordLabel" })} error={fieldErrors.confirmPassword}>
            <Input
              type="password"
              value={confirmPassword}
              onChange={handleConfirmPasswordChange}
              data-invalid={fieldErrors.confirmPassword ? true : undefined}
              required
            />
          </FormField>
          <Button
            type="submit"
            disabled={loading}
            size="xl"
            variant="accent"
            className="w-full"
          >
            {loading
              ? formatMessage({ id: "pages.resetPassword.resetting" })
              : formatMessage({ id: "pages.resetPassword.submit" })}
          </Button>
        </form>

        <TextSans size="small" className="mt-4 text-center">
          <TextLink onClick={onBack}>
            {formatMessage({ id: "auth.backToSignIn.link" })}
          </TextLink>
        </TextSans>
      </div>
    </AuthPageFrame>
  );
}
