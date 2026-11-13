import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import api from "../api/client";
import AuthPageFrame, { AuthPageIntro } from "../components/auth/AuthPageFrame";
import Banner from "../components/ui/Banner";

// Where a device login's revoke link lands (`?revoke_device_login=<token>`,
// mailed after an approval). Signed in or not: the token alone may revoke,
// and nothing else. Revoking takes a click, never the page load, so a mail
// scanner that opens the link revokes nothing. A `dvcr_` token is a
// Computer's revoke link instead (mailed with "You added X to Y"): the same
// route revokes that one machine, and the page says so before and after.

type RevokeFailure = { response?: { data?: { code?: string } } };

type State =
  | { kind: "ready" }
  | { kind: "revoking" }
  /** `sessionFound: false`: exchanged by a server from before sessions were recorded; nothing to sign out here. */
  | { kind: "revoked"; sessionFound: boolean; computer: boolean }
  | { kind: "failed"; messageId: FailureMessageId };

type FailureMessageId =
  | "pages.deviceLoginRevoke.linkUsed"
  | "pages.deviceLoginRevoke.computerLinkUsed"
  | "pages.deviceLoginRevoke.linkExpired"
  | "pages.deviceLoginRevoke.linkInvalid"
  | "pages.deviceLoginRevoke.failedFallback"
  | "pages.deviceLoginRevoke.computerFailedFallback";

function failureMessageId(code: string | undefined, computer: boolean): FailureMessageId {
  if (code === "revoke_link_used") return computer ? "pages.deviceLoginRevoke.computerLinkUsed" : "pages.deviceLoginRevoke.linkUsed";
  if (code === "revoke_link_expired") return "pages.deviceLoginRevoke.linkExpired";
  if (code === "revoke_link_invalid") return "pages.deviceLoginRevoke.linkInvalid";
  return computer ? "pages.deviceLoginRevoke.computerFailedFallback" : "pages.deviceLoginRevoke.failedFallback";
}

/** A Computer's revoke link (server: computerKeyRevocation.ts). */
function isComputerRevokeToken(token: string): boolean {
  return token.startsWith("dvcr_");
}

export default function DeviceLoginRevokePage({ token }: { token: string }) {
  const { formatMessage } = useIntl();
  const [state, setState] = useState<State>({ kind: "ready" });
  const computer = isComputerRevokeToken(token);

  // The token stays out of the address bar and history once read.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("revoke_device_login")) return;
    url.searchParams.delete("revoke_device_login");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }, []);

  const handleRevoke = useCallback(async () => {
    setState({ kind: "revoking" });
    try {
      const { data } = await api.post<{ revoked?: string }>("/auth/device/revoke", { token });
      setState({ kind: "revoked", sessionFound: data?.revoked !== "session_unknown", computer: computer || data?.revoked === "computer" });
    } catch (err) {
      setState({ kind: "failed", messageId: failureMessageId((err as RevokeFailure).response?.data?.code, computer) });
    }
  }, [token, computer]);
  const handleGoToRaft = useCallback(() => {
    window.location.assign("/");
  }, []);

  if (state.kind === "revoked") {
    return (
      <AuthPageFrame>
        <div className="w-full">
          <AuthPageIntro
            title={formatMessage({ id: state.computer ? "pages.deviceLoginRevoke.computerRevokedTitle" : "pages.deviceLoginRevoke.revokedTitle" })}
            description={formatMessage({
              id: state.computer
                ? "pages.deviceLoginRevoke.computerRevokedDescription"
                : state.sessionFound ? "pages.deviceLoginRevoke.revokedDescription" : "pages.deviceLoginRevoke.revokedSessionUnknown",
            })}
          />
          <Button type="button" onClick={handleGoToRaft} size="xl" variant="accent" className="w-full">
            {formatMessage({ id: "pages.deviceLoginRevoke.goToRaft" })}
          </Button>
        </div>
      </AuthPageFrame>
    );
  }

  const failed = state.kind === "failed" ? state : null;
  // A used, expired or unknown link can't be retried; only an unexpected failure can.
  const canRevoke = !failed
    || failed.messageId === "pages.deviceLoginRevoke.failedFallback"
    || failed.messageId === "pages.deviceLoginRevoke.computerFailedFallback";
  return (
    <AuthPageFrame>
      <div className="w-full">
        <AuthPageIntro
          title={formatMessage({ id: computer ? "pages.deviceLoginRevoke.computerTitle" : "pages.deviceLoginRevoke.title" })}
          description={formatMessage({ id: computer ? "pages.deviceLoginRevoke.computerDescription" : "pages.deviceLoginRevoke.description" })}
        />
        {failed ? (
          <Banner intent="warning" className="mb-4">{formatMessage({ id: failed.messageId })}</Banner>
        ) : null}
        {canRevoke ? (
          <Button
            type="button"
            onClick={handleRevoke}
            disabled={state.kind === "revoking"}
            size="xl"
            variant="danger"
            className="w-full"
          >
            {state.kind === "revoking"
              ? formatMessage({ id: computer ? "pages.deviceLoginRevoke.computerRevoking" : "pages.deviceLoginRevoke.revoking" })
              : formatMessage({ id: computer ? "pages.deviceLoginRevoke.computerRevoke" : "pages.deviceLoginRevoke.revoke" })}
          </Button>
        ) : (
          <Button type="button" onClick={handleGoToRaft} size="xl" variant="accent" className="w-full">
            {formatMessage({ id: "pages.deviceLoginRevoke.goToRaft" })}
          </Button>
        )}
      </div>
    </AuthPageFrame>
  );
}
