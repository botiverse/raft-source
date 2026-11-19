import type { ServerPlan } from "./billingPlanFeatures";

/** Days a lapsed prepaid period keeps Pro before the Server drops to Free. */
export const PRO_PREPAID_GRACE_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
const PRO_PREPAID_GRACE_MS = PRO_PREPAID_GRACE_DAYS * DAY_MS;

/** Prepaid Pro time a Server has (task #19): the period that covers now, or the one that just ended while its grace days run. */
export interface PrepaidEntitlement {
  /** End of the paid time, ISO. Later periods already bought are included: renewing early extends it. */
  endsAt: string;
  /** endsAt plus PRO_PREPAID_GRACE_DAYS: the Server drops to Free after this. */
  graceEndsAt: string;
  /** Paid time is over and the grace days are running. */
  inGrace: boolean;
  /** Seats bought for now (in grace, the seats at the end). */
  seatQuantity: number;
}

export type PrepaidGrantPurchaseInput = {
  kind: "period" | "seats";
  seatQuantity: number;
  startsAt: Date | string | number;
  endsAt: Date | string | number;
};

export type ServerPlanEntitlementSource = "server" | "subscription" | "appsumo" | "prepaid";

export type ServerBillingPlanInputs = {
  serverPlan?: ServerPlan | null;
  subscriptionPlan?: "pro" | null;
  subscriptionStatus?: string | null;
  hasActiveAppSumo?: boolean;
  prepaid?: PrepaidEntitlement | null;
  prepaidPurchases?: readonly PrepaidGrantPurchaseInput[];
};

export type ResolvedServerBillingPlanSource = {
  plan: ServerPlan;
  source: ServerPlanEntitlementSource;
  prepaid: PrepaidEntitlement | null;
  hasEntitlingSubscription: boolean;
  hasInternalEntitlement: boolean;
};

export type ParsedFfaServerPlanEntitlementInputs =
  | { found: false }
  | { found: true; inputs: ServerBillingPlanInputs };

const VALID_SERVER_PLANS: ReadonlySet<string> = new Set<ServerPlan>([
  "free",
  "founder",
  "partner",
  "pro",
]);

const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "server_plan",
  "subscription_plan",
  "subscription_status",
  "has_active_appsumo",
  "prepaid_purchases",
]);

const ALLOWED_PURCHASE_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "seat_quantity",
  "starts_at",
  "ends_at",
]);

function isServerPlan(value: unknown): value is ServerPlan {
  return typeof value === "string" && VALID_SERVER_PLANS.has(value);
}

function toEpochMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

export function isSubscriptionEntitling(status: string): boolean {
  return status === "active" || status === "past_due";
}

export function isInternalEntitlementPlan(plan: ServerPlan): boolean {
  return plan === "founder" || plan === "partner";
}

/** Derive one Server's active or in-grace Prepaid Pro grant from its paid rows. */
export function prepaidGrantOf(
  rows: readonly PrepaidGrantPurchaseInput[],
  now: Date,
): PrepaidEntitlement | null {
  const nowMs = now.getTime();
  const normalized = rows.flatMap((row) => {
    const startsAtMs = toEpochMs(row.startsAt);
    const endsAtMs = toEpochMs(row.endsAt);
    if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs)) return [];
    return [{ kind: row.kind, seatQuantity: row.seatQuantity, startsAtMs, endsAtMs }];
  });
  const periods = normalized
    .filter((row) => row.kind === "period")
    .sort((a, b) => a.startsAtMs - b.startsAtMs);
  let covering: (typeof periods)[number] | null = null;
  for (const period of periods) {
    if (period.startsAtMs > nowMs) continue;
    if (!covering || period.endsAtMs > covering.endsAtMs) covering = period;
  }
  if (!covering) return null;
  // Periods bought ahead start where the previous one ends: follow the chain.
  let chainEnd = covering.endsAtMs;
  for (const period of periods) {
    if (period.startsAtMs <= chainEnd && period.endsAtMs > chainEnd) chainEnd = period.endsAtMs;
  }
  if (nowMs >= chainEnd + PRO_PREPAID_GRACE_MS) return null;
  // In grace, the seats are the ones at the end of the paid time.
  const at = Math.min(nowMs, chainEnd - 1);
  const covers = (row: (typeof normalized)[number]) => row.startsAtMs <= at && at < row.endsAtMs;
  let base: (typeof periods)[number] | null = null;
  for (const period of periods) {
    if (covers(period) && (!base || period.startsAtMs >= base.startsAtMs)) base = period;
  }
  const added = normalized
    .filter((row) => row.kind === "seats" && covers(row))
    .reduce((sum, row) => sum + row.seatQuantity, 0);
  return {
    endsAt: new Date(chainEnd).toISOString(),
    graceEndsAt: new Date(chainEnd + PRO_PREPAID_GRACE_MS).toISOString(),
    inGrace: nowMs >= chainEnd,
    seatQuantity: (base ?? covering).seatQuantity + added,
  };
}

/**
 * Resolve a Server's effective billing plan and authoritative source across
 * internal founder/partner grants, Stripe subscriptions, AppSumo licenses, and
 * Prepaid Pro periods (shared by `planService.ts` and Feature Flag Admin preview).
 */
