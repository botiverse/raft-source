import { useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import { useAuthStore } from "../../store/authStore";
import { ArrowLeft } from "lucide-react";
import AuthPageFrame, { AuthPageIntro } from "./AuthPageFrame";
import Button from "../ui/Button";
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
      // Clean up URL
      const url = new URL(window.location.href);
      url.searchParams.delete("reset");
      window.history.replaceState({}, "", url.pathname + url.hash);
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
            size="lg"
            shape="iconText"
            tone="pink"
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
          <Banner intent="warning" className="mb-4 font-bold">{error}</Banner>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <FormField label={formatMessage({ id: "pages.resetPassword.newPasswordLabel" })} labelStyle="plain" error={fieldErrors.password}>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (fieldErrors.password) setFieldErrors((current) => ({ ...current, password: undefined }));
              }}
              className="w-full border-2 border-black p-2 text-base shadow-brutal-sm focus:shadow-brutal focus:outline-none"
              placeholder={formatMessage({ id: "pages.resetPassword.passwordPlaceholder" })}
              required
            />
          </FormField>
          <FormField label={formatMessage({ id: "pages.resetPassword.confirmPasswordLabel" })} labelStyle="plain" error={fieldErrors.confirmPassword}>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                if (fieldErrors.confirmPassword) setFieldErrors((current) => ({ ...current, confirmPassword: undefined }));
              }}
              className="w-full border-2 border-black p-2 text-base shadow-brutal-sm focus:shadow-brutal focus:outline-none"
              required
            />
          </FormField>
          <Button
            type="submit"
            disabled={loading}
            size="lg"
            tone="pink"
            className="w-full"
          >
            {loading
              ? formatMessage({ id: "pages.resetPassword.resetting" })
              : formatMessage({ id: "pages.resetPassword.submit" })}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm">
          <button onClick={onBack} className="font-bold text-brutal-pink underline">
            {formatMessage({ id: "auth.backToSignIn.link" })}
          </button>
        </p>
      </div>
    </AuthPageFrame>
  );
}
