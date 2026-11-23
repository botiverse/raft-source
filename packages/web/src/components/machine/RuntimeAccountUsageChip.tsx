import { Badge, Drawer, DrawerContent, Popover, PopoverContent, PopoverTrigger, Status, ScrollArea } from "@botiverse/raft-ui";
import { usageProviderForRuntime } from "../../utils/runtimeUsageProvider";
import {
  clearClockTimeout,
  getRuntimeDisplayName,
  runtimeAuthRuntimeFor,
  setClockTimeout,
} from "@botiverse/raft-shared";
import { formatReadiness, readinessHolds, useMachineRuntimeReadiness } from "../../utils/readinessCopy";
import { isValidElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, FocusEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { runtimeAccountUsageClient } from "../../utils/runtimeAccountUsageClient";
import type {
  RuntimeAccountUsageClient,
  RuntimeAccountUsageReadResult,
} from "../../utils/runtimeAccountUsageClient";
import { runtimeAuthClient } from "../../utils/runtimeAuthClient";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import { dismissLayerProps, notDismissLayerProps } from "../ui/dismissLayer";
import { useShortcutLayer } from "../../features/shortcuts/useShortcutLayer";
import { useOverlayLayer } from "../ui/useOverlayLayer";
import { hasProviderKey } from "./runtimeProviderKey";
import { useRuntimeAuthView } from "./useRuntimeAuthView";
import { useRuntimeUsageCard } from "./useRuntimeUsageCard";
import type { RuntimeUsageCardProps } from "./useRuntimeUsageCard";
import { usageAccountNeedsAttention } from "./runtimeUsageCredits";

export { useRuntimeAuthView };

const HOVER_OPEN_DELAY_MS = 200;
const HOVER_CLOSE_DELAY_MS = 160;

type RuntimeBadgeAppearance = Pick<ComponentProps<typeof Badge>, "appearance" | "variant">;

function isAttention(result: RuntimeAccountUsageReadResult): boolean {
  if (result.snapshot === null || result.state === "stale") return result.state === "stale";
  return result.snapshot.accounts.some(usageAccountNeedsAttention);
}

/**
 * Runtime labels are RUI badges in both their inert and interactive states.
 * Keep the consumer's visual overrides, but let the primitive own the inline
 * flex layout so the label and health indicator share one cross-axis.
 */
function runtimeBadgeClassName(className: string): string {
  return `${className} inline-flex items-center`;
}

type PopoverOpenChangeDetails = Parameters<NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>>[1];
type PopoverTriggerRenderProps = Parameters<
  Extract<NonNullable<ComponentProps<typeof PopoverTrigger>["render"]>, (...args: never[]) => unknown>
>[0];

/** What a card's trigger gets: wire these onto the trigger element. */
export type RuntimeUsageTriggerProps = PopoverTriggerRenderProps;

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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const hoverOpenTimerRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const suppressFocusTimerRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const pointerDownTimerRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const suppressFocusOpenRef = useRef(false);
  const pointerDownRef = useRef(false);

  const cancelHoverTimers = useCallback(() => {
    if (hoverOpenTimerRef.current) {
      clearClockTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
    if (hoverCloseTimerRef.current) {
      clearClockTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    cancelHoverTimers();
    if (suppressFocusTimerRef.current) {
      clearClockTimeout(suppressFocusTimerRef.current);
      suppressFocusTimerRef.current = null;
    }
    if (pointerDownTimerRef.current) {
      clearClockTimeout(pointerDownTimerRef.current);
      pointerDownTimerRef.current = null;
    }
  }, [cancelHoverTimers]);

  // Open/pin state keyed to the current subject (client, machineId, provider,
  // serverId): during render any subject change invalidates a previous hover or
  // pin (React's "adjust state during render" for prop-driven resets).
  // Retaining `mode` while `open` flips to `false` lets Base UI's
  // FloatingFocusManager see the closing card's pinned mode so `finalFocus`
  // returns keyboard focus to the trigger when a pinned card closes.
  // Only a PINNED card is an outside-press dismiss layer; hover / focus-open
  // keeps role="dialog" for accessibility while opting out explicitly via
  // data-dismiss-layer="false" so hosts do not treat a hovered card as an open
  // layer.
  const [cardState, setCardState] = useState<{
    open: boolean;
    mode: "hover" | "pinned";
    client: typeof client;
    machineId: string;
    provider: typeof provider;
    serverId: string;
  } | null>(null);
  const sameSubject =
    cardState !== null &&
    cardState.client === client &&
    cardState.machineId === machineId &&
    cardState.provider === provider &&
    cardState.serverId === serverId;
  if (cardState !== null && !sameSubject) setCardState(null);
  const open = sameSubject && cardState.open;
  const mode: "closed" | "hover" | "pinned" = open ? cardState.mode : "closed";
  const pinned = mode === "pinned";
  const returnFocusToTrigger = sameSubject && cardState.mode === "pinned";

  const suppressReturningFocus = useCallback(() => {
    suppressFocusOpenRef.current = true;
    if (suppressFocusTimerRef.current) clearClockTimeout(suppressFocusTimerRef.current);
    suppressFocusTimerRef.current = setClockTimeout(() => {
      suppressFocusTimerRef.current = null;
      suppressFocusOpenRef.current = false;
    }, 0);
  }, []);

  const closeSurface = useCallback(() => {
    cancelHoverTimers();
    if (pinned) suppressReturningFocus();
    setCardState((prev) => (prev && prev.open ? { ...prev, open: false } : prev));
  }, [cancelHoverTimers, pinned, suppressReturningFocus]);

  const closeForAuthDialog = useCallback(() => {
    cancelHoverTimers();
    setCardState(null);
  }, [cancelHoverTimers]);

  const card = useRuntimeUsageCard({ ...subject, visible: open, onClose: closeSurface, onAuthDialog: closeForAuthDialog });
  const { readSnapshot, rereadAuth } = card;

  const openCard = useCallback((nextMode: "hover" | "pinned") => {
    cancelHoverTimers();
    suppressFocusOpenRef.current = false;
    setCardState({ open: true, mode: nextMode, client, machineId, provider, serverId });
    void readSnapshot();
    rereadAuth();
  }, [cancelHoverTimers, client, machineId, provider, readSnapshot, rereadAuth, serverId]);

  const handlePopoverOpenChange = useCallback((next: boolean, details: PopoverOpenChangeDetails) => {
    pointerDownRef.current = false;
    if (next) {
      if (mobile) {
        details.cancel();
        openCard("pinned");
        return;
      }
      openCard("pinned");
      return;
    }
    // Clicking the trigger while hover/focus-open pins the card instead of
    // toggling it closed. Because hover is driven outside PopoverTrigger's
    // openOnHover, Base UI never locks openChangeReason to "trigger-hover" and
    // FloatingFocusManager stays active once pinned.
    if (mode === "hover" && details.reason === "trigger-press") {
      details.cancel();
      openCard("pinned");
      return;
    }
    if (pinned && details.reason === "focus-out") {
      details.cancel();
      return;
    }
    if (!pinned && details.reason === "escape-key") {
      details.cancel();
      details.allowPropagation();
      return;
    }
    if (!pinned && details.reason === "outside-press") {
      details.cancel();
      return;
    }
    closeSurface();
  }, [closeSurface, mobile, mode, openCard, pinned]);

  const handleTriggerPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (mobile || event.button !== 0) return;
    pointerDownRef.current = true;
    if (pointerDownTimerRef.current) clearClockTimeout(pointerDownTimerRef.current);
    pointerDownTimerRef.current = setClockTimeout(() => {
      pointerDownTimerRef.current = null;
      pointerDownRef.current = false;
    }, 0);
  }, [mobile]);

  const handleTriggerPointerEnter = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (mobile || event.pointerType === "touch") return;
    if (hoverCloseTimerRef.current) {
      clearClockTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    if (open || hoverOpenTimerRef.current) return;
    hoverOpenTimerRef.current = setClockTimeout(() => {
      hoverOpenTimerRef.current = null;
      openCard("hover");
    }, HOVER_OPEN_DELAY_MS);
  }, [mobile, open, openCard]);

  // A press inside a hover-opened card pins it: its account menu opens in a
  // portal outside the card, and a hover card closes on the pointer leaving
  // or focus moving there (#oar-raft:#52, the card vanished on "...").
  const handlePopoverPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (mobile || mode !== "hover" || event.button !== 0) return;
    // A control only: selecting text or scrolling leaves a hover card a hover card.
    if (!(event.target instanceof Element) || !event.target.closest("button, a, input, [role='menuitem']")) return;
    cancelHoverTimers();
    setCardState((state) => (state && state.open ? { ...state, mode: "pinned" } : state));
  }, [cancelHoverTimers, mobile, mode]);

  const handlePopoverPointerEnter = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (mobile || event.pointerType === "touch") return;
    if (hoverCloseTimerRef.current) {
      clearClockTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, [mobile]);

  const handleSurfacePointerLeave = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (mobile || event.pointerType === "touch") return;
    if (hoverOpenTimerRef.current) {
      clearClockTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
    if (mode !== "hover") return;
    if (hoverCloseTimerRef.current) clearClockTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = setClockTimeout(() => {
      hoverCloseTimerRef.current = null;
      closeSurface();
    }, HOVER_CLOSE_DELAY_MS);
  }, [closeSurface, mobile, mode]);

  const handleFocus = useCallback(() => {
    if (suppressFocusOpenRef.current) {
      suppressFocusOpenRef.current = false;
      return;
    }
    if (mobile || open || pointerDownRef.current) return;
    openCard("hover");
  }, [mobile, open, openCard]);

  const handleSurfaceBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    if (mobile || mode !== "hover") return;
    const next = event.relatedTarget;
    if (next instanceof Node && (popoverRef.current?.contains(next) || triggerRef.current?.contains(next))) return;
    closeSurface();
  }, [closeSurface, mobile, mode]);

  // Esc closes only this surface, and only while it is pinned: a layer on the registry's stack while open.
  useShortcutLayer("menu", open && !mobile, { onEscape: () => (pinned ? void closeSurface() : false), ignoreDefaultPrevented: true });
  // On a phone the card is a raft-ui bottom sheet (Drawer): Base UI's Esc, scrim press, swipe down, focus trap and
  // return; a modal layer of the shortcut registry while it is open.
  const desktopOpen = open && !mobile;
  const sheetOpen = open && mobile;
  useOverlayLayer(sheetOpen);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const handleSheetOpenChange = useCallback((next: boolean) => { if (!next) closeSurface(); }, [closeSurface]);

  // Signed out on the Computer is attention even when the last usage looked fine.
  const { signedOut } = card;
  const attention = signedOut || (card.result ? isAttention(card.result) : false);
  const triggerState = useMemo<RuntimeUsageTriggerState>(
    () => ({ result: card.result, signedOut, attention }),
    [attention, card.result, signedOut],
  );
  const renderPopoverTrigger = useCallback(
    (triggerProps: PopoverTriggerRenderProps) => {
      const element = renderTrigger(triggerProps, triggerState);
      return isValidElement(element) ? element : <button type="button" {...triggerProps} />;
    },
    [renderTrigger, triggerState],
  );

  const dialogLabel = formatMessage(
    {
      id: provider
        ? "machine.runtimeUsage.dialogLabel"
        : card.authRuntime && hasProviderKey(card.authRuntime) ? "machine.runtimeAuth.provider.dialogLabel" : "machine.runtimeAuth.dialogLabel",
    }, { runtime: getRuntimeDisplayName(runtimeId) });
  return (
    <>
      <Popover open={desktopOpen} onOpenChange={handlePopoverOpenChange}>
        <PopoverTrigger
          ref={triggerRef}
          aria-haspopup="dialog"
          aria-expanded={open}
          onPointerDown={handleTriggerPointerDown}
          onPointerEnter={handleTriggerPointerEnter}
          onPointerLeave={handleSurfacePointerLeave}
          onFocus={handleFocus}
          onBlur={handleSurfaceBlur}
          render={renderPopoverTrigger}
        />
        <PopoverContent
          ref={popoverRef}
          {...(pinned ? dismissLayerProps : notDismissLayerProps)}
          role="dialog"
          aria-label={dialogLabel}
          side="bottom"
          align="center"
          sideOffset={8}
          initialFocus={false}
          finalFocus={returnFocusToTrigger ? undefined : false}
          onPointerDownCapture={handlePopoverPointerDown}
          onPointerEnter={handlePopoverPointerEnter}
          onPointerLeave={handleSurfacePointerLeave}
          onBlur={handleSurfaceBlur}
          className="flex max-h-(--available-height) w-[min(390px,calc(100vw-16px))] flex-col p-0 [[data-anchor-hidden]_&]:invisible [[data-anchor-hidden]_&]:pointer-events-none"
        >
          <ScrollArea role="region" aria-label={dialogLabel} className="min-h-0 flex-1">{card.surface}</ScrollArea>
        </PopoverContent>
      </Popover>
      {card.authDialogs}
      <Drawer open={sheetOpen} swipeDirection="down" onOpenChange={handleSheetOpenChange}>
        {/* Named by the card's label, once, on the sheet (the card has its own head and close). Focus starts on the sheet itself, as
            before, not on the card's first button. The card scrolls in a raft-ui ScrollArea under the sheet's
            handle, as the desktop popover's does. */}
        <DrawerContent ref={sheetRef} initialFocus={sheetRef} aria-label={dialogLabel} data-testid="runtime-usage-sheet">
          <ScrollArea className="min-h-0 flex-1">{card.surface}</ScrollArea>
        </DrawerContent>
      </Drawer>
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
  const offered = runtimeAuthRuntimeFor(runtimeId) !== null;
  const provider = usageProviderForRuntime(runtimeId);
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
