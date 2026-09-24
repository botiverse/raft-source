import { useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import type { ReactNode } from "react";
import { useAuthStore } from "../../store/authStore";
import { ArrowLeft } from "lucide-react";
import AuthPageFrame, { AuthPageIntro } from "./AuthPageFrame";
import Button from "../ui/Button";
import Banner from "../ui/Banner";
import FormField from "../ui/FormField";

interface ForgotPasswordPageProps {
  onBack: () => void;
}

export default function ForgotPasswordPage({ onBack }: ForgotPasswordPageProps) {
  const { formatMessage } = useIntl();
  const forgotPassword = useAuthStore((s) => s.forgotPassword);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await forgotPassword(email);
      setSent(true);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "pages.forgotPassword.sendFailed" }));
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <AuthPageFrame>
        <div className="w-full">
          <AuthPageIntro title={formatMessage({ id: "pages.forgotPassword.checkEmailTitle" })}>
            <p className="mt-2 text-sm text-black/60">
              {formatMessage(
                { id: "pages.forgotPassword.sentTo" },
                {
                  email,
                  // Tag is <addr>, NOT <email>: a chunk named `email` would
                  // collide with the {email} VALUE above and silently win,
                  // rendering the function instead of the address.
                  addr: (c: ReactNode) => (
                    <strong key="addr" className="font-mono text-sm">
                      {c}
                    </strong>
                  ),
                },
              )}
            </p>
          </AuthPageIntro>
          <div className="mb-6" />
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
        <AuthPageIntro
          title={formatMessage({ id: "pages.forgotPassword.title" })}
          description={formatMessage({ id: "pages.forgotPassword.description" })}
        />

        {error && (
          <Banner intent="warning" className="mb-4 font-bold">{error}</Banner>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <FormField label={formatMessage({ id: "pages.forgotPassword.emailLabel" })} labelStyle="plain">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
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
              ? formatMessage({ id: "pages.forgotPassword.sending" })
              : formatMessage({ id: "pages.forgotPassword.submit" })}
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
