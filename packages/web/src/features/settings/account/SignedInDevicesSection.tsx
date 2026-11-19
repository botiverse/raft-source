import { Button, ListRowGroup, TextLink } from "@botiverse/raft-ui";
import { MonitorSmartphone } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";

import { NoPasswordDialog, ReauthDialog } from "../../../components/settings/PasskeysSection";
import { secondFactorFailureOf } from "../../../components/settings/secondFactorApi";
import {
  isSecondFactorStepUpCancelled,
  isSecondFactorStepUpSignOutInstead,
  withSecondFactorStepUp,
} from "../../../components/settings/secondFactorStepUp";
import type { LostDeviceStepUp } from "../../../components/settings/secondFactorStepUp";
import { showToast } from "../../../components/toastBridge";
import Banner from "../../../components/ui/Banner";
import SectionHeader from "../../../components/ui/SectionHeader";
import { useAppNavigate } from "../../../hooks/useAppNavigate";
import { useTimeFormatter } from "../../../hooks/useTimeFormatter";
import { formatRelativeTime } from "../../../utils/relativeTime";
import { listMySessions, revokeMyOtherSessions, revokeMySession } from "./mySessionsApi";
import type { MySession, MySessionCascade, MySessionList, MySessionRevokeReason } from "./mySessionsApi";
import { SignedInDeviceRow } from "./SignedInDeviceRow";
import { SignOutDeviceDialog } from "./SignOutDeviceDialog";
import { signedInDeviceLabel } from "./signedInDeviceLabel";

type Target = { scope: "one"; session: MySession } | { scope: "others" };

/** What the server's answer leaves for the person to read: gone already (refresh, say nothing), or another try. */
class SignOutAbandoned extends Error {}

type PendingReauth = { settle: (verified: boolean) => void };

/**
 * Settings › Account › Signed-in devices (server routes/mySessions.ts): the
 * person's own sign-ins on the web, the desktop app and the phone app, This
 * device first, and Sign out for each other one, or for all of them. Computers
 * and the raft CLI sign in as devices and are the Computers page's (a line
 * under the list says so). No IP or location: the server keeps none to show.
 *
 * Signing out asks why (SignOutDeviceDialog) when it would leave Computers or
 * agent keys the sign-in approved working: Sign out, or I no longer have it
 * (`lost_device`, which disconnects them too). The server asks for proof
 * first, by refusal code, never shown as its sentence: `reauth_required`
 * opens the password dialog (or, without a password, says to sign in again),
 * `second_factor_step_up_required` (`lost_device` only: `sign_out` needs the
 * password alone, #triage:#386) the app's "Verify it's you" (with "Lost the
 * device with your authenticator?", whose Can't verify? offers Reset your
 * password by email first (Set a password by email without one: every
 * sign-in is revoked at once, this one too), then Sign it out now with your
 * password (`sign_out` instead, the password asked if it is due; not without
 * a password), and the two-step reset as a link; not for the leftovers), and
 * the choice goes again. A sign-in
 * that is already gone (`session_not_found`) closes the dialog and leaves the
 * list quietly. The list is read again after every sign-out.
 */
