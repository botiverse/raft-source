import { Card, Badge, Drawer, DrawerContent, Status, ScrollArea } from "@botiverse/raft-ui";
import { usageProviderForRuntime } from "../../utils/runtimeUsageProvider";
import {
  clearClockTimeout,
  getRuntimeDisplayName,
  isRuntimeAuthServerGated,
  runtimeAuthRuntimeFor,
  runtimeAuthSignsInPerProvider,
  setClockTimeout,
} from "@botiverse/raft-shared";
import type { RuntimeAccountUsageProvider, RuntimeAuthSignedInProvider, RuntimeLimitResetIdempotencyKey } from "@botiverse/raft-shared";
import { formatReadiness, readinessHolds, useMachineRuntimeReadiness } from "../../utils/readinessCopy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { runtimeAccountUsageClient } from "../../utils/runtimeAccountUsageClient";
import type {
  RuntimeAccountUsageClient,
  RuntimeAccountUsageReadResult,
} from "../../utils/runtimeAccountUsageClient";
import { runtimeAuthClient, runtimeAuthComputerSupports, runtimeAuthStatusOf } from "../../utils/runtimeAuthClient";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import { useViewportClamp } from "../layout/useViewportClamp";
import { dismissLayerProps, notDismissLayerProps } from "../ui/dismissLayer";
import { RuntimeProviderConnectDialog } from "../../features/computer/RuntimeProviderConnectDialog";
import { RuntimeSignInDialog } from "../../features/computer/RuntimeSignInDialog";
import { PiSignInDialog } from "../../features/computer/PiSignInDialog";
import { RuntimeSignOutDialog } from "../../features/computer/RuntimeSignOutDialog";
import { RuntimeLimitResetDialog } from "../../features/computer/RuntimeLimitResetDialog";
import { limitResetNoteMessageId, limitResetOutcomeIsSettled } from "../../features/computer/limitResetOutcome";
import type { RuntimeLimitResetOutcome } from "../../features/computer/limitResetOutcome";
import { forgetLimitResetAttemptKey, limitResetAttemptKey } from "../../features/computer/limitResetAttemptKey";
import { useClaudeLimitResets } from "../../features/computer/useClaudeLimitResets";
import { useShortcutLayer } from "../../features/shortcuts/useShortcutLayer";
import { useOverlayLayer } from "../ui/useOverlayLayer";
import { hasProviderKey } from "./runtimeProviderKey";
import { useRuntimeAuthView } from "./useRuntimeAuthView";

export { useRuntimeAuthView };
import { RuntimeUsageSurface } from "./RuntimeUsageSurface";
import type { SurfaceAuth, SurfaceLimitReset, SurfaceRefreshState } from "./RuntimeUsageSurface";


const HOVER_OPEN_DELAY_MS = 200;
const HOVER_CLOSE_DELAY_MS = 160;
const POST_REFRESH_READ_DELAY_MS = 1_200;
const POST_REFRESH_MAX_READ_ATTEMPTS = 8;

type RuntimeBadgeAppearance = Pick<ComponentProps<typeof Badge>, "appearance" | "variant">;

function isAttention(result: RuntimeAccountUsageReadResult): boolean {
  if (result.snapshot === null || result.state === "stale") return result.state === "stale";
  return result.snapshot.accounts.some((account) =>
    account.health !== "ok" || account.windows.some((window) => window.status !== "ok"),
  );
}

/**
 * Runtime labels are RUI badges in both their inert and interactive states.
 * Keep the consumer's visual overrides, but let the primitive own the inline
 * flex layout so the label and health indicator share one cross-axis.
 */
function runtimeBadgeClassName(className: string): string {
  return `${className} inline-flex items-center`;
}

interface RuntimeUsageCardSubject {
  runtimeId: string;
  /** Null for a runtime with no usage to read (Qoder): the card shows its sign-in alone. */
  provider: RuntimeAccountUsageProvider | null;
  runtimeVersion?: string | null;
  serverId: string;
  machineId: string;
  client: RuntimeAccountUsageClient;
  authClient: RuntimeAuthClient;
}

