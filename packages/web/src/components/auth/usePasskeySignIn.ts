/**
 * Passkey sign-in on the sign-in page (#triage:#135; the link's rule is
 * tygg's, 2026-11-10, #triage:5c43fdb1, replacing design v2 D3's "only on a
 * device that used a passkey before"):
 *
 *   - Everyone gets the browser's own passkey autofill on the email field
 *     (`autocomplete="username webauthn"` + a pending `mediation:
 *     "conditional"` request), which shows nothing to someone without a
 *     passkey (design login-none / login-autofill). Feature-detected; a
 *     browser without it, or a server without passkeys, gets nothing.
 *   - "Sign In with a Passkey" shows to everyone whose browser can use
 *     passkeys (design login-passkey-link), until the server says it has
 *     none. Its prompt is discoverable (empty allowCredentials) and not
 *     conditional, so the browser also offers a passkey on another device:
 *     a phone's passkey signs in on a computer that has none. Raft Desktop
 *     can't use passkeys here (webauthn.ts) and shows its own handoff link
 *     instead (desktopPasskeySignIn.ts).
 *
 * Server (routes/auth.ts): POST /auth/passkey/options {} -> { options,
 * expiresAt } (discoverable, single-use challenge, so each attempt fetches
 * fresh options); POST /auth/passkey/verify { challenge, response } -> the
 * password sign-in's body. Every refusal is 401 `passkey_not_recognized`;
 * `passkeys_unavailable` hides the link. Only the code is read, never the
 * status: the server answered it with 503 up to v1.21.44 and 404 after. A passkey is both factors: no
 * second step follows.
 *
 * Closing the browser's prompt is not an error: the autofill says nothing,
 * and after the link the page only says the prompt was closed (design
 * login-passkey-cancel).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";

import api from "../../api/client";
import { useAuthStore } from "../../store/authStore";
import { getApiErrorResponse } from "../../utils/apiErrorResponse";
import { emitWebEvent } from "../../utils/webAuthTrace";
import {
  canAutofillPasskeys,
  canUsePasskeys,
  getPasskeyAssertion,
  isPasskeyCancel,
} from "./webauthn";
import type { PasskeyRequestOptionsJSON } from "./webauthn";

/** The email field's autocomplete with the passkey autofill (invisible without a passkey). */
export const EMAIL_AUTOCOMPLETE_WITH_PASSKEYS = "username webauthn";

async function startPasskeySignIn(): Promise<PasskeyRequestOptionsJSON> {
  const { data } = await api.post<{ options: PasskeyRequestOptionsJSON; expiresAt: string }>("/auth/passkey/options", {});
  return data.options;
}

export type PasskeySignInNotice = { intent: "info" | "warning"; message: string };

/**
 * `enabled`: false for an account-link sign-in (the passkey sign-in can't
 * complete a pending link) and anywhere else passkeys must stay out.
 */
