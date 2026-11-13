// GET /api/billing/subscription, as the web reads it (serverStore holds it).
import type { PrepaidEntitlement } from "@botiverse/raft-shared";

export interface SubscriptionInfo {
  status: "active" | "past_due" | "canceled" | "incomplete";
  billingInterval: "monthly" | "annual";
  currentPeriodStart?: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface BillingInfo {
  plan: string;
  displayName: string;
  serverPlan: string;
  source: "server" | "subscription" | "appsumo" | "prepaid";
  sourceConflict?: "appsumo_stripe" | null;
  /** Prepaid Pro time (Alipay, paid once) that makes the server Pro; null otherwise or from older servers. */
  prepaid?: PrepaidEntitlement | null;
  appsumoBillingReserved?: boolean;
  appsumo?: { tier: 1 | 2 | 3 | 4; lifetime: true; maxHostedJointChannels: number; hostedJointChannels: number; monthlyUploadBytes: number; maxHumans: number; maxAgents: number } | null;
  capacity: {
    maxHumans: number;
    maxAgents: number;
    maxUniversalSeats: number;
  };
  usage: {
    humans: number;
    agents: number;
    universalSeats: number;
  };
  provisioned: {
    humans: number;
    agents: number;
    proPackQuantity: number;
    trialFreePackQuantity: number;
    firstPackTrialEndsAt?: string | null;
  };
  /**
   * A plan with a history window: how often its agents reached behind it in
   * the last 7 days (task #24, C+ step 2). Null when not counted or unreadable.
   */
  agentHistoryBlocks7d?: number | null;
  /**
   * How many external channels this server is in (hosting or connected),
   * owners and admins (#14528): the cancel confirmation warns when Free's one
   * would freeze the rest (Warden's v4 H).
   */
  externalChannelsTotal?: number;
  fileUploadQuota?: {
    month: string;
    plan: string;
    limited: boolean;
    enforced: boolean;
    limitBytes: number;
    usedBytes: number;
    reservedBytes: number;
    remainingBytes: number;
  };
  price: {
    billingInterval: "monthly" | "annual";
    monthlyUsd: number;
    annualUsd: number | null;
    discountPercent: number;
    baseMonthlyUsd: number;
    overageMonthlyUsd: number;
    seatQuantity: number;
    packQuantity: number;
    humanSeatQuantity: number;
    agentSeatQuantity: number;
    agentSeatBlockQuantity: number;
  } | null;
  subscription: SubscriptionInfo | null;
  stripeConfigured: boolean;
  permissions: {
    canReadBillingSummary: boolean;
    canManageBilling: boolean;
  };
}
