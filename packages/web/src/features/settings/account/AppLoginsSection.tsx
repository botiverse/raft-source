import { ListRowGroup } from "@botiverse/raft-ui";
import { LogIn } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useIntl } from "react-intl";
import ConfirmDialog from "../../../components/ConfirmDialog";
import { showToast } from "../../../components/toastBridge";
import SectionHeader from "../../../components/ui/SectionHeader";
import { AppLoginRow } from "./AppLoginRow";
import { listAppLogins, revokeAppLogin } from "./appLoginsApi";
import type { AppLogin } from "./appLoginsApi";

/**
 * Settings › Account › Apps you signed in to with Raft (RFC 079 phase 3a,
 * design §4.2): the account-mode Apps that know who the person is, each with
 * Revoke → confirm → DELETE /api/me/app-logins/:clientId. Renders only while
 * the list has an entry (no App is in account mode yet, so nobody sees it
 * today); a failed load renders nothing either.
 *
 * The Revoke that opened the dialog goes with its row, so a revoke moves
 * focus to the next row's Revoke (the one before it after the last row), or
 * to `emptiedFocus` when the section goes with the last one (raft-design
 * Accessibility: the nearest related element, never the page). The dialog
 * opens on Cancel.
 */
export function AppLoginsSection({ emptiedFocus }: {
  /** Where focus goes when revoking the last App removes the section. */
  emptiedFocus?: RefObject<HTMLElement | null>;
} = {}) {
  const { formatMessage } = useIntl();
  const [logins, setLogins] = useState<AppLogin[]>([]);
  const [pending, setPending] = useState<AppLogin | null>(null);
  const revokeButtons = useRef(new Map<string, HTMLButtonElement>());
  // The dialog's finalFocus: empty (back to the Revoke that opened it) until a revoke goes through.
  const afterRevokeFocus = useRef<HTMLElement | null>(null);
  const registerRevokeButton = useCallback((clientId: string, button: HTMLButtonElement | null) => {
    if (button) revokeButtons.current.set(clientId, button);
    else revokeButtons.current.delete(clientId);
  }, []);
  const openConfirm = useCallback((login: AppLogin) => {
    afterRevokeFocus.current = null;
    setPending(login);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listAppLogins().then((list) => {
      if (!cancelled) setLogins(list);
    }, () => {
      // Nothing to show: the section stays hidden.
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const closeConfirm = useCallback(() => setPending(null), []);
  const confirmRevoke = useCallback(async () => {
    if (!pending) return;
    try {
      await revokeAppLogin(pending.clientId);
    } catch {
      // The dialog shows this and stays open; the row stays.
      throw new Error(formatMessage({ id: "settings.account.appLogins.revokeFailed" }, { appName: pending.name }));
    }
    const index = logins.findIndex((login) => login.clientId === pending.clientId);
    const neighbour = logins[index + 1] ?? logins[index - 1];
    afterRevokeFocus.current = (neighbour ? revokeButtons.current.get(neighbour.clientId) : null)
      ?? emptiedFocus?.current
      ?? null;
    setLogins((current) => current.filter((login) => login.clientId !== pending.clientId));
    showToast({ title: formatMessage({ id: "settings.account.appLogins.revoked" }, { appName: pending.name }), type: "success" });
  }, [emptiedFocus, formatMessage, logins, pending]);

  if (logins.length === 0 && !pending) return null;

  return (
    <div className="mb-6" data-testid="app-logins-section">
      {logins.length > 0 ? (
        <>
          {/* The section's description under its header, then one row per App in a
              ListRowGroup (DS Forms › A setting's row; cindyz, #proj-raft-ui:#220). */}
          <SectionHeader
            className="mb-1"
            icon={<LogIn size={16} />}
            label={formatMessage({ id: "settings.account.appLogins.title" })}
          />
          <p className="mb-3 text-footnote text-foreground-muted">
            {formatMessage({ id: "settings.account.appLogins.description" })}
          </p>
          <ListRowGroup data-testid="app-logins-rows">
            {logins.map((login) => (
              <AppLoginRow key={login.clientId} login={login} onRevoke={openConfirm} revokeRef={registerRevokeButton} />
            ))}
          </ListRowGroup>
        </>
      ) : null}

      {pending ? (
        <ConfirmDialog
          title={formatMessage({ id: "settings.account.appLogins.confirmTitle" }, { appName: pending.name })}
          message={formatMessage({ id: "settings.account.appLogins.confirmBody" }, { appName: pending.name })}
          confirmLabel={formatMessage({ id: "settings.account.appLogins.revoke" })}
          confirmVariant="warning"
          confirmTestId="app-login-revoke-confirm"
          initialFocus="cancel"
          finalFocus={afterRevokeFocus}
          onConfirm={confirmRevoke}
          onClose={closeConfirm}
        />
      ) : null}
    </div>
  );
}
