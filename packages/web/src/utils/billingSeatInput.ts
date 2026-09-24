import type { MessageId } from "../i18n/messages";
export type BillingSeatInputChange = {
  inputValue: string;
  overrideValue: number | null;
};

/**
 * A priced total, as an id + its amount, NOT pre-built text.
 *
 * It used to be a finished English string (`"$40 / year"`) that SettingsPanel
 * post-processed for Chinese by replacing `" / year"` with `" / 年"`. Carrying the
 * amount separately lets the period live in the catalog like every other word.
 */
export type BillingPricedTotal = { id: MessageId; amount: string };

export type BillingSelectedTotalLabels = {
  totalLabel: BillingPricedTotal;
  originalLabel: BillingPricedTotal | null;
};

export type BillingSeatCopyLabels = {
  seatQuantityLabel: MessageId;
  seatSummaryLabel: MessageId;
  billableSeatsSummaryLabel: MessageId;
  capacitySummaryLabel: MessageId;
  quantityHelpLabel: MessageId;
};

export type BillingSeatCopyMode = "default" | "manageSeats";

export type BillingTotalSummaryLabels = {
  currentTotalLabel: MessageId | null;
  totalLabel: MessageId;
};

export type BillingSeatDraftState = {
  requestedSeatQuantity: number;
  draftSeatQuantity: number;
  rawDraftSeatQuantity: number;
  belowCurrentUsage: boolean;
  reducesPurchasedSeats: boolean;
};

export function getBillingSeatDraftState(input: {
  requestedSeatQuantity: number;
  draftSeatQuantity: number;
  minimumUsageSeatQuantity: number;
  minimumSeatQuantity: number;
}): BillingSeatDraftState {
  const minimumSeatQuantity = Math.max(input.minimumUsageSeatQuantity, input.minimumSeatQuantity);
  return {
    requestedSeatQuantity: Math.max(minimumSeatQuantity, input.requestedSeatQuantity),
    draftSeatQuantity: Math.max(minimumSeatQuantity, input.draftSeatQuantity),
    rawDraftSeatQuantity: input.draftSeatQuantity,
    belowCurrentUsage: input.draftSeatQuantity < input.minimumUsageSeatQuantity,
    reducesPurchasedSeats: input.draftSeatQuantity < input.minimumSeatQuantity,
  };
}

export function sanitizeBillingSeatInput(value: string): string {
  return value.replace(/[^\d]/g, "");
}

export function parseBillingSeatInput(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getBillingSeatInputChange(value: string): BillingSeatInputChange {
  const inputValue = sanitizeBillingSeatInput(value);
  const overrideValue = inputValue === ""
    ? null
    : Number.parseInt(inputValue, 10);
  return {
    inputValue,
    overrideValue,
  };
}

export function applyBillingSeatInputChange(
  value: string,
  setInputValue: (value: string) => void,
  setOverrideValue: (value: number) => void,
): BillingSeatInputChange {
  const next = getBillingSeatInputChange(value);
  setInputValue(next.inputValue);
  if (next.overrideValue !== null) {
    setOverrideValue(next.overrideValue);
  }
  return next;
}

export function commitBillingSeatInputValue(
  inputValue: string | null,
  currentSeats: number,
  minimumSeats: number,
): number {
  const parsed = parseBillingSeatInput(getBillingSeatInputValue(inputValue, currentSeats));
  return Math.max(minimumSeats, parsed ?? minimumSeats);
}

export function getBillingSeatInputValue(
  inputValue: string | null,
  currentSeats: number,
): string {
  return inputValue ?? String(currentSeats);
}

export function applyBillingSeatInputCommit(
  inputValue: string | null,
  currentSeats: number,
  minimumSeats: number,
  setOverrideValue: (value: number) => void,
  clearInputValue: (value: string | null) => void,
): number {
  const nextSeats = commitBillingSeatInputValue(inputValue, currentSeats, minimumSeats);
  setOverrideValue(nextSeats);
  clearInputValue(null);
  return nextSeats;
}

export function getBillingSelectedTotalLabels(
  billingInterval: "monthly" | "annual",
  requestedSeatQuantity: number,
  monthlySeatUsd: number,
  annualSeatUsd: number,
  formatUsd: (value: number) => string,
): BillingSelectedTotalLabels {
  if (billingInterval === "annual") {
    return {
      totalLabel: { id: "billing.perYear", amount: formatUsd(annualSeatUsd * requestedSeatQuantity) },
      originalLabel: { id: "billing.perYear", amount: formatUsd(monthlySeatUsd * 12 * requestedSeatQuantity) },
    };
  }
  return {
    totalLabel: { id: "billing.perMonth", amount: formatUsd(monthlySeatUsd * requestedSeatQuantity) },
    originalLabel: null,
  };
}

export function getBillingCurrentTotalLabel(
  billingInterval: "monthly" | "annual",
  monthlyUsd: number,
  annualUsd: number | null | undefined,
  formatUsd: (value: number) => string,
): BillingPricedTotal {
  if (billingInterval === "annual") {
    return { id: "billing.perYear", amount: formatUsd(annualUsd ?? monthlyUsd * 12) };
  }
  return { id: "billing.perMonth", amount: formatUsd(monthlyUsd) };
}

export function getBillingTotalSummaryLabels(
  mode: BillingSeatCopyMode,
  billingInterval: "monthly" | "annual",
): BillingTotalSummaryLabels {
  if (mode === "manageSeats") {
    return {
      currentTotalLabel: billingInterval === "annual" ? "billing.currentYearlyTotal" : "billing.currentMonthlyTotal",
      totalLabel: "billing.totalAfterUpdate",
    };
  }
  return {
    currentTotalLabel: null,
    totalLabel: "billing.total",
  };
}

/**
 * Returns catalog ids, not display text. SettingsPanel used to keep a parallel
 * Chinese copy of this whole object behind `locale === "zh-CN"`, so every label
 * existed twice and could drift; formatting at the call site removes that branch.
 * `quantityHelpLabel` takes a {capacity} argument rather than being pre-built,
 * because the capacity phrase is itself translated.
 */
export function getBillingSeatCopyLabels(mode: BillingSeatCopyMode): BillingSeatCopyLabels {
  if (mode === "manageSeats") {
    return {
      seatQuantityLabel: "billing.totalSeats",
      seatSummaryLabel: "billing.seatsAfterUpdate",
      billableSeatsSummaryLabel: "billing.totalSeatsAfterUpdate",
      capacitySummaryLabel: "billing.capacityAfterUpdate",
      quantityHelpLabel: "billing.enterTotalSeatsToKeep",
    };
  }
  return {
    seatQuantityLabel: "billing.seatsToBuy",
    seatSummaryLabel: "billing.seatsToBuy",
    billableSeatsSummaryLabel: "billing.billableSeats",
    capacitySummaryLabel: "billing.capacity",
    quantityHelpLabel: "billing.capacityOnly",
  };
}