type RuntimeUsageCardProps = Omit<RuntimeUsageCardSubject, "client" | "authClient"> & {
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
function useRuntimeUsageCard({
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

  const startFollowUpReads = useCallback((subjectGeneration = subjectGenerationRef.current) => {
    const generation = ++pollGenerationRef.current;
    let attempt = 0;

    const scheduleNext = () => {
      if (
        !mountedRef.current
        || subjectGenerationRef.current !== subjectGeneration
        || pollGenerationRef.current !== generation
      ) return;
      if (attempt >= POST_REFRESH_MAX_READ_ATTEMPTS) {
        setRefreshState("unconfirmed");
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
          if (next.state === "fresh") {
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

  // The account whose reset the button spends (Codex reports one account).
  // Claude's resets are used by kind (useClaudeLimitResets), never through this kind-less action.
  const resetAccount = provider && provider !== "claude" && result && result.snapshot !== null
    ? result.snapshot.accounts.find((account) => (account.limitResetsAvailable ?? 0) > 0) ?? null
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
  // Claude limit resets by kind (claude_limit_reset): the card's actions and their dialogs.
  const claude = useClaudeLimitResets({
    serverId, machineId, provider, result, authView, authStatus, canActOnRuntimes,
    limitResetSubject, authClient, onAuthDialog, refresh, showUsageAfterReset, onNote: noteClaude,
  });

  const surfaceLimitReset = useMemo<SurfaceLimitReset | null>(
    () => (resetAccount && canActOnRuntimes && authStatus?.kind !== "logged_out"
      ? {
          primary: resetAccount.health === "rate_limited" || resetAccount.windows.some((window) => window.status === "limit_reached"),
          onUse: openLimitReset,
        }
      : null),
    [authStatus?.kind, canActOnRuntimes, openLimitReset, resetAccount],
  );
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
  const surfaceAuth = useMemo<SurfaceAuth | null>(
    () => (authRuntime && authView
      ? { runtime: authRuntime, status: authStatus, view: authView, onSignIn: openSignIn, onSignOut: openSignOut, onConnectProvider: openConnectProvider, onSignOutProvider: openSignOutProvider }
      : null),
    [authRuntime, authStatus, authView, openConnectProvider, openSignIn, openSignOut, openSignOutProvider],
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

/** What a card's trigger gets: wire these onto the trigger element. */
export interface RuntimeUsageTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  "aria-haspopup": "dialog";
  "aria-expanded": boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onClick: () => void;
}

/** What the card knows, for a trigger that shows it. */
export interface RuntimeUsageTriggerState {
  result: RuntimeAccountUsageReadResult | null;
  /** Signed out on the Computer. */
  signedOut: boolean;
  /** Signed out, stale, or an account or window not ok. */
  attention: boolean;
}

/**
 * The usage card as a hover card on a trigger the caller draws: hover opens
 * it after 200ms and leaving closes it 160ms later, focus opens it, a click
 * pins it (outside press or Escape closes). On a phone a tap opens it as a
 * bottom sheet. The runtime chip and the rack's usage meters are its triggers.
 */
export function RuntimeUsageHoverCard({
  renderTrigger,
  client = runtimeAccountUsageClient,
  authClient = runtimeAuthClient,
  ...rest
}: RuntimeUsageCardProps & {
  renderTrigger: (props: RuntimeUsageTriggerProps, state: RuntimeUsageTriggerState) => ReactNode;
}) {
  const { formatMessage } = useIntl();
  const subject = { ...rest, client, authClient };
  const { machineId, provider, serverId, runtimeId } = subject;
  const mobile = useMediaQuery("(max-width: 767px)");
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const pinnedRef = useRef(false);
  // Render-side mirror of pinnedRef: only a PINNED card is an outside-press
  // dismiss layer. Hover / focus-open closes on mouse-out, and the card keeps
  // role="dialog" in both states, so the unpinned card must opt OUT explicitly
  // (data-dismiss-layer="false") or a host's role fallback would treat it as an
  // open layer while the user merely hovers.
  //
  // The pin's identity is the SUBJECT the effect below re-keys on — client,
  // machineId, provider, serverId (the transitive deps of the card's reads) —
  // the very same rule that resets pinnedRef there.
  // The pin stores the subject it was made under; during render any difference
  // (a machine switch, an A→B→A round trip, a client swap alone) invalidates it
  // and clears the stored pin (React's documented "adjust state during render"
  // for prop-driven resets), so a stale pin can never come back and the marker
  // and the ref never disagree. No Effect adjusts state.
  const [pinnedFor, setPinnedFor] = useState<{ client: typeof client; machineId: string; provider: typeof provider; serverId: string } | null>(null);
  const pinned =
    pinnedFor !== null &&
    pinnedFor.client === client &&
    pinnedFor.machineId === machineId &&
    pinnedFor.provider === provider &&
    pinnedFor.serverId === serverId;
  if (pinnedFor !== null && !pinned) setPinnedFor(null);

  const { style: popoverStyle } = useViewportClamp({
    triggerRef,
    popoverRef,
    placement: "vertical-smart",
    open: open && !mobile,
    gutter: 8,
  });

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) clearClockTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  const cancelHoverOpen = useCallback(() => {
    if (openTimerRef.current) clearClockTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);
  const closeSurface = useCallback(() => {
    pinnedRef.current = false;
    setPinnedFor(null);
    cancelClose();
    cancelHoverOpen();
    setOpen(false);
  }, [cancelClose, cancelHoverOpen]);

  const card = useRuntimeUsageCard({ ...subject, visible: open, onClose: closeSurface, onAuthDialog: closeSurface });
  const { readSnapshot, rereadAuth } = card;

  useEffect(() => {
    pinnedRef.current = false;
    return () => {
      if (openTimerRef.current) clearClockTimeout(openTimerRef.current);
      if (closeTimerRef.current) clearClockTimeout(closeTimerRef.current);
    };
  }, [client, machineId, provider, serverId]);

  const closeSoon = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setClockTimeout(() => {
      if (!pinnedRef.current) setOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  }, [cancelClose]);
  const openNow = useCallback(() => {
    cancelClose();
    setOpen(true);
    void readSnapshot();
    rereadAuth();
  }, [cancelClose, readSnapshot, rereadAuth]);
  const pinOpen = useCallback(() => {
    pinnedRef.current = true;
    setPinnedFor({ client, machineId, provider, serverId });
    openNow();
  }, [client, machineId, openNow, provider, serverId]);
  const openAfterHover = useCallback(() => {
    cancelClose();
    if (openTimerRef.current) clearClockTimeout(openTimerRef.current);
    openTimerRef.current = setClockTimeout(openNow, HOVER_OPEN_DELAY_MS);
  }, [cancelClose, openNow]);
  const handleMouseEnter = useCallback(() => {
    if (!mobile) openAfterHover();
  }, [mobile, openAfterHover]);
  const handleMouseLeave = useCallback(() => {
    if (mobile) return;
    cancelHoverOpen();
    closeSoon();
  }, [cancelHoverOpen, closeSoon, mobile]);
  const handleFocus = useCallback(() => {
    if (!mobile) openNow();
  }, [mobile, openNow]);
  const handleBlur = useCallback(() => {
    if (!mobile) closeSoon();
  }, [closeSoon, mobile]);

  useEffect(() => {
    if (!open || mobile) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pinnedRef.current) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      closeSurface();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [closeSurface, mobile, open]);
  // Esc closes only this surface, and only while it is pinned: a layer on the registry's stack while open.
  useShortcutLayer("menu", open && !mobile, { onEscape: () => (pinnedRef.current ? void closeSurface() : false), ignoreDefaultPrevented: true });
  // On a phone the card is a raft-ui bottom sheet (Drawer): Base UI's Esc, scrim press, swipe down, focus trap and
  // return; a modal layer of the shortcut registry while it is open.
  const sheetOpen = open && mobile;
  useOverlayLayer(sheetOpen);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const handleSheetOpenChange = useCallback((next: boolean) => { if (!next) closeSurface(); }, [closeSurface]);

  // Signed out on the Computer is attention even when the last usage looked fine.
  const { signedOut } = card;
  const attention = signedOut || (card.result ? isAttention(card.result) : false);

  const dialogLabel = formatMessage(
    {
      id: provider
        ? "machine.runtimeUsage.dialogLabel"
        : card.authRuntime && hasProviderKey(card.authRuntime) ? "machine.runtimeAuth.provider.dialogLabel" : "machine.runtimeAuth.dialogLabel",
    }, { runtime: getRuntimeDisplayName(runtimeId) });
  return (
    <>
      {renderTrigger({
        ref: triggerRef,
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave,
        onFocus: handleFocus,
        onBlur: handleBlur,
        onClick: pinOpen,
      }, { result: card.result, signedOut, attention })}
      {card.authDialogs}
      <Drawer open={sheetOpen} swipeDirection="down" onOpenChange={handleSheetOpenChange}>
        {/* Named by the card's label, once, on the sheet (the card has its own head and close). Focus starts on the sheet itself, as
            before, not on the card's first button. The card scrolls in a raft-ui ScrollArea under the sheet's
            handle, as the desktop popover's does. */}
        <DrawerContent ref={sheetRef} initialFocus={sheetRef} aria-label={dialogLabel} data-testid="runtime-usage-sheet">
          <ScrollArea className="min-h-0 flex-1">{card.surface}</ScrollArea>
        </DrawerContent>
      </Drawer>
      {open && !mobile && createPortal(
        <Card
          ref={popoverRef}
          {...(pinned ? dismissLayerProps : notDismissLayerProps)}
          role="dialog"
          aria-label={dialogLabel}
          // A floating surface (Raft DS Popover): popover layer, seam edge, float shadow (the
          // card recipe alone is an in-flow card). It frames the ScrollArea that scrolls.
          className="z-popup w-[min(390px,calc(100vw-16px))] border-line-seam bg-layer-popover shadow-float"
          style={popoverStyle}
          onMouseEnter={cancelClose}
          onMouseLeave={closeSoon}
        >
          <ScrollArea role="region" aria-label={dialogLabel} className="min-h-0 flex-1">{card.surface}</ScrollArea>
        </Card>,
        document.body,
      )}
    </>
  );
}

/**
 * The usage card in place, without a trigger or a close of its own: the
 * rack's list of every runtime's card on a Computer.
 */
export function RuntimeUsageCard({
  client = runtimeAccountUsageClient,
  authClient = runtimeAuthClient,
  ...subject
}: RuntimeUsageCardProps) {
  const card = useRuntimeUsageCard({ ...subject, client, authClient, visible: true });
  return (
    <>
      {card.surface}
      {card.authDialogs}
    </>
  );
}

export default function RuntimeAccountUsageChip({
  runtimeId,
  runtimeVersion,
  serverId,
  machineId,
  children,
  className = "",
  appearance = "solid",
  variant = "default",
  client = runtimeAccountUsageClient,
  authClient = runtimeAuthClient,
}: {
  runtimeId: string;
  runtimeVersion?: string | null;
  serverId: string;
  machineId: string;
  children: ReactNode;
  className?: string;
  client?: RuntimeAccountUsageClient;
  authClient?: RuntimeAuthClient;
} & RuntimeBadgeAppearance) {
  const { formatMessage } = useIntl();
  // A runtime the server offers only where its flag revives it (Antigravity)
  // gets a card (its usage too) only once the server lists it for this
  // Computer: elsewhere its badge stays as it was. The read is the card's own, cached per Computer.
  const authRuntime = runtimeAuthRuntimeFor(runtimeId);
  const serverGated = authRuntime !== null && isRuntimeAuthServerGated(authRuntime);
  const { view: gateView } = useRuntimeAuthView(authClient, serverId, machineId, serverGated);
  const offered = authRuntime !== null && (!serverGated || (gateView !== null && runtimeAuthComputerSupports(gateView, authRuntime)));
  const provider = serverGated && !offered ? null : usageProviderForRuntime(runtimeId);
  // #proj-raft-computer:#68: a runtime that can't work here reads its readiness first; usage stays in the card.
  const readiness = useMachineRuntimeReadiness(machineId, runtimeId);
  const held = readinessHolds(readiness);
  const readinessSuffix = held ? formatMessage({ id: "readiness.runtimeSuffix" }, { title: formatReadiness(formatMessage, readiness, runtimeId).title }) : "";
  const renderTrigger = useCallback((trigger: RuntimeUsageTriggerProps, { result, signedOut, attention }: RuntimeUsageTriggerState) => {
    const name = typeof children === "string" ? children : getRuntimeDisplayName(runtimeId);
    // Signed out on the Computer: an orange chip that says so in words. A
    // status light is for presence and task status, not for a runtime's
    // sign-in (Raft DS Status), so this chip carries no dot.
    const signedOutSuffix = readinessSuffix ? "" : signedOut ? formatMessage({ id: "runtime.availability.notSignedIn" }) : "";
    const warn = Boolean(readinessSuffix) || signedOut;
    return (
      <Badge
        {...trigger}
        render={<button type="button" />}
        appearance={appearance}
        variant={warn ? "warning" : variant}
        className={`${runtimeBadgeClassName(className)} relative cursor-help outline-none focus-visible:shadow-focus`}
        aria-label={name + (readinessSuffix || signedOutSuffix)}
        data-signed-out={signedOut ? "" : undefined}
        data-readiness-code={held ? readiness.primary?.code ?? "hidden" : undefined}
      >
        {children}
        {readinessSuffix || signedOutSuffix}
        {!warn && result !== null && result.snapshot !== null && (
          <Status
            data-testid={`runtime-usage-health-${provider}`}
            size="sm"
            variant={attention ? "warning" : "success"}
            className="ml-1"
            aria-label={formatMessage({ id: attention ? "machine.runtimeUsage.attention" : "machine.runtimeUsage.healthy" })}
          />
        )}
      </Badge>
    );
  }, [appearance, children, className, formatMessage, held, provider, readiness, readinessSuffix, runtimeId, variant]);
  // A runtime with neither usage nor a sign-in offered here has no card.
  if (!provider && !offered) {
    return <Badge appearance={appearance} variant={held ? "warning" : variant} className={runtimeBadgeClassName(className)} data-readiness-code={held ? readiness.primary?.code ?? "hidden" : undefined}>{children}{readinessSuffix}</Badge>;
  }
  return (
    <RuntimeUsageHoverCard
      runtimeId={runtimeId}
      provider={provider}
      runtimeVersion={runtimeVersion}
      serverId={serverId}
      machineId={machineId}
      client={client}
      authClient={authClient}
      renderTrigger={renderTrigger}
    />
  );
}

export function RuntimeAccountUsageGateChip({
  enabled,
  runtimeId,
  runtimeVersion,
  serverId,
  machineId,
  children,
  className = "",
  appearance = "solid",
  variant = "default",
  client,
  authClient,
}: {
  enabled: boolean;
  runtimeId: string;
  runtimeVersion?: string | null;
  serverId: string | null;
  machineId: string;
  children: ReactNode;
  className?: string;
  client?: RuntimeAccountUsageClient;
  authClient?: RuntimeAuthClient;
} & RuntimeBadgeAppearance) {
  if (!enabled || !serverId) {
    return (
      <Badge appearance={appearance} variant={variant} className={runtimeBadgeClassName(className)}>
        {children}
      </Badge>
    );
  }
  return (
    <RuntimeAccountUsageChip
      runtimeId={runtimeId}
      runtimeVersion={runtimeVersion}
      serverId={serverId}
      machineId={machineId}
      className={className}
      appearance={appearance}
      variant={variant}
      client={client}
      authClient={authClient}
    >
      {children}
    </RuntimeAccountUsageChip>
  );
}

