import { useCallback, useRef, useState } from "react";
import { useIntl } from "react-intl";
import api from "../../api/client";
import { parseMethods } from "./secondFactorSignIn";
import type { SignInSecondFactorMethod } from "./secondFactorSignIn";
import { deviceLoginRedirect, isLoopbackCallbackUrl } from "../../pages/deviceLoginRedirect";
import { grantChoices, isKnownGrant, locatorOf } from "./deviceLoginApproval";
import type { DeviceLoginFailure, DeviceLoginRequest, GrantOutcome, RequestLocator } from "./deviceLoginApproval";

// Checking and approving one device login (POST /auth/device/describe, then
// /auth/device/approve with describe's approvalTicket), the same steps and
// errors wherever the code is typed: the device login page and Add Computer.
// The caller draws each step; this owns the calls and what they lead to.
// Add Computer's pairing shows a request it already has (`show`) and
// approves it through the pairing instead (docs/contracts/computer-pairing.md).

export type DeviceLoginStep =
  | { kind: "enter" }
  // Opened with `?request=`: describing it, before the confirm screen.
  | { kind: "opening" }
  | { kind: "confirm"; request: DeviceLoginRequest }
  // Two-step verification is on and this sign-in hasn't passed it: verify
  // first, then the same approval goes through (design v2 device-stepup).
  | { kind: "stepUp"; request: DeviceLoginRequest; pick: string | null; methods: SignInSecondFactorMethod[] }
  | { kind: "approved"; outcome: GrantOutcome | null }
  | { kind: "denied" };

export type DeviceLoginSubmitting = "describe" | "approve" | "deny" | null;

/** A pairing's approve refused for a reason of the pairing (a `computer_pairing_*` code) or any other failure; told to whoever showed the request. */
export type PairingApprovalRefused = (code: string | null) => void;

type FallbackId = "pages.deviceLogin.describeFailedFallback" | "pages.deviceLogin.approveFailedFallback" | "pages.deviceLogin.denyFailedFallback";

