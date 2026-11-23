import {
  clearClockTimeout,
  getRuntimeDisplayName,
  runtimeAuthRuntimeFor,
  runtimeAuthSignsInPerProvider,
  setClockTimeout,
} from "@botiverse/raft-shared";
import type { RuntimeAccountUsageProvider, RuntimeAuthSignedInProvider, RuntimeLimitResetIdempotencyKey } from "@botiverse/raft-shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useMachineRuntimeReadiness } from "../../utils/readinessCopy";
import type {
  RuntimeAccountUsageClient,
  RuntimeAccountUsageReadResult,
} from "../../utils/runtimeAccountUsageClient";
import { runtimeAuthStatusOf, runtimeUpdateOf } from "../../utils/runtimeAuthClient";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import { RuntimeProviderConnectDialog } from "../../features/computer/RuntimeProviderConnectDialog";
import { RuntimeSignInDialog } from "../../features/computer/RuntimeSignInDialog";
import { PiSignInDialog } from "../../features/computer/PiSignInDialog";
import { RuntimeSignOutDialog } from "../../features/computer/RuntimeSignOutDialog";
import { RuntimeLimitResetDialog } from "../../features/computer/RuntimeLimitResetDialog";
import { limitResetNoteMessageId, limitResetOutcomeIsSettled } from "../../features/computer/limitResetOutcome";
import type { RuntimeLimitResetOutcome } from "../../features/computer/limitResetOutcome";
import { forgetLimitResetAttemptKey, limitResetAttemptKey } from "../../features/computer/limitResetAttemptKey";
import { useClaudeLimitResets } from "../../features/computer/useClaudeLimitResets";
import { useOfferedRuntimeUpgrade } from "../../features/computer/useRuntimeUpgrade";
import { hasProviderKey } from "./runtimeProviderKey";
import { useRuntimeAuthView } from "./useRuntimeAuthView";
import { RuntimeUsageSurface } from "./RuntimeUsageSurface";
import type { SurfaceAuth, SurfaceLimitReset, SurfaceRefreshState } from "./RuntimeUsageSurface";
import { usageOnCredits } from "./runtimeUsageCredits";
import { limitResetOffer } from "./limitResetOffer";

const POST_REFRESH_READ_DELAY_MS = 1_200;
const POST_REFRESH_MAX_READ_ATTEMPTS = 8;
/** After a sign-in: about the server's relay budget for a usage read (25 s). */
const SIGN_IN_MAX_READ_ATTEMPTS = 21;

export interface RuntimeUsageCardSubject {
  runtimeId: string;
  /** Null for a runtime with no usage to read (Qoder): the card shows its sign-in alone. */
  provider: RuntimeAccountUsageProvider | null;
  runtimeVersion?: string | null;
  serverId: string;
  machineId: string;
  client: RuntimeAccountUsageClient;
  authClient: RuntimeAuthClient;
}

export type RuntimeUsageCardProps = Omit<RuntimeUsageCardSubject, "client" | "authClient"> & {
  client?: RuntimeAccountUsageClient;
  authClient?: RuntimeAuthClient;
};

/**
 * The usage card's own state for one runtime on one Computer: the cached
 * snapshot (read on mount, a bounded refresh when it is stale or missing),
 * the manual Refresh and its follow-up reads, and the sign-in state with its
 * dialogs. Every place that shows the card (the runtime chip, a rack meter,
 * the rack's list of cards) draws it from here, so they all behave alike.
 */
