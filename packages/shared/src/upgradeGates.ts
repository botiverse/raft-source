// The Free limits whose Upgrade opens the web's upgrade dialog (Till's,
// packages/web/src/components/billing/UpgradeDialog.tsx), plus `general` for
// an upgrade that no specific limit asks for. One list for every package: the
// web's dialog store re-exports it, and an agent's `plan:upgrade` action card
// (actionCards.ts) names one of these gates (none means `general`). Kept
// apart without runtime imports, so the CLI's bundled action-card schema does
// not pull in the product-event registry.

import type { PaywallGate } from "./productEvents";

/** The gate for an upgrade no specific limit asks for (an agent's upgrade card without `gate`). */
export const GENERAL_UPGRADE_GATE = "general";

/**
 * Each one names what the person just ran into; the dialog's title, its first
 * Pro benefit and the message to the owner follow it. `general` names no
 * limit: the dialog says what Pro lifts overall.
 */
export const UPGRADE_GATES = [
  "history_30d",
  "upload_monthly_quota",
  "upload_file_size",
  "joint_channel_free_cap",
  "joint_channel_host_limit",
  "joint_channel_over_limit",
  "joint_channel_read_only",
  "agent_migration",
  "plan_downgraded",
  "pro_theme",
  // The Free plan's one external channel (Nova, 2026-11-10, #wg-rbac:#60):
  // its Upgrades in Create Channel, the invite dialog, the invitee's page and
  // the approver's page name it, with the surface, so their paywall actions
  // and checkouts count apart. `external_channel_frozen`: a Free server in
  // more than one external channel is read-only in all of them; its banner's
  // Upgrade, once wired (today the banner opens `general`). Each has its own
  // copy (cindyz, Warden), and the dialog lists
  // unlimited external channels first for both.
  "external_channel_free_limit",
  "external_channel_frozen",
  // No specific limit: today only an agent's upgrade card without a gate.
  "general",
  // Each other one is a paywall the analytics registry knows (PAYWALL_GATES);
  // `general` is not a paywall, so no paywall event can carry it, and the
  // registry lists it among the billing entries on its own. Either way the
  // dialog passes its gate as the checkout's billingEntry.
] as const satisfies readonly (PaywallGate | typeof GENERAL_UPGRADE_GATE)[];
export type UpgradeGate = (typeof UPGRADE_GATES)[number];

/**
 * The gates an agent's `plan:upgrade` card may name: the limits an agent can
 * actually run into, plus `general`. Not `pro_theme` (choosing a theme is a
 * person's action in the web app) or `plan_downgraded` (a state people see
 * after a downgrade); those stay with the web's upgrade dialog only (Tenny).
 * Nor the external channel gates (`external_channel_free_limit`,
 * `external_channel_frozen`), not yet: only the web's own Upgrades open them,
 * and naming one here adds it to the agent API's gate list.
 */
export const AGENT_UPGRADE_CARD_GATES = [
  "history_30d",
  "upload_monthly_quota",
  "upload_file_size",
  "joint_channel_free_cap",
  "joint_channel_host_limit",
  "joint_channel_over_limit",
  "joint_channel_read_only",
  "agent_migration",
  GENERAL_UPGRADE_GATE,
] as const satisfies readonly UpgradeGate[];
export type AgentUpgradeCardGate = (typeof AGENT_UPGRADE_CARD_GATES)[number];

export function isUpgradeGate(value: unknown): value is UpgradeGate {
  return typeof value === "string" && (UPGRADE_GATES as readonly string[]).includes(value);
}