export function SignedInDevicesSection({ passwordConfigured }: { passwordConfigured: boolean | null }) {
  const { formatMessage, locale } = useIntl();
  const { formatCompactDate } = useTimeFormatter();
  const nav = useAppNavigate();
  // list undefined: loading; null: the server has no such list (404). One state, so an answer sets it once.
  const [load, setLoad] = useState<{ list: MySessionList | null | undefined; loadFailed: boolean }>({ list: undefined, loadFailed: false });
  const { list, loadFailed } = load;
  const [revision, setRevision] = useState(0);
  const [target, setTarget] = useState<Target | null>(null);
  const [reauth, setReauth] = useState<PendingReauth | null>(null);
  const reauthRef = useRef<PendingReauth | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMySessions().then((next) => {
      if (!cancelled) setLoad({ list: next, loadFailed: false });
    }, (err: unknown) => {
      if (cancelled) return;
      // A failed re-read keeps the rows on screen.
      const gone = secondFactorFailureOf(err).status === 404;
      setLoad((current) => (gone ? { list: null, loadFailed: false } : { ...current, loadFailed: true }));
    });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const reload = useCallback(() => setRevision((n) => n + 1), []);
  const openSignOut = useCallback((session: MySession) => setTarget({ scope: "one", session }), []);
  const openSignOutOthers = useCallback(() => setTarget({ scope: "others" }), []);
  const closeSignOut = useCallback(() => setTarget(null), []);
  const openComputers = useCallback(() => nav.toComputers(), [nav]);

  /** The password dialog over the choice; resolves true once this sign-in re-authenticated. */
  const askReauth = useCallback(() => new Promise<boolean>((resolve) => {
    const pending: PendingReauth = {
      settle: (verified) => {
        reauthRef.current = null;
        setReauth(null);
        resolve(verified);
      },
    };
    reauthRef.current = pending;
    setReauth(pending);
  }), []);
  const reauthVerified = useCallback(async () => reauthRef.current?.settle(true), []);
  const reauthClosed = useCallback(() => reauthRef.current?.settle(false), []);

  /** The request with the proof it asks for: the password, then a second step, each once. */
  const withProof = useCallback(async <T,>(request: () => Promise<T>, lostDevice?: LostDeviceStepUp): Promise<T> => {
    const proven = () => withSecondFactorStepUp(request, "signOutDevice", lostDevice ? { lostDevice } : {});
    try {
      return await proven();
    } catch (err) {
      if (secondFactorFailureOf(err).code !== "reauth_required") throw err;
      if (!(await askReauth())) throw new SignOutAbandoned();
      return proven();
    }
  }, [askReauth]);

  const announce = useCallback((title: string, cascade: MySessionCascade) => {
    showToast(cascade === "pending"
      ? { title, description: formatMessage({ id: "settings.account.signedInDevices.cascadePending" }), type: "info" }
      : { title, type: "success" });
  }, [formatMessage]);

  /** Sends `reason` for the target and says what happened. */
  const send = useCallback(async (reason: MySessionRevokeReason) => {
    if (!target) return;
    const othersListed = !!list?.sessions.some((session) => !session.current);
    // A lost device whose second step can't be passed: Can't verify? offers the password reset by email
    // (a first password without one) and, with a password, sign_out with it alone. Not for the leftovers.
    const password = passwordConfigured !== false;
    let lostDevice: LostDeviceStepUp | undefined;
    if (reason === "lost_device" && (target.scope === "one" || othersListed)) {
      lostDevice = { signOut: password ? (target.scope === "one" ? "one" : "others") : null, password };
    }
    if (target.scope === "one") {
      const cascade = await withProof(() => revokeMySession(target.session.id, reason), lostDevice);
      const device = signedInDeviceLabel(target.session.platform, formatMessage);
      announce(formatMessage({
        id: cascade === "done" ? "settings.account.signedInDevices.signedOutLost" : "settings.account.signedInDevices.signedOut",
      }, { device }), cascade);
    } else {
      const { revoked, cascade } = await withProof(() => revokeMyOtherSessions(reason), lostDevice);
      if (!othersListed) announce(formatMessage({ id: "settings.account.signedInDevices.leftoversDone" }), cascade);
      else announce(cascade === "done"
        ? formatMessage({ id: "settings.account.signedInDevices.signedOutAllLost" })
        : formatMessage({ id: "settings.account.signedInDevices.signedOutAll" }, { count: revoked }), cascade);
    }
  }, [announce, formatMessage, list, passwordConfigured, target, withProof]);

  const commit = useCallback(async (reason: MySessionRevokeReason) => {
    if (!target) return;
    try {
      try {
        await send(reason);
      } catch (err) {
        // Can't verify? › Sign it out now with your password: the same sign-in(s), `sign_out`.
        if (!isSecondFactorStepUpSignOutInstead(err)) throw err;
        await send("sign_out");
      }
    } catch (err) {
      // Closed "Verify it's you" or the password: nothing happened; the choice stays open.
      if (isSecondFactorStepUpCancelled(err) || err instanceof SignOutAbandoned) return;
      const code = secondFactorFailureOf(err).code;
      if (code !== "session_not_found" && code !== "current_session") {
        throw new Error(formatMessage({ id: "settings.account.signedInDevices.failed" }));
      }
      // Gone meanwhile (signed out elsewhere, expired): the list catches up, nothing to say.
    }
    setTarget(null);
    reload();
  }, [formatMessage, reload, send, target]);

  if (list === null) return null;
  if (list === undefined && !loadFailed) return null;
  // The server always lists the asking sign-in: an empty list is not a list to show.
  if (list && list.sessions.length === 0) return null;

  const sessions = list?.sessions ?? [];
  // Also with no other sign-in left: `lost_device` still reaches what earlier signed-out ones approved.
  const othersReach = list?.othersLostDeviceReach;
  const othersListed = sessions.some((session) => !session.current);
  const canSignOutOthers = othersListed
    || (!!othersReach && (othersReach.computers > 0 || othersReach.agentKeys > 0));

  let dialog: ReactNode = null;
  if (target?.scope === "one") {
    const { session } = target;
    dialog = (
      <SignOutDeviceDialog
        scope="one"
        title={formatMessage({
          id: session.lostDeviceReach.computers > 0 || session.lostDeviceReach.agentKeys > 0
            ? "settings.account.signedInDevices.signOutTitle"
            : "settings.account.signedInDevices.signOutTitleQuestion",
        }, { device: signedInDeviceLabel(session.platform, formatMessage) })}
        summary={formatMessage({ id: "settings.account.signedInDevices.summary" }, {
          date: formatCompactDate(session.createdAt),
          time: formatRelativeTime(session.lastActiveAt, locale) ?? "",
        })}
        reach={session.lostDeviceReach}
        onCommit={commit}
        onClose={closeSignOut}
      />
    );
  } else if (target?.scope === "others" && list) {
    const reach = list.othersLostDeviceReach;
    // No other sign-in listed: only what earlier signed-out ones approved is left to disconnect.
    dialog = othersListed ? (
      <SignOutDeviceDialog
        scope="others"
        title={formatMessage({
          id: reach.computers > 0 || reach.agentKeys > 0
            ? "settings.account.signedInDevices.signOutAllTitle"
            : "settings.account.signedInDevices.signOutAllTitleQuestion",
        })}
        reach={reach}
        onCommit={commit}
        onClose={closeSignOut}
      />
    ) : (
      <SignOutDeviceDialog
        scope="leftovers"
        title={formatMessage({ id: "settings.account.signedInDevices.leftoversTitle" })}
        reach={reach}
        onCommit={commit}
        onClose={closeSignOut}
      />
    );
  }

  return (
    // id: /settings/account#signed-in-devices opens Account at this section.
    <div id="signed-in-devices" className="mb-6 scroll-mt-4" data-testid="signed-in-devices-section">
      <SectionHeader
        className="mb-3"
        icon={<MonitorSmartphone size={16} />}
        label={formatMessage({ id: "settings.account.signedInDevices.title" })}
      />
      {!list ? (
        <Banner
          intent="warning"
          density="sm"
          actions={(
            <Button type="button" size="md" variant="outline" onClick={reload}>
              {formatMessage({ id: "common.deferred.retry" })}
            </Button>
          )}
        >
          {formatMessage({ id: "settings.account.signedInDevices.loadFailed" })}
        </Banner>
      ) : (
        <>
          <ListRowGroup data-testid="signed-in-devices-rows">
            {sessions.map((session) => (
              <SignedInDeviceRow key={session.id} session={session} onSignOut={openSignOut} />
            ))}
          </ListRowGroup>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 flex-1 basis-60 text-footnote text-foreground-muted">
              {formatMessage({ id: "settings.account.signedInDevices.computersNote" }, {
                link: (chunks: ReactNode[]) => (
                  <TextLink key="computers" type="button" variant="strong" onClick={openComputers}>{chunks}</TextLink>
                ),
              })}
            </p>
            {canSignOutOthers ? (
              <Button
                type="button"
                variant="outline"
                size="md"
                onClick={openSignOutOthers}
                className="shrink-0"
                data-testid="signed-in-devices-sign-out-others"
              >
                {formatMessage({ id: othersListed ? "settings.account.signedInDevices.signOutAll" : "settings.account.signedInDevices.leftoversButton" })}
              </Button>
            ) : null}
          </div>
        </>
      )}

      {dialog}
      {reauth ? (
        passwordConfigured === false ? (
          <NoPasswordDialog
            description={formatMessage({ id: "settings.account.signedInDevices.reauthNoPassword" })}
            onClose={reauthClosed}
            testId="signed-in-devices-reauth-dialog"
          />
        ) : (
          <ReauthDialog
            description={formatMessage({ id: "settings.account.signedInDevices.reauthDescription" })}
            onVerified={reauthVerified}
            onClose={reauthClosed}
            testId="signed-in-devices-reauth-dialog"
          />
        )
      ) : null}
    </div>
  );
}