export function useRuntimeUsageCard({
  runtimeId,
  provider,
  runtimeVersion,
  serverId,
  machineId,
  client,
  authClient,
  visible,
  onClose,
  onAuthDialog,
}: RuntimeUsageCardSubject & {
  /** The card is on screen: only then does the refresh countdown tick. */
  visible: boolean;
  /** The card's close button; a card without one has no close of its own. */
  onClose?: () => void;
  /** A sign-in or sign-out dialog takes over from the card. */
  onAuthDialog?: () => void;
}) {
  const authRuntime = runtimeAuthRuntimeFor(runtimeId);
  const readiness = useMachineRuntimeReadiness(machineId, runtimeId);
  const { view: authView, reread: rereadAuth } = useRuntimeAuthView(authClient, serverId, machineId, authRuntime !== null);
  const authStatus = authRuntime ? runtimeAuthStatusOf(authView, authRuntime) : null;
  const [authDialog, setAuthDialog] = useState<"signIn" | "signOut" | "connectProvider" | "limitReset" | null>(null);
  /** The one provider a per-provider runtime's (Pi's) Sign Out is for. */
  const [signOutProvider, setSignOutProvider] = useState<RuntimeAuthSignedInProvider | null>(null);
  const perProvider = authRuntime !== null && runtimeAuthSignsInPerProvider(authRuntime);
  const { formatMessage } = useIntl();
  // The subject a limit-reset key or note belongs to: another Computer or
  // provider in the same card never inherits either. The attempt's key
  // (limitResetAttemptKey) is kept while its outcome is unknown, so a retry
  // sends it again and never spends a second reset.
  const limitResetSubject = `${serverId}\0${machineId}\0${provider ?? ""}`;
  const [limitResetNote, setLimitResetNote] = useState<{ subject: string; text: string } | null>(null);
  const [limitResetTarget, setLimitResetTarget] = useState<{ subject: string; key: RuntimeLimitResetIdempotencyKey; account: string | null; resets: number } | null>(null);
  const [result, setResult] = useState<RuntimeAccountUsageReadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refreshState, setRefreshState] = useState<SurfaceRefreshState>("idle");
  // Task #704: the refresh window (2 minutes, shared by the panel's own
  // auto-refresh) drives the footer countdown. The remaining time is derived
  // during render from the client's window; the ticker only forces the
  // re-render that makes it drain, so it runs only while the card is shown.
  const [, setCooldownTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const ticker = setInterval(() => setCooldownTick((tick) => tick + 1), 1_000);
    return () => clearInterval(ticker);
  }, [visible, provider, serverId, machineId]);
  const cooldownLeftMs = provider ? client.refreshCooldownRemainingMs(serverId, machineId, provider) : 0;
  const rereadTimerRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const mountedRef = useRef(true);
  const pollGenerationRef = useRef(0);
  const subjectGenerationRef = useRef(0);

  const readSnapshot = useCallback(async (subjectGeneration = subjectGenerationRef.current) => {
    if (!provider) return null;
    setLoading(true);
    setLoadError(false);
    try {
      const next = await client.read(serverId, machineId, provider);
      if (mountedRef.current && subjectGenerationRef.current === subjectGeneration) setResult(next);
      return next;
    } catch {
      if (mountedRef.current && subjectGenerationRef.current === subjectGeneration) setLoadError(true);
      return null;
    } finally {
      if (mountedRef.current && subjectGenerationRef.current === subjectGeneration) setLoading(false);
    }
  }, [client, machineId, provider, serverId]);

  /**
   * `afterSignIn`: reads after a sign-in nobody pressed Refresh for. They go on
   * until a snapshot newer than `replacing` (the one shown) lands, for as long
   * as the server's relay waits on a slow read, and end quietly either way.
   */
  const startFollowUpReads = useCallback((subjectGeneration = subjectGenerationRef.current, afterSignIn?: { replacing: string | undefined }) => {
    const maxAttempts = afterSignIn ? SIGN_IN_MAX_READ_ATTEMPTS : POST_REFRESH_MAX_READ_ATTEMPTS;
    const generation = ++pollGenerationRef.current;
    let attempt = 0;

    const scheduleNext = () => {
      if (
        !mountedRef.current
        || subjectGenerationRef.current !== subjectGeneration
        || pollGenerationRef.current !== generation
      ) return;
      if (attempt >= maxAttempts) {
        setRefreshState(afterSignIn ? "idle" : "unconfirmed");
        return;
      }
      if (rereadTimerRef.current) clearClockTimeout(rereadTimerRef.current);
      rereadTimerRef.current = setClockTimeout(() => {
        rereadTimerRef.current = null;
        attempt += 1;
        if (provider) client.invalidate(serverId, machineId, provider);
        void readSnapshot(subjectGeneration).then((next) => {
          if (
            !next
            || !mountedRef.current
            || subjectGenerationRef.current !== subjectGeneration
            || pollGenerationRef.current !== generation
          ) return;
          if (next.state === "fresh" && (!afterSignIn || next.snapshot?.collectedAt !== afterSignIn.replacing)) {
            setRefreshState("idle");
            return;
          }
          scheduleNext();
        });
      }, POST_REFRESH_READ_DELAY_MS);
    };

    scheduleNext();
  }, [client, machineId, provider, readSnapshot, serverId]);

  const requestBackgroundRefresh = useCallback(async (subjectGeneration = subjectGenerationRef.current) => {
    if (!provider) return;
    try {
      const refresh = await client.refresh(serverId, machineId, provider, "stale_or_missing");
      if (!mountedRef.current || subjectGenerationRef.current !== subjectGeneration) return;
      setRefreshState(refresh.state);
      if (refresh.state === "requested" || refresh.state === "cooldown") startFollowUpReads(subjectGeneration);
    } catch {
      if (mountedRef.current && subjectGenerationRef.current === subjectGeneration) {
        setRefreshState("computer_offline");
      }
    }
  }, [client, machineId, provider, serverId, startFollowUpReads]);

  useEffect(() => {
    const subjectGeneration = ++subjectGenerationRef.current;
    mountedRef.current = true;
    void readSnapshot(subjectGeneration).then((next) => {
      if (subjectGenerationRef.current !== subjectGeneration) return;
      if (next?.state === "stale" || next?.state === "missing") {
        void requestBackgroundRefresh(subjectGeneration);
      }
    });
    return () => {
      mountedRef.current = false;
      subjectGenerationRef.current += 1;
      pollGenerationRef.current += 1;
      if (rereadTimerRef.current) clearClockTimeout(rereadTimerRef.current);
    };
  }, [readSnapshot, requestBackgroundRefresh]);

  const refresh = useCallback(async () => {
    if (!provider) return;
    const subjectGeneration = subjectGenerationRef.current;
    setRefreshState("requesting");
    try {
      const next = await client.refresh(serverId, machineId, provider, "manual");
      if (!mountedRef.current || subjectGenerationRef.current !== subjectGeneration) return;
      // Manual refresh awaits the machine's reply through the server relay:
      // a `fresh` result carries the snapshot itself (the client has already
      // written it into the read cache), so surface it in place. The
      // follow-up polling below only serves legacy `requested` replies.
      if (next.state === "fresh") {
        if (next.snapshot) {
          setLoadError(false);
          setResult({ state: "fresh", snapshot: next.snapshot });
          setRefreshState("idle");
        } else {
          setRefreshState("unconfirmed");
        }
        return;
      }
      setRefreshState(next.state);
      if (next.accepted || next.state === "cooldown") startFollowUpReads(subjectGeneration);
    } catch {
      if (mountedRef.current && subjectGenerationRef.current === subjectGeneration) {
        setRefreshState("computer_offline");
      }
    }
  }, [client, machineId, provider, serverId, startFollowUpReads]);
  const handleRefresh = useCallback(() => {
    setLimitResetNote(null);
    void refresh();
  }, [refresh]);

  // A sign-in that just succeeded: the server asks the Computer for fresh
  // usage (relayRuntimeAuthLogin), so read again until a snapshot newer than
  // the one shown lands, rather than keep showing the signed-out one until
  // the next refresh (#oar-raft:#52).
  const shownCollectedAt = result?.snapshot?.collectedAt;
  const handleSignedIn = useCallback(() => {
    startFollowUpReads(subjectGenerationRef.current, { replacing: shownCollectedAt });
  }, [shownCollectedAt, startFollowUpReads]);

  // The account whose reset the button spends (Codex reports one account):
  // the Computer's default one, never an agent's own folder's (`agentIds`).
  // Claude's resets are used by kind (useClaudeLimitResets), never through this kind-less action.
  const resetAccount = provider && provider !== "claude" && result && result.snapshot !== null
    ? result.snapshot.accounts.find((account) => account.agentIds === undefined && (account.limitResetsAvailable ?? 0) > 0) ?? null
    : null;
  const openLimitReset = useCallback(() => {
    if (!resetAccount) return;
    // Fixed for the dialog's life: the usage read after an outcome may change the count under it.
    setLimitResetTarget({
      subject: limitResetSubject,
      key: limitResetAttemptKey(limitResetSubject),
      account: resetAccount.maskedLabel ?? resetAccount.displayName ?? null,
      resets: resetAccount.limitResetsAvailable ?? 0,
    });
    onAuthDialog?.();
    setAuthDialog("limitReset");
  }, [limitResetSubject, onAuthDialog, resetAccount]);
  // Never assume the limits recovered: show the usage the Computer read
  // right after the redeem, or read it again.
  const showUsageAfterReset = useCallback((outcome: RuntimeLimitResetOutcome) => {
    if (!provider) return;
    if (outcome.snapshot) {
      client.storeSnapshot(serverId, machineId, provider, outcome.snapshot);
      pollGenerationRef.current += 1;
      setLoadError(false);
      setResult({ state: "fresh", snapshot: outcome.snapshot });
      setRefreshState("idle");
    } else {
      void refresh();
    }
  }, [client, machineId, provider, refresh, serverId]);
  const handleLimitResetOutcome = useCallback((outcome: RuntimeLimitResetOutcome) => {
    if (limitResetOutcomeIsSettled(outcome.result)) forgetLimitResetAttemptKey(limitResetSubject);
    const noteId = outcome.result ? limitResetNoteMessageId(outcome.result) : null;
    setLimitResetNote(noteId ? { subject: limitResetSubject, text: formatMessage({ id: noteId }) } : null);
    showUsageAfterReset(outcome);
  }, [formatMessage, limitResetSubject, showUsageAfterReset]);
  const canActOnRuntimes = authView?.canAct === true && authView.availability === "ok";
  const noteClaude = useCallback((text: string) => setLimitResetNote({ subject: limitResetSubject, text }), [limitResetSubject]);
  // Claude limit resets by kind (claude_limit_reset_v2): the card's actions and their dialogs.
  const claude = useClaudeLimitResets({
    serverId, machineId, provider, result, authView, authStatus, canActOnRuntimes,
    limitResetSubject, authClient, onAuthDialog, refresh, showUsageAfterReset, onNote: noteClaude,
  });

  const surfaceLimitReset = useMemo<SurfaceLimitReset | null>(() => {
    if (!resetAccount || !canActOnRuntimes || authStatus?.kind === "logged_out") return null;
    const offer = limitResetOffer(resetAccount);
    return offer ? { primary: offer.primary, onUse: openLimitReset, onCredits: usageOnCredits(resetAccount) && resetAccount.windows.some((window) => window.status === "limit_reached") } : null;
  }, [authStatus?.kind, canActOnRuntimes, openLimitReset, resetAccount]);
  const note = limitResetNote?.subject === limitResetSubject ? limitResetNote.text : null;
  // The dialog takes over from the card: close the card so it does not float above it.
  const openSignIn = useCallback(() => {
    onAuthDialog?.();
    setAuthDialog("signIn");
  }, [onAuthDialog]);
  const openSignOut = useCallback(() => {
    onAuthDialog?.();
    setSignOutProvider(null);
    setAuthDialog("signOut");
  }, [onAuthDialog]);
  const openSignOutProvider = useCallback((target: RuntimeAuthSignedInProvider) => {
    onAuthDialog?.();
    setSignOutProvider(target);
    setAuthDialog("signOut");
  }, [onAuthDialog]);
  const openConnectProvider = useCallback(() => {
    onAuthDialog?.();
    setAuthDialog("connectProvider");
  }, [onAuthDialog]);
  const closeAuthDialog = useCallback(() => setAuthDialog(null), []);
  const surfaceUpgrade = useOfferedRuntimeUpgrade(authClient, serverId, machineId, authRuntime, authView);
  const surfaceAuth = useMemo<SurfaceAuth | null>(
    () => (authRuntime && authView
      ? { runtime: authRuntime, status: authStatus, view: authView, onSignIn: openSignIn, onSignOut: openSignOut, onConnectProvider: openConnectProvider, onSignOutProvider: openSignOutProvider, upgrade: surfaceUpgrade, update: runtimeUpdateOf(authView, authRuntime) }
      : null),
    [authRuntime, authStatus, authView, openConnectProvider, openSignIn, openSignOut, openSignOutProvider, surfaceUpgrade],
  );

  const surface = (
    <RuntimeUsageSurface
      runtimeId={runtimeId}
      provider={provider}
      runtimeVersion={runtimeVersion}
      result={result}
      loading={loading}
      loadError={loadError}
      refreshState={refreshState}
      cooldownLeftMs={cooldownLeftMs}
      onRefresh={handleRefresh}
      onClose={onClose}
      auth={surfaceAuth}
      runtimeName={getRuntimeDisplayName(runtimeId)}
      limitReset={surfaceLimitReset}
      claudeLimitReset={claude.surface}
      note={note}
      readiness={readiness}
    />
  );
  const authDialogs = authRuntime ? (
    <>
      {authDialog === "signIn" && perProvider && (
        <PiSignInDialog
          serverId={serverId}
          machineId={machineId}
          runtimeId={runtimeId}
          runtime={authRuntime}
          client={authClient}
          onClose={closeAuthDialog}
        />
      )}
      {authDialog === "signIn" && !perProvider && (
        <RuntimeSignInDialog
          serverId={serverId}
          machineId={machineId}
          runtimeId={runtimeId}
          runtime={authRuntime}
          client={authClient}
          onClose={closeAuthDialog}
          onSignedIn={handleSignedIn}
        />
      )}
      {authDialog === "signOut" && (!perProvider || signOutProvider) && (
        <RuntimeSignOutDialog
          serverId={serverId}
          machineId={machineId}
          runtimeId={runtimeId}
          runtime={authRuntime}
          client={authClient}
          onClose={closeAuthDialog}
          {...(perProvider && signOutProvider ? { provider: signOutProvider } : {})}
        />
      )}
      {authDialog === "connectProvider" && (
        <RuntimeProviderConnectDialog
          serverId={serverId}
          machineId={machineId}
          runtimeId={runtimeId}
          runtime={authRuntime}
          client={authClient}
          onClose={closeAuthDialog}
        />
      )}
      {authDialog === "limitReset" && provider && limitResetTarget?.subject === limitResetSubject && (
        <RuntimeLimitResetDialog
          serverId={serverId}
          machineId={machineId}
          runtimeId={runtimeId}
          provider={provider}
          account={limitResetTarget.account}
          resetsAvailable={limitResetTarget.resets}
          idempotencyKey={limitResetTarget.key}
          client={authClient}
          onOutcome={handleLimitResetOutcome}
          onClose={closeAuthDialog}
        />
      )}
      {claude.dialogs}
    </>
  ) : null;
  // Signed out on the Computer; a provider-key runtime's presence-only "not configured" does not count,
  // nor Pi with no stored sign-in (a key in the environment or its models.json may still serve it).
  const signedOut = authStatus?.kind === "logged_out" && authRuntime !== null && !hasProviderKey(authRuntime) && !perProvider;
  return { result, authRuntime, authStatus, signedOut, readSnapshot, rereadAuth, surface, authDialogs };
}