export function usePasskeySignIn(enabled: boolean) {
  const { formatMessage } = useIntl();
  const loginWithPasskey = useAuthStore((s) => s.loginWithPasskey);
  // Read once per page: whether this browser can use passkeys at all.
  const supported = useMemo(() => enabled && canUsePasskeys(), [enabled]);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<PasskeySignInNotice | null>(null);
  // Bumped after a failed attempt: the autofill starts again with fresh options.
  const [round, setRound] = useState(0);
  const autofill = useRef<AbortController | null>(null);
  // The link's attempt, from the click until its prompt is answered (state lags a double click).
  const linkPending = useRef(false);

  /** Signs in with an answered assertion; false when it was refused (with a notice, except an autofill browser error). */
  const finish = useCallback(async (
    options: PasskeyRequestOptionsJSON,
    attempt: () => ReturnType<typeof getPasskeyAssertion>,
    signal?: AbortSignal,
  ) => {
    let response: Awaited<ReturnType<typeof getPasskeyAssertion>>;
    try {
      response = await attempt();
    } catch (err) {
      if (signal?.aborted) return false;
      setBusy(false);
      if (isPasskeyCancel(err)) return false;
      // The autofill runs on its own as the page opens, so its browser call
      // failing (usually before anything is picked: no authenticator, an
      // option it doesn't support) is not a sign-in the person tried. It is
      // traced, not shown, and the autofill isn't restarted (a persistent
      // error used to loop: fresh options, same error, again; #triage:989056fc).
      // After the link's click it is a failure as before.
      if (signal) {
        emitWebEvent("slock.auth.passkey_autofill_failed", { error_name: err instanceof Error ? err.name : "unknown" });
        return false;
      }
      setNotice({ intent: "warning", message: formatMessage({ id: "pages.login.failed" }) });
      setRound((current) => current + 1);
      return false;
    }
    try {
      setBusy(true);
      setNotice(null);
      await loginWithPasskey(options.challenge, response);
      return true;
    } catch (err) {
      // An autofill the link replaced: the link's attempt owns the page now.
      if (signal?.aborted) return false;
      setBusy(false);
      if (isPasskeyCancel(err)) return false;
      const failure = getApiErrorResponse(err);
      if (failure?.code === "passkeys_unavailable") {
        setUnavailable(true);
        return false;
      }
      setNotice({
        intent: "warning",
        message: formatMessage({ id: failure?.code === "passkey_not_recognized" ? "auth.passkey.notRecognized" : "pages.login.failed" }),
      });
      setRound((current) => current + 1);
      return false;
    }
  }, [formatMessage, loginWithPasskey]);

  const runAutofill = useCallback(async (signal: AbortSignal) => {
    if (!(await canAutofillPasskeys()) || signal.aborted) return;
    let options: PasskeyRequestOptionsJSON;
    try {
      options = await startPasskeySignIn();
    } catch (err) {
      // Nothing to show for the autofill; without passkeys on the server the link goes too.
      if (getApiErrorResponse(err)?.code === "passkeys_unavailable") setUnavailable(true);
      return;
    }
    if (signal.aborted) return;
    await finish(options, () => getPasskeyAssertion(options, { conditional: true, signal }), signal);
  }, [finish]);

  useEffect(() => {
    if (!enabled || unavailable) return undefined;
    const controller = new AbortController();
    autofill.current = controller;
    void runAutofill(controller.signal);
    return () => {
      controller.abort();
      if (autofill.current === controller) autofill.current = null;
    };
  }, [enabled, round, runAutofill, unavailable]);

  const runLink = useCallback(async () => {
    // One WebAuthn request at a time: the link's prompt replaces the autofill.
    autofill.current?.abort();
    setNotice(null);
    setBusy(true);
    let options: PasskeyRequestOptionsJSON;
    try {
      options = await startPasskeySignIn();
    } catch (err) {
      setBusy(false);
      if (getApiErrorResponse(err)?.code === "passkeys_unavailable") setUnavailable(true);
      else setNotice({ intent: "warning", message: formatMessage({ id: "pages.login.failed" }) });
      setRound((current) => current + 1);
      return;
    }
    let cancelled = false;
    const signedIn = await finish(options, async () => {
      try {
        // A prompt (not the autofill): it also offers a passkey on another device.
        return await getPasskeyAssertion(options);
      } catch (err) {
        cancelled = isPasskeyCancel(err);
        throw err;
      }
    });
    if (cancelled) {
      setNotice({ intent: "info", message: formatMessage({ id: "auth.passkey.cancelled" }) });
      setRound((current) => current + 1);
    }
    if (!signedIn) setBusy(false);
  }, [finish, formatMessage]);

  const signInWithLink = useCallback(async () => {
    if (busy || linkPending.current) return;
    linkPending.current = true;
    try {
      await runLink();
    } finally {
      linkPending.current = false;
    }
  }, [busy, runLink]);

  const handleLinkClick = useCallback(() => {
    void signInWithLink();
  }, [signInWithLink]);

  return {
    /** Show "Sign In with a Passkey" (design login-passkey-link). */
    linkShown: supported && !unavailable,
    busy,
    notice,
    signInWithLink: handleLinkClick,
  };
}
