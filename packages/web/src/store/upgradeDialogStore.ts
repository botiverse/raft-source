import { isUpgradeGate, UPGRADE_GATES } from "@botiverse/raft-shared";
import type { BillingEntry, CheckoutOpenedFrom, PaywallSurface, UpgradeGate } from "@botiverse/raft-shared";
import { create } from "zustand";
import { useServerStore } from "./serverStore";
import { isPaywallGate, trackPaywallAction } from "../analytics/paywall";
import type { MonthlyUploadQuota } from "../utils/monthlyUploadQuota";

/**
 * The Free limits whose Upgrade opens the upgrade dialog. Each one names what the person
 * just ran into; the dialog's title, its first Pro benefit and the message to the owner
 * follow it. `general` names none (an agent's upgrade card without a gate). The list
 * lives in shared (an agent's `plan:upgrade` card names one too).
 */
export { isUpgradeGate, UPGRADE_GATES };
export type { UpgradeGate };

/**
 * What opened the dialog when not a paywall (an agent's upgrade card, or a
 * member's request for Pro), carried to `checkout_started` as `opened_from`.
 * A paywall sends none.
 */
export type UpgradeDialogSource = CheckoutOpenedFrom;

/**
 * - `choose`: the owner's choices, or anyone else's message to an owner.
 * - `paying`: desktop only; Stripe is open in the system browser.
 * - `confirming`: back from Stripe on the web, waiting for the plan to turn Pro.
 */
export type UpgradeDialogStage = "choose" | "paying" | "confirming";

/**
 * What an upload limit was hit with, so the line under the dialog's title says
 * it (cindyz, 2026-10-28): the files over Free's per-file ceiling, or what is
 * left of the month and when it resets, and the file that didn't fit.
 */
export type UploadLimitContext =
  | { kind: "file_size"; files: ReadonlyArray<{ name: string; size: number }> }
  | { kind: "monthly_quota"; quota: MonthlyUploadQuota; files: ReadonlyArray<{ name: string; size: number }> };

/**
 * What the history window hid where the paywall was met, so the line under
 * the dialog's title says it (task #24, proposal C): how many older messages
 * the conversation has (a named channel by its name), or when the message a
 * link opened was sent.
 */
export type HistoryLimitContext =
  | { kind: "channel"; channel: string; count: number; capped: boolean }
  | { kind: "thread" | "conversation"; count: number; capped: boolean }
  | { kind: "target"; sentAt: string };

/**
 * Where the Free plan's one external channel was met, so the dialog's title
 * and the line under it say it (cindyz, Warden). `slot`: this server's one
 * external channel is in use, by `channel` (formatted, like "#launch"), or
 * held by an `openInvite` to it no one has accepted yet; without a channel,
 * the gate's own words. `connect`: upgrading this server so it can connect to
 * another server's `channel` (the invitee's page, the approver's page).
 */
export type ExternalLimitContext =
  | { kind: "slot"; channel?: string; openInvite?: boolean }
  | { kind: "connect"; channel: string };

export type UpgradeDialogRequest = {
  gate: UpgradeGate;
  stage: UpgradeDialogStage;
  /** The server it was opened for: the dialog never shows on another one. */
  serverId: string;
  /** Set only when something other than a paywall opened it. */
  source?: UpgradeDialogSource;
  /**
   * The agent upgrade card (its message) that opened it: closing the dialog
   * while still choosing records the card's `action_card.dismiss`.
   */
  cardMessageId?: string;
  /** Set when an upload limit opened it (`upload_file_size`, `upload_monthly_quota`). */
  uploadContext?: UploadLimitContext;
  /** Set when a conversation's history paywall opened it (`history_30d`). */
  historyContext?: HistoryLimitContext;
  /** Set when the external channel limit opened it (`external_channel_free_limit`). */
  externalContext?: ExternalLimitContext;
  /** Where the paywall that opened it was met (history_30d, Save as Artifact's quota): its actions and checkout carry it. */
  surface?: PaywallSurface;
  /**
   * Opened on a page outside the app (the invite and approval pages) for a
   * server of the viewer's: that page's dialog shows it (ServerUpgradeDialog),
   * the app's doesn't.
   */
  onPage?: boolean;
  /**
   * Opened from Plan & Billing: checkout starts with entry `settings`, and the
   * server's billing events name this (the paywall that opened the page, else `settings`).
   */
  settingsEntry?: BillingEntry;
  /**
   * Renewing prepaid Pro (task #19): the paid end before this payment. The
   * server is Pro already, so the renewal is paid when the end moves past it.
   */
  renewFrom?: string;
};

