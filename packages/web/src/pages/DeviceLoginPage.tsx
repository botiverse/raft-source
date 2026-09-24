import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import api from "../api/client";
import { useAuthStore } from "../store/authStore";
import AuthPageFrame, { AuthPageIntro } from "../components/auth/AuthPageFrame";
import SignedInAs from "../components/auth/SignedInAs";
import Banner from "../components/ui/Banner";
import FormField from "../components/ui/FormField";

function initialUserCode(): string {
  return new URLSearchParams(window.location.search).get("user_code") || "";
}

function normalizeUserCode(value: string): string {
  return value.trim().toUpperCase();
}

export default function DeviceLoginPage() {
  const { formatMessage } = useIntl();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const initialCode = useMemo(() => initialUserCode(), []);
  const [userCode, setUserCode] = useState(initialCode);
  const [submitting, setSubmitting] = useState(false);
  const [approved, setApproved] = useState(false);
  const [closeAttempted, setCloseAttempted] = useState(false);
  const [error, setError] = useState("");

  const normalizedCode = normalizeUserCode(userCode);

  async function approveDeviceLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedCode) return;

    setSubmitting(true);
    setError("");
    try {
      await api.post("/auth/device/approve", { userCode: normalizedCode, approve: true });
      setApproved(true);
      const url = new URL(window.location.href);
      url.searchParams.delete("user_code");
      window.history.replaceState({}, "", url.pathname + url.hash);
    } catch (err: any) {
      const code = err.response?.data?.code;
      const fallback = err.response?.data?.error || formatMessage({ id: "pages.deviceLogin.approveFailedFallback" });
      if (code === "user_code_invalid") {
        setError(formatMessage({ id: "pages.deviceLogin.codeInvalid" }));
      } else if (code === "expired") {
        setError(formatMessage({ id: "pages.deviceLogin.codeExpired" }));
      } else if (code === "already_resolved") {
        setError(formatMessage({ id: "pages.deviceLogin.codeAlreadyUsed" }));
      } else {
        setError(fallback);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (approved) {
    function closePage() {
      setCloseAttempted(true);
      window.close();
    }

    return (
      <AuthPageFrame>
        <div className="w-full">
          <AuthPageIntro
            title={formatMessage({ id: "pages.deviceLogin.approvedTitle" })}
            description={formatMessage({ id: "pages.deviceLogin.approvedDescription" })}
          />
          <button
            type="button"
            onClick={closePage}
            className="btn-brutal block w-full bg-brutal-pink px-3 py-2 text-center text-sm"
          >
            {formatMessage({ id: "pages.deviceLogin.closePage" })}
          </button>
          {closeAttempted ? (
            <p className="mt-3 text-center text-xs font-bold text-brutal-gray-700">
              {formatMessage({ id: "pages.deviceLogin.closeManually" })}
            </p>
          ) : null}
        </div>
      </AuthPageFrame>
    );
  }

  return (
    <AuthPageFrame>
      <div className="w-full">
        <AuthPageIntro
          title={formatMessage({ id: "pages.deviceLogin.approveTitle" })}
          description={(
            <>
              <SignedInAs user={user} prefix={formatMessage({ id: "pages.deviceLogin.signedInAsPrefix" })} suffix="." />
            </>
          )}
        />

        {error ? (
          <Banner intent="warning" className="mb-4 font-bold">{error}</Banner>
        ) : null}

        <form onSubmit={approveDeviceLogin} className="space-y-4">
          <FormField label={formatMessage({ id: "pages.deviceLogin.deviceCodeLabel" })} labelStyle="plain">
            <input
              type="text"
              value={userCode}
              onChange={(event) => setUserCode(event.target.value)}
              placeholder={formatMessage({ id: "pages.deviceLogin.codePlaceholder" })}
              autoCapitalize="characters"
              autoComplete="one-time-code"
              className="w-full border-2 border-black p-2 text-center font-mono text-lg font-black tracking-widest shadow-brutal-sm focus:shadow-brutal focus:outline-none"
            />
          </FormField>

          <button
            type="submit"
            disabled={submitting || !normalizedCode}
            className="btn-brutal w-full bg-brutal-pink px-3 py-2 text-sm disabled:opacity-50"
          >
            {submitting ? formatMessage({ id: "pages.deviceLogin.approving" }) : formatMessage({ id: "pages.deviceLogin.approve" })}
          </button>
        </form>

        <button
          type="button"
          onClick={() => logout()}
          className="mt-3 w-full border-2 border-black bg-white p-2 text-sm font-bold shadow-brutal-sm transition-all duration-100 hover:-translate-y-[1px] hover:shadow-brutal active:translate-x-[1px] active:translate-y-[1px] active:shadow-brutal-active"
        >
          {formatMessage({ id: "pages.deviceLogin.useAnotherAccount" })}
        </button>
      </div>
    </AuthPageFrame>
  );
}
