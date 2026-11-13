import { PAYWALL_VIEWER_ROLES } from "@botiverse/raft-shared";
import type { BillingEntry, PlanBillingDialog } from "@botiverse/raft-shared";
import { useServerStore } from "../store/serverStore";
import { trackEvent } from "./track";

// Plan & Billing's dialogs (cindyz, 2026-10-30, #proj-commercial:94664f92;
// names Nova): plan_billing_dialog_opened when the page's own button opens one,
// and at most one plan_billing_dialog_closed for it (none if the page goes away
// with it open, or another upgrade dialog replaces it). One is open at a time.
// A dialog the page did not open (a paywall's, or the upgrade dialog reopened
// on the way back from Stripe) records neither.
let current: { dialog: PlanBillingDialog; entry: BillingEntry } | null = null;

type ViewerRole = (typeof PAYWALL_VIEWER_ROLES)[number];

function viewer(): { serverId: string; viewer_role: ViewerRole } | null {
  const server = useServerStore.getState().current;
  if (!server?.id) return null;
  if (!(PAYWALL_VIEWER_ROLES as readonly string[]).includes(server.role ?? "")) return null;
  return { serverId: server.id, viewer_role: server.role as ViewerRole };
}

/** `entry`: what opened Plan & Billing (the paywall, else `settings`). */
export function trackPlanBillingDialogOpened(dialog: PlanBillingDialog, entry: BillingEntry): void {
  current = { dialog, entry };
  const who = viewer();
  if (!who) return;
  trackEvent("plan_billing_dialog_opened", { dialog, entry, viewer_role: who.viewer_role }, { serverId: who.serverId });
}

/**
 * `dialog` closed: `completed` (seats changed, the cancellation confirmed, off
 * to Stripe, an admin's message sent) or `dismissed` (closed without, also
 * after an error). Only for the one the page opened, and only once.
 */
export function trackPlanBillingDialogClosed(dialog: PlanBillingDialog, result: "completed" | "dismissed"): void {
  if (current?.dialog !== dialog) return;
  const { entry } = current;
  current = null;
  const who = viewer();
  if (!who) return;
  trackEvent("plan_billing_dialog_closed", { dialog, entry, viewer_role: who.viewer_role, result }, { serverId: who.serverId });
}