/** What `open` takes besides the gate and server: the request's other fields, all optional (stage defaults to `choose`). */
export type UpgradeDialogOpenFields = Partial<Omit<UpgradeDialogRequest, "gate" | "serverId">>;

interface UpgradeDialogState {
  request: UpgradeDialogRequest | null;
  open: (gate: UpgradeGate, serverId: string, fields?: UpgradeDialogOpenFields) => void;
  setStage: (stage: UpgradeDialogStage) => void;
  /** A prepaid renewal's checkout opened: wait for the paid end to move past `renewFrom`. */
  markRenewal: (renewFrom: string) => void;
  close: () => void;
}

export const useUpgradeDialogStore = create<UpgradeDialogState>((set) => ({
  request: null,
  open: (gate, serverId, fields = {}) => {
    // Only the fields given: an unset one stays absent from the request, not `undefined`.
    const given = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== "")) as UpgradeDialogOpenFields;
    set({ request: { ...given, gate, serverId, stage: given.stage ?? "choose" } });
  },
  setStage: (stage) => set((state) => (state.request ? { request: { ...state.request, stage } } : state)),
  markRenewal: (renewFrom) => set((state) => (state.request ? { request: { ...state.request, renewFrom } } : state)),
  close: () => set({ request: null }),
}));

export type OpenUpgradeDialogOptions = {
  /**
   * The server to upgrade; defaults to the current one. The app's dialog only
   * shows while it is current; a page outside the app shows its own
   * (ServerUpgradeDialog) for a server of the viewer's.
   */
  serverId?: string;
  /** What opened it, for `checkout_started.opened_from`; leave it out for a paywall. */
  source?: UpgradeDialogSource;
  /** It opens by itself because the server refused, not from a click: no `upgrade` action. */
  unprompted?: boolean;
  /** The agent upgrade card that opened it (with `source: "agent_card"`), for its dismiss; never a person's card (outside the card funnel). */
  cardMessageId?: string;
  /** The upload limit it opened for: the files, or the month's quota. */
  uploadContext?: UploadLimitContext;
  /** What the history window hid in the conversation it opened from. */
  historyContext?: HistoryLimitContext;
  /** Which external channel holds the Free slot, or which one this server would connect to. */
  externalContext?: ExternalLimitContext;
  /** Where the paywall was met, for a gate shown in several places (history_30d, upload_monthly_quota from an Artifact). */
  surface?: PaywallSurface;
  /** Opened on a page outside the app, for `serverId` (ServerUpgradeDialog shows it there). */
  onPage?: boolean;
  /** Plan & Billing's Upgrade to Pro: the billing entry its checkout carries (see the request's). */
  settingsEntry?: BillingEntry;
};

/** Opens the upgrade dialog, from anywhere (system notifications and agent cards too). */
export function openUpgradeDialog(gate: UpgradeGate, opts: OpenUpgradeDialogOptions = {}): void {
  const serverId = opts.serverId ?? useServerStore.getState().current?.id;
  if (!serverId) return;
  const { source, cardMessageId, uploadContext, historyContext, externalContext, surface, onPage, settingsEntry } = opts;
  useUpgradeDialogStore.getState().open(gate, serverId, { source, cardMessageId, uploadContext, historyContext, externalContext, surface, onPage, settingsEntry });
  // A click on a paywall's Upgrade (not an agent card's, not `general`), counted on the server it upgrades.
  if (!opts.source && !opts.unprompted && isPaywallGate(gate)) trackPaywallAction(gate, "upgrade", opts.surface, serverId);
}
