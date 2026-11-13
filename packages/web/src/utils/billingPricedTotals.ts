import type { MessageId } from "../i18n/messages";

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
