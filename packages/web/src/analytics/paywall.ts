// Which paywalls people meet and what they do next (paywall_shown /
// paywall_action, #proj-analytics:8fc671a3; Nova owns the registry). The
// server records paywall_hit where it refuses; these are what the web shows.
// Only paywalls: an upgrade dialog opened by an agent's card (`source`) or for
// no specific limit (`general`) sends neither.
import { useEffect } from "react";
import { PAYWALL_GATES, PAYWALL_PLANS, PAYWALL_VIEWER_ROLES } from "@botiverse/raft-shared";
import type { PaywallGate, PaywallSurface, UPLOAD_LIMIT_ENTRIES, UPLOAD_LIMITS, UPLOAD_SIZE_BANDS } from "@botiverse/raft-shared";
import { useServerStore } from "../store/serverStore";
import { trackEvent } from "./track";

type PaywallAction = "upgrade" | "view_billing" | "message_owner" | "dismiss";
type ViewerRole = (typeof PAYWALL_VIEWER_ROLES)[number];
type Plan = (typeof PAYWALL_PLANS)[number];

export function isPaywallGate(gate: string | null | undefined): gate is PaywallGate {
  return typeof gate === "string" && (PAYWALL_GATES as readonly string[]).includes(gate);
}

/**
 * Who meets it, on which plan (the plan as Plan & Billing reads it, billing
 * first); null when unknown. `serverId`: a server of theirs other than the
 * current one (a page outside the app upgrading it), read from their server list.
 */
function viewer(serverId?: string): { serverId: string; viewer_role: ViewerRole; plan: Plan } | null {
  const state = useServerStore.getState();
  if (serverId && serverId !== state.current?.id) {
    const server = state.servers.find((candidate) => candidate.id === serverId);
    return server ? viewerOn(server.id, server.role, server.plan) : null;
  }
  return viewerOn(state.current?.id, state.current?.role, state.billing?.plan || state.current?.plan);
}

function viewerOn(serverId: string | undefined, role: string | undefined, plan: string | undefined): { serverId: string; viewer_role: ViewerRole; plan: Plan } | null {
  if (!serverId) return null;
  if (!(PAYWALL_VIEWER_ROLES as readonly string[]).includes(role ?? "")) return null;
  if (!(PAYWALL_PLANS as readonly string[]).includes(plan ?? "")) return null;
  return { serverId, viewer_role: role as ViewerRole, plan: plan as Plan };
}

/**
 * Shown once per page session, server, paywall and surface (not on every
 * channel open): a gate met in several places (history_30d) counts each place
 * once, so the search page's notice doesn't hide the history card.
 */
const shownThisSession = new Set<string>();

export function trackPaywallShown(gate: PaywallGate, surface?: PaywallSurface, serverId?: string): void {
  const who = viewer(serverId);
  if (!who) return;
  const key = `${who.serverId}:${gate}:${surface ?? ""}`;
  if (shownThisSession.has(key)) return;
  shownThisSession.add(key);
  trackEvent("paywall_shown", { gate, viewer_role: who.viewer_role, plan: who.plan, ...(surface ? { surface } : {}) }, { serverId: who.serverId });
}

export function trackPaywallAction(gate: PaywallGate, action: PaywallAction, surface?: PaywallSurface, serverId?: string): void {
  const who = viewer(serverId);
  if (!who) return;
  trackEvent("paywall_action", { gate, viewer_role: who.viewer_role, action, ...(surface ? { surface } : {}) }, { serverId: who.serverId });
}

export type UploadLimit = (typeof UPLOAD_LIMITS)[number];
export type UploadLimitEntry = (typeof UPLOAD_LIMIT_ENTRIES)[number];

const MIB = 1024 * 1024;

function sizeBand(bytes: number): (typeof UPLOAD_SIZE_BANDS)[number] {
  if (bytes < 50 * MIB) return "under_50mb";
  if (bytes < 100 * MIB) return "50_100mb";
  if (bytes < 200 * MIB) return "100_200mb";
  return "200mb_plus";
}

/**
 * An upload limit met (upload_limit_hit, cindyz 2026-10-28): every time, for
 * each limit an action ran into, with where and what Raft did about it. The
 * web refuses these before any request, so paywall_hit no longer sees them.
 */
export function trackUploadLimitHit({ limit, entry, response, sizes }: {
  limit: UploadLimit;
  entry: UploadLimitEntry;
  response: "upgrade_dialog" | "kept_unattached";
  /** The refused files' sizes; empty for an attach button tapped with the month used up. */
  sizes: readonly number[];
}): void {
  const who = viewer();
  if (!who) return;
  trackEvent("upload_limit_hit", {
    limit,
    entry,
    response,
    viewer_role: who.viewer_role,
    plan: who.plan,
    files: sizes.length,
    ...(sizes.length > 0 ? { largest_size: sizeBand(Math.max(...sizes)) } : {}),
  }, { serverId: who.serverId });
}

/**
 * A paywall on screen: `gate` while it shows, null/false while it doesn't.
 * Waits for the server's role and plan, which can arrive after the first render.
 * `serverId`: the paywall is another server's of theirs (a page outside the
 * app), read from their server list.
 */
export function usePaywallShown(gate: PaywallGate | null | false | undefined, surface?: PaywallSurface, serverId?: string): void {
  // The server it is shown on, once its role and plan are known (a surface can
  // stay mounted across a server switch).
  const currentReadyId = useServerStore((state) => (
    state.current?.id && state.current?.role && (state.billing?.plan || state.current?.plan) ? state.current.id : null
  ));
  const currentId = useServerStore((state) => state.current?.id ?? null);
  const servers = useServerStore((state) => state.servers);
  const other = serverId && serverId !== currentId ? servers.find((candidate) => candidate.id === serverId) : undefined;
  // oxlint-disable-next-line react-doctor/no-event-handler -- Which server the paywall on screen is counted on; rendering is the event (below).
  const readyServerId = !serverId || serverId === currentId ? currentReadyId : other?.role && other.plan ? other.id : null;
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler -- Rendering is the event: the paywall reached the screen, which no handler observes.
    if (gate && readyServerId) trackPaywallShown(gate, surface, readyServerId);
  }, [gate, readyServerId, surface]);
}

/** The same, as an element to place inside a paywall's markup: it records when that markup renders. */
export function PaywallShown({ gate, surface, serverId }: { gate: PaywallGate; surface?: PaywallSurface; serverId?: string }): null {
  usePaywallShown(gate, surface, serverId);
  return null;
}

/** Test-only. */
export function resetPaywallShownForTest(): void {
  shownThisSession.clear();
}
