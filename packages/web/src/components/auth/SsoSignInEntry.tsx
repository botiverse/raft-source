import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import api from "../../api/client";
import { getCurrentReturnTo } from "../../utils/socialAuth";
import { ssoStartUrlWithReturnTo } from "../../utils/ssoSignIn";
import Banner from "../ui/Banner";
import { isValidEmailFormat } from "./authErrors";

type SsoConnectionChoice = { displayName: string; startUrl: string };

/**
 * "Continue with SSO" on the sign-in page (rfcs/083-server-sso.md §5.1): the
 * email already typed finds the single sign-on of the Servers that verified
 * its domain (POST /auth/sso/discover). One: go straight to it; several:
 * the person picks; none: say so, and the other ways to sign in stay.
 */
export function SsoSignInEntry({ email, onInvalidEmail, disabled }: {
  email: string;
  /** The email field is empty or malformed: the form shows its own field error. */
  onInvalidEmail: () => void;
  disabled?: boolean;
}) {
  const { formatMessage } = useIntl();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<"none" | "failed" | null>(null);
  const [choices, setChoices] = useState<SsoConnectionChoice[] | null>(null);

  const go = useCallback((choice: SsoConnectionChoice) => {
    window.location.assign(ssoStartUrlWithReturnTo(choice.startUrl, getCurrentReturnTo()));
  }, []);

  const handleContinue = useCallback(async () => {
    if (!isValidEmailFormat(email)) {
      onInvalidEmail();
      return;
    }
    setBusy(true);
    setNotice(null);
    setChoices(null);
    try {
      const { data } = await api.post<{ connections?: SsoConnectionChoice[] }>("/auth/sso/discover", { email: email.trim() });
      const connections = Array.isArray(data.connections) ? data.connections : [];
      if (connections.length === 1) {
        go(connections[0]!);
        return;
      }
      if (connections.length === 0) setNotice("none");
      else setChoices(connections);
      setBusy(false);
    } catch {
      setNotice("failed");
      setBusy(false);
    }
  }, [email, go, onInvalidEmail]);

  return (
    <div className="mt-3 stack-y-3">
      <Button type="button" variant="outline" size="xl" className="w-full" disabled={disabled || busy} onClick={handleContinue}>
        {formatMessage({ id: "auth.sso.continue" })}
      </Button>
      {notice && (
        <Banner intent="info">
          {formatMessage({ id: notice === "none" ? "auth.sso.noneForEmail" : "auth.sso.lookupFailed" })}
        </Banner>
      )}
      {choices && (
        <div className="stack-y-2" role="group" aria-label={formatMessage({ id: "auth.sso.chooseLabel" })}>
          {choices.map((choice) => (
            <SsoChoiceButton key={choice.startUrl} choice={choice} onChoose={go} />
          ))}
        </div>
      )}
    </div>
  );
}

function SsoChoiceButton({ choice, onChoose }: { choice: SsoConnectionChoice; onChoose: (choice: SsoConnectionChoice) => void }) {
  const handleClick = useCallback(() => onChoose(choice), [choice, onChoose]);
  return (
    <Button type="button" variant="outline" size="lg" className="w-full" onClick={handleClick}>
      {choice.displayName}
    </Button>
  );
}