export function useDeviceLoginApproval(initialStep: () => DeviceLoginStep = () => ({ kind: "enter" })) {
  const { formatMessage } = useIntl();
  const [step, setStep] = useState<DeviceLoginStep>(initialStep);
  const [submitting, setSubmitting] = useState<DeviceLoginSubmitting>(null);
  // What went wrong, in words, and the server's code for it (null: no code).
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // The server or agent picked for a one-time grant; never defaulted.
  const [pickedId, setPickedId] = useState<string | null>(null);
  // Who showed a paired request (show): told when its approval is refused.
  const pairingRefusedRef = useRef<PairingApprovalRefused | null>(null);

  const fail = useCallback((message: string, code: string | null) => {
    setError(message);
    setErrorCode(code);
  }, []);
  const clearError = useCallback(() => fail("", null), [fail]);

  const showFailure = useCallback((err: DeviceLoginFailure, fallbackId: FallbackId) => {
    const code = err.response?.data?.code ?? null;
    if (code === "user_code_invalid") {
      fail(formatMessage({ id: "pages.deviceLogin.codeInvalid" }), code);
    } else if (code === "request_invalid") {
      fail(formatMessage({ id: "pages.deviceLogin.requestInvalid" }), code);
    } else if (code === "expired") {
      fail(formatMessage({ id: "pages.deviceLogin.codeExpired" }), code);
    } else if (code === "already_resolved") {
      fail(formatMessage({ id: "pages.deviceLogin.codeAlreadyUsed" }), code);
    } else {
      // Rate limited and anything else: the server's own words when it gave some.
      fail(err.response?.data?.error || formatMessage({ id: fallbackId }), code);
    }
  }, [fail, formatMessage]);

  const describe = useCallback(async (locator: RequestLocator, isCurrent: () => boolean = () => true) => {
    setSubmitting("describe");
    clearError();
    try {
      const { data } = await api.post<DeviceLoginRequest>("/auth/device/describe", locator);
      if (!isCurrent()) return;
      if (!isKnownGrant(data.grant)) {
        setStep({ kind: "enter" });
        fail(formatMessage({ id: "pages.deviceLogin.grantKindUnsupported" }), "grant_kind_unsupported");
        return;
      }
      setPickedId(null);
      setStep({ kind: "confirm", request: data });
    } catch (err) {
      if (!isCurrent()) return;
      setStep({ kind: "enter" });
      showFailure(err as DeviceLoginFailure, "pages.deviceLogin.describeFailedFallback");
    } finally {
      if (isCurrent()) setSubmitting(null);
    }
  }, [clearError, fail, formatMessage, showFailure]);

  const resolve = useCallback(async (request: DeviceLoginRequest, approve: boolean, pick: string | null) => {
    const { grant } = request;
    // A grant is approved only for an explicit pick (the button stays disabled
    // without one; the server refuses one anyway).
    if (approve && grant && !pick) return;
    setSubmitting(approve ? "approve" : "deny");
    clearError();
    const selection = approve && grant && pick
      ? (grant.kind === "agent_key" ? { agentId: pick } : { serverId: pick })
      : {};
    const locator = locatorOf(request);
    const { pairingId } = request;
    try {
      // A paired request: the pairing approves the request the server linked, for the pairing's server.
      const { data } = pairingId
        ? await api.post<{ redirectUrl?: unknown }>("/computer-pairings/approve", approve
          ? { pairingId, approve, approvalTicket: request.approvalTicket }
          : { pairingId, approve })
        : await api.post<{ redirectUrl?: unknown }>("/auth/device/approve", approve
          ? { ...locator, approve, approvalTicket: request.approvalTicket, ...selection }
          : { ...locator, approve });
      if (!approve) {
        setStep({ kind: "denied" });
      } else {
        const picked = grant && pick ? grantChoices(grant).find((choice) => choice.id === pick) : undefined;
        setStep({
          kind: "approved",
          outcome: grant && picked ? { kind: grant.kind, requesterName: grant.machineName, pickedName: picked.label } : null,
        });
      }
      // Loopback: back to the program on this computer, with the code (approved) or the denial.
      const redirectUrl = data?.redirectUrl;
      if (request.mode === "loopback" && isLoopbackCallbackUrl(redirectUrl)) deviceLoginRedirect.assign(redirectUrl);
    } catch (err) {
      const code = (err as DeviceLoginFailure).response?.data?.code ?? null;
      if (approve && code === "second_factor_step_up_required") {
        // Only for people with two-step verification on; the code stays pending.
        setStep({ kind: "stepUp", request, pick, methods: parseMethods((err as DeviceLoginFailure).response?.data?.methods) });
        return;
      }
      if (grant && (code === "grant_selection_required" || code === "grant_selection_not_allowed")) {
        // The code is still pending: stay here so the person can pick again.
        const server = grant.kind !== "agent_key";
        setPickedId(null);
        fail(formatMessage({
          id: code === "grant_selection_required"
            ? (server ? "pages.deviceLogin.serverSelectionRequired" : "pages.deviceLogin.agentSelectionRequired")
            : (server ? "pages.deviceLogin.serverSelectionNotAllowed" : "pages.deviceLogin.agentSelectionNotAllowed"),
        }), code);
        return;
      }
      // The code can't be approved any more (expired, used): back to typing one.
      setStep({ kind: "enter" });
      if (pairingId) {
        // The pairing itself ended (a second machine, closed, approved elsewhere):
        // the window that showed it makes a new command; its own words, not these.
        const refused = pairingRefusedRef.current;
        if (code?.startsWith("computer_pairing_")) {
          clearError();
          refused?.(code);
          return;
        }
        refused?.(code);
      }
      if (code === "grant_kind_unsupported") {
        fail(formatMessage({ id: "pages.deviceLogin.grantKindUnsupported" }), code);
        return;
      }
      showFailure(err as DeviceLoginFailure, approve ? "pages.deviceLogin.approveFailedFallback" : "pages.deviceLogin.denyFailedFallback");
    } finally {
      setSubmitting(null);
    }
  }, [clearError, fail, formatMessage, showFailure]);

  /** Approve the request on the confirm screen for `pick` (a grant's server or agent; null for a session). */
  const approve = useCallback((pick: string | null) => {
    if (step.kind === "confirm") void resolve(step.request, true, pick);
  }, [resolve, step]);
  const deny = useCallback(() => {
    if (step.kind === "confirm") void resolve(step.request, false, null);
  }, [resolve, step]);
  const pick = useCallback((value: string) => {
    setPickedId(value);
    clearError();
  }, [clearError]);
  /**
   * The confirm screen for a request the caller already has, with no describe
   * (Add Computer's pairing: its status carries describe's fields and ticket).
   */
  const show = useCallback((request: DeviceLoginRequest, onPairingRefused?: PairingApprovalRefused) => {
    pairingRefusedRef.current = onPairingRefused ?? null;
    clearError();
    setPickedId(null);
    setStep({ kind: "confirm", request });
  }, [clearError]);
  /** Leave the step-up for the confirm screen it came from, nothing approved. */
  const cancelStepUp = useCallback(() => {
    if (step.kind === "stepUp") setStep({ kind: "confirm", request: step.request });
  }, [step]);
  /** Back to an empty code field (Enter a different code). */
  const reset = useCallback(() => {
    clearError();
    setPickedId(null);
    setStep({ kind: "enter" });
  }, [clearError]);
  /** The step-up passed: the same approval, for the same pick. */
  const steppedUp = useCallback(async () => {
    if (step.kind !== "stepUp") return;
    setStep({ kind: "confirm", request: step.request });
    setPickedId(step.pick);
    await resolve(step.request, true, step.pick);
  }, [resolve, step]);

  return { step, submitting, error, errorCode, pickedId, describe, show, approve, deny, pick, reset, steppedUp, cancelStepUp };
}

export type DeviceLoginApproval = ReturnType<typeof useDeviceLoginApproval>;