export function resolveServerBillingPlanSource(
  input: ServerBillingPlanInputs | null | undefined,
  now: Date,
): ResolvedServerBillingPlanSource {
  const fallbackPlan: ServerPlan = isServerPlan(input?.serverPlan) ? input.serverPlan : "free";
  const hasSubscription = Boolean(input?.subscriptionPlan);
  const hasEntitlingSubscription = Boolean(
    input?.subscriptionPlan && input.subscriptionStatus && isSubscriptionEntitling(input.subscriptionStatus),
  );
  const hasInternalEntitlement = isInternalEntitlementPlan(fallbackPlan);

  const basePlan: ServerPlan = hasInternalEntitlement
    ? fallbackPlan
    : hasEntitlingSubscription
      ? input!.subscriptionPlan!
      : hasSubscription
        ? "free"
        : fallbackPlan;
  const baseSource: ServerPlanEntitlementSource =
    hasEntitlingSubscription && !hasInternalEntitlement ? "subscription" : "server";

  const hasActiveAppSumo = input?.hasActiveAppSumo === true;
  const prepaid = input?.prepaid !== undefined
    ? input.prepaid
    : input?.prepaidPurchases
      ? prepaidGrantOf(input.prepaidPurchases, now)
      : null;

  // Prepaid time ranks below an entitling subscription and an AppSumo license;
  // checkout keeps them apart, so overlap is resolved deterministically here.
  if (prepaid && !hasActiveAppSumo && baseSource !== "subscription" && !isInternalEntitlementPlan(basePlan)) {
    return {
      plan: "pro",
      source: "prepaid",
      prepaid,
      hasEntitlingSubscription,
      hasInternalEntitlement,
    };
  }

  if (!hasActiveAppSumo || isInternalEntitlementPlan(basePlan)) {
    return {
      plan: basePlan,
      source: baseSource,
      prepaid: null,
      hasEntitlingSubscription,
      hasInternalEntitlement,
    };
  }

  return {
    plan: "pro",
    source: "appsumo",
    prepaid: null,
    hasEntitlingSubscription,
    hasInternalEntitlement,
  };
}

export function resolveEffectiveServerBillingPlan(
  input: ServerBillingPlanInputs | null | undefined,
  now: Date,
): ServerPlan {
  return resolveServerBillingPlanSource(input, now).plan;
}

/**
 * Parse and validate the JSONB payload returned by
 * `public.ffa_server_plan_entitlement_inputs(uuid, timestamptz)`.
 * Rejects unexpected keys or malformed values so preview fails closed (`plan_read_failed`).
 */
export function parseFfaServerPlanEntitlementInputs(
  raw: unknown,
): ParsedFfaServerPlanEntitlementInputs {
  if (raw === null) return { found: false };
  if (typeof raw !== "object" || raw === undefined || Array.isArray(raw)) {
    throw new TypeError("ffa_server_plan_entitlement_inputs must return a JSON object or null");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== ALLOWED_TOP_LEVEL_KEYS.size || keys.some((key) => !ALLOWED_TOP_LEVEL_KEYS.has(key))) {
    throw new TypeError("ffa_server_plan_entitlement_inputs returned an unexpected field set");
  }

  const serverPlan = record.server_plan;
  if (!isServerPlan(serverPlan)) {
    throw new TypeError("ffa_server_plan_entitlement_inputs returned an invalid server_plan");
  }

  const subscriptionPlan = record.subscription_plan;
  if (subscriptionPlan !== null && subscriptionPlan !== "pro") {
    throw new TypeError("ffa_server_plan_entitlement_inputs returned an invalid subscription_plan");
  }

  const subscriptionStatus = record.subscription_status;
  if (subscriptionStatus !== null && typeof subscriptionStatus !== "string") {
    throw new TypeError("ffa_server_plan_entitlement_inputs returned an invalid subscription_status");
  }

  const hasActiveAppSumo = record.has_active_appsumo;
  if (typeof hasActiveAppSumo !== "boolean") {
    throw new TypeError("ffa_server_plan_entitlement_inputs returned an invalid has_active_appsumo");
  }

  const rawPurchases = record.prepaid_purchases;
  if (!Array.isArray(rawPurchases)) {
    throw new TypeError("ffa_server_plan_entitlement_inputs returned an invalid prepaid_purchases");
  }

  const prepaidPurchases: PrepaidGrantPurchaseInput[] = rawPurchases.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new TypeError("ffa_server_plan_entitlement_inputs prepaid purchase must be an object");
    }
    const purchase = item as Record<string, unknown>;
    const purchaseKeys = Object.keys(purchase);
    if (
      purchaseKeys.length !== ALLOWED_PURCHASE_KEYS.size
      || purchaseKeys.some((key) => !ALLOWED_PURCHASE_KEYS.has(key))
    ) {
      throw new TypeError("ffa_server_plan_entitlement_inputs prepaid purchase has unexpected fields");
    }
    if (purchase.kind !== "period" && purchase.kind !== "seats") {
      throw new TypeError("ffa_server_plan_entitlement_inputs prepaid purchase has invalid kind");
    }
    if (
      typeof purchase.seat_quantity !== "number"
      || !Number.isInteger(purchase.seat_quantity)
      || purchase.seat_quantity <= 0
    ) {
      throw new TypeError("ffa_server_plan_entitlement_inputs prepaid purchase has invalid seat_quantity");
    }
    if (typeof purchase.starts_at !== "string" || !Number.isFinite(Date.parse(purchase.starts_at))) {
      throw new TypeError("ffa_server_plan_entitlement_inputs prepaid purchase has invalid starts_at");
    }
    if (typeof purchase.ends_at !== "string" || !Number.isFinite(Date.parse(purchase.ends_at))) {
      throw new TypeError("ffa_server_plan_entitlement_inputs prepaid purchase has invalid ends_at");
    }
    return {
      kind: purchase.kind,
      seatQuantity: purchase.seat_quantity,
      startsAt: purchase.starts_at,
      endsAt: purchase.ends_at,
    };
  });

  return {
    found: true,
    inputs: {
      serverPlan,
      subscriptionPlan,
      subscriptionStatus,
      hasActiveAppSumo,
      prepaidPurchases,
    },
  };
}
