import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useIntl } from "react-intl";
import { Check, Minus, Plus } from "lucide-react";
import { Badge, Button, RadioGroup, RadioGroupItem, ScrollArea, Skeleton, TextLink } from "@botiverse/raft-ui";
import {
  DEFAULT_BILLING_INTERVAL,
  PRO_AGENT_SEAT_BLOCK_SIZE,
  PRO_PACK_ANNUAL_DISCOUNT_PERCENT,
  PRO_SEAT_ANNUAL_USD,
  PRO_SEAT_MONTHLY_USD,
  currentTimeMs,
} from "@botiverse/raft-shared";
import type { BillingInterval, PrepaidOffer, PrepaidOfferPeriod, ProPrepaidMonths } from "@botiverse/raft-shared";
import { subscribeLiveTime } from "../../hooks/liveTimeClock";
import { useServerStore } from "../../store/serverStore";
import type { BillingInfo } from "../../store/serverStore";
import { getBillingSelectedTotalLabels } from "../../utils/billingPricedTotals";
import { HIGHLIGHT_VALUES, PRO_HIGHLIGHTS } from "./proHighlights";
import type { ProHighlightKey } from "./proHighlights";
import Banner from "../ui/Banner";
import { SeatsBreakdown } from "./SeatsBreakdown";
import { SETUP_PAPER, SETUP_PAPER_DOT_GRID, SETUP_STICKER_CARD } from "../onboarding/setupPaper";

/**
 * The Pro offer and its checkout choices, shared by the onboarding Pro step and the
 * upgrade dialog every paywall opens: one offer, so the two never quote Pro differently.
 */

const INTERVALS: BillingInterval[] = ["annual", "monthly"];
/** Pro is for a team: never fewer than two seats, whatever the server holds today. */
const MIN_PRO_SEATS = 2;

// The option card from the RadioGroup page of the Raft Design System: the card draws the
// choice (cyan "this item" when checked), keyboard focus rings the card.
const OPTION_CARD = [
  "relative flex w-full items-start gap-2.5 text-left",
  "rounded-container border border-line-hairline bg-layer-card p-3",
  "hover:overlay-subtle active:overlay-medium",
  "has-[[data-slot=radio-group-item]:focus-visible]:ring-2 has-[[data-slot=radio-group-item]:focus-visible]:ring-line-strong has-[[data-slot=radio-group-item]:focus-visible]:ring-offset-2",
  "has-[[data-slot=radio-group-item][data-checked]]:border-line-seam has-[[data-slot=radio-group-item][data-checked]]:bg-info-soft",
  "has-[[data-slot=radio-group-item][data-disabled]]:cursor-not-allowed has-[[data-slot=radio-group-item][data-disabled]]:bg-fill-muted",
].join(" ");

function formatUsd(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** The price of one seat for one month, on this interval. */
function monthlySeatUsd(interval: BillingInterval): string {
  return interval === "annual" ? (PRO_SEAT_ANNUAL_USD / 12).toFixed(2) : formatUsd(PRO_SEAT_MONTHLY_USD);
}

/** Paid once with Alipay: the period's price per seat, per month (Stripe holds it, in cents). */
function periodSeatMonthUsd(period: PrepaidOfferPeriod): string {
  return formatUsd(period.unitAmount / period.months / 100);
}

/** The same for an interval card; the offer has both periods or none. */
function prepaidSeatMonthUsd(offer: PrepaidOffer, interval: BillingInterval): string {
  const period = offer.periods.find((candidate) => candidate.months === prepaidMonthsFor(interval));
  return period ? periodSeatMonthUsd(period) : monthlySeatUsd(interval);
}

/**
 * How the owner pays: a card subscription that renews, or Alipay paid once (task #19).
 * Paid once, Monthly is one month and Yearly twelve, at the subscription's prices
 * (cindyz, option C: the subscription stays the default, Alipay is a link under it).
 */
export type CheckoutPayment = "card" | "alipay";

function prepaidMonthsFor(interval: BillingInterval): ProPrepaidMonths {
  return interval === "monthly" ? 1 : 12;
}

/** The yearly saving paid once, from the offer's own prices (Stripe holds them). */
function prepaidAnnualDiscountPercent(offer: PrepaidOffer): number {
  const month = offer.periods.find((period) => period.months === 1);
  const year = offer.periods.find((period) => period.months === 12);
  if (!month || !year || month.unitAmount <= 0) return 0;
  return Math.round((1 - year.unitAmount / (12 * month.unitAmount)) * 100);
}

/**
 * Billing interval and seats for a Pro checkout. Seats count up from the minimum (the
 * people and agents already on the server, never fewer than two), so they can never
 * drop below it, even when the minimum arrives after the choices are on screen.
 *
 * `prepaid.offer`: the Alipay offer (null until it loads, or when the dialog doesn't
 * offer Alipay); when it is available the owner may pay once for a month or a year instead.
 * `prepaid.failed`: it could not load, or the flag is off. `prepaid.only`: a
 * prepaid server renewing, which cannot switch to a subscription; it starts at the
 * seats it has, and has nothing to pay until the offer is there.
 *
 * `server.billing`: the billing of a server other than the current one (a page
 * outside the app reads it), in place of the current server's.
 */
const NO_LOAD = async () => {};

export function useProCheckoutDraft(
  prepaid: { offer: PrepaidOffer | null; only: boolean; failed?: boolean } = { offer: null, only: false },
  server?: { billing: BillingInfo | null },
) {
  const currentBilling = useServerStore((state) => state.billing);
  const billing = server ? server.billing : currentBilling;
  const loadBilling = useServerStore((state) => state.loadBilling);
  const [billingInterval, setBillingInterval] = useState<BillingInterval>(DEFAULT_BILLING_INTERVAL);
  // Seats the owner added or removed from where the choices start.
  const [seatDelta, setSeatDelta] = useState(0);
  const [paymentChoice, setPaymentChoice] = useState<CheckoutPayment>("card");

  // Another server's billing is its page's to read.
  const load = server ? NO_LOAD : loadBilling;
  useEffect(() => {
    void load();
  }, [load]);

  const offer = prepaid.offer && prepaid.offer.unavailableReason === null && prepaid.offer.periods.length > 0 ? prepaid.offer : null;
  // A renewal pays with Alipay only: without the offer there is no price to show or pay.
  const offerState: "ready" | "loading" | "unavailable" = offer ? "ready" : prepaid.offer || prepaid.failed ? "unavailable" : "loading";
  const payment: CheckoutPayment = prepaid.only || (offer && paymentChoice === "alipay") ? "alipay" : "card";
  const usage = billing?.usage;
  const usageMinimum = Math.ceil(usage?.universalSeats ?? 0);
  const alipayMinimum = payment === "alipay" ? offer?.minimumSeatQuantity ?? 0 : 0;
  const minimumSeats = Math.max(MIN_PRO_SEATS, usageMinimum, alipayMinimum);
  // Why the seats can't go lower, said beside them so the minimum never reads as Pro's
  // price: the seats the server's people and agents already use (from two up), broken
  // down as Plan & billing shows them; else Pro's floor of two. The Alipay offer's
  // minimum is that same count read by the server; above what this page has read, it
  // is said without the older breakdown.
  const seatsInUse = usage && usageMinimum === minimumSeats
    ? { used: usage.universalSeats, breakdown: { humans: usage.humans, agents: usage.agents } }
    : alipayMinimum === minimumSeats && alipayMinimum > MIN_PRO_SEATS
      ? { used: alipayMinimum, breakdown: null }
      : null;
  // A renewal starts at the seats it has (more than the minimum when some are free).
  const startSeats = Math.max(minimumSeats, prepaid.only ? offer?.defaultSeatQuantity ?? 0 : 0);
  const seats = Math.max(minimumSeats, startSeats + seatDelta);
  const extraSeats = seats - minimumSeats;
  const months = prepaidMonthsFor(billingInterval);
  const period: PrepaidOfferPeriod | null = offer?.periods.find((candidate) => candidate.months === months) ?? null;
  const total = payment === "alipay" && period
    ? { id: "prepaidPro.totalOnce" as const, amount: formatUsd((period.unitAmount * seats) / 100) }
    : getBillingSelectedTotalLabels(
      billingInterval,
      seats,
      PRO_SEAT_MONTHLY_USD,
      PRO_SEAT_ANNUAL_USD,
      formatUsd,
    ).totalLabel;

  const onIntervalChange = useCallback((value: unknown) => {
    if (value === "annual" || value === "monthly") setBillingInterval(value);
  }, []);
  const onTogglePayment = useCallback(() => setPaymentChoice((current) => (current === "alipay" ? "card" : "alipay")), []);
  const lowestDelta = minimumSeats - startSeats;
  const onRemoveSeat = useCallback(() => setSeatDelta((delta) => Math.max(lowestDelta, delta - 1)), [lowestDelta]);
  const onAddSeat = useCallback(() => setSeatDelta((delta) => delta + 1), []);

  return {
    billingInterval, onIntervalChange, minimumSeats, seatsInUse, extraSeats, seats, total, onAddSeat, onRemoveSeat,
    payment, onTogglePayment, months, prepaidOffer: offer, prepaidOnly: prepaid.only, period,
    // Seats the choices started at (the analytics' default), and whether there is something to pay.
    defaultSeats: startSeats, offerState, ready: payment === "card" || period !== null,
  };
}

export type ProCheckoutDraft = ReturnType<typeof useProCheckoutDraft>;

/**
 * The offer: a price sticker on dotted cream paper and what Pro adds over Free. `first`
 * moves the limit someone just hit to the top and marks it.
 */
export function ProOfferPanel({
  billingInterval,
  prepaidPeriod,
  pricePending = false,
  first,
  testIdPrefix,
}: {
  billingInterval: BillingInterval;
  /** Paying once with Alipay: the sticker quotes the period's price per seat instead. */
  prepaidPeriod?: PrepaidOfferPeriod | null;
  /** Paying once before the offer's price is known: no price, rather than the card's. */
  pricePending?: boolean;
  first?: ProHighlightKey;
  testIdPrefix: string;
}) {
  const { formatMessage } = useIntl();
  const highlights = first
    ? [...PRO_HIGHLIGHTS.filter((highlight) => highlight.key === first), ...PRO_HIGHLIGHTS.filter((highlight) => highlight.key !== first)]
    : PRO_HIGHLIGHTS;
  return (
    // Like the right column, it scrolls on its own from md when its list outgrows the
    // dialog's fixed height (longer locales); the paper's dots stay put behind it.
    <div className={`${SETUP_PAPER} flex flex-col border-b border-line-seam md:min-h-0 md:border-b-0 md:border-r`}>
      <div className={SETUP_PAPER_DOT_GRID} aria-hidden="true" />
      <ScrollArea className="md:min-h-0" contentClassName="relative flex flex-col justify-start gap-3 px-6 py-4 sm:px-7">
        {/* A fixed width, so the sticker doesn't resize when the price changes with the interval. */}
        <div className={`${SETUP_STICKER_CARD} w-36 rotate-[-1.5deg] self-start px-5 py-2`}>
          <Badge appearance="solid" variant="accent" className="absolute -right-3 -top-3 rotate-[6deg]">
            {formatMessage({ id: "billing.pro" })}
          </Badge>
          {pricePending ? (
            <Skeleton variant="block" className="my-2 h-9 w-20" data-testid={`${testIdPrefix}-seat-price-pending`} />
          ) : (
            <p className="text-display tabular-nums text-foreground" data-testid={`${testIdPrefix}-seat-price`}>
              {formatMessage({ id: "layout.onboarding.proAmount" }, {
                // Paid once, quoted per month like the subscription, so the sticker never outgrows its width.
                amount: prepaidPeriod ? periodSeatMonthUsd(prepaidPeriod) : monthlySeatUsd(billingInterval),
              })}
            </p>
          )}
          <p className="text-footnote text-foreground-muted">
            {formatMessage({ id: "layout.onboarding.proPerSeatPerMonth" })}
          </p>
          {pricePending ? null : (
            <p className="text-footnote text-foreground-muted">
              {prepaidPeriod
                ? formatMessage({ id: "prepaidPro.paidOnceFor" }, { months: prepaidPeriod.months })
                : formatMessage({
                  id: billingInterval === "annual" ? "layout.onboarding.proBilledYearly" : "layout.onboarding.proBilledMonthly",
                })}
            </p>
          )}
        </div>
        <ul className="relative grid gap-2">
          {highlights.map((highlight) => {
            const hit = highlight.key === first;
            return (
              <li
                key={highlight.key}
                className={hit
                  ? "-mx-2 flex items-start gap-2.5 rounded-control bg-attention-soft px-2 py-1 text-callout font-bold text-foreground"
                  : "flex items-start gap-2.5 text-callout font-medium text-foreground"}
                data-hit={hit ? "true" : undefined}
                data-testid={`${testIdPrefix}-benefit-${highlight.key}`}
              >
                <Check size={16} strokeWidth={2.5} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span className="grid min-w-0 gap-0">
                  <span data-testid={`${testIdPrefix}-benefit-${highlight.key}-pro`}>
                    {formatMessage({ id: highlight.pro }, HIGHLIGHT_VALUES)}
                  </span>
                  <del
                    className="relative mt-0.5 w-fit max-w-full text-footnote font-normal leading-tight text-foreground-hint no-underline after:pointer-events-none after:absolute after:-left-0.5 after:-right-0.5 after:top-1/2 after:h-[1.5px] after:-translate-y-1/2 after:-rotate-1 after:rounded-full after:bg-line-seam after:content-['']"
                    data-testid={`${testIdPrefix}-benefit-${highlight.key}-free`}
                  >
                    {formatMessage({ id: highlight.free }, HIGHLIGHT_VALUES)}
                  </del>
                </span>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
}

/** The choices: yearly or monthly, the seats, and the total. */
export function ProCheckoutChoices({
  draft,
  busy,
  error,
  testIdPrefix,
}: {
  draft: ProCheckoutDraft;
  busy: boolean;
  error?: string;
  testIdPrefix: string;
}) {
  const { formatMessage, formatDate, formatNumber } = useIntl();
  const formatSeats = (value: number) => formatNumber(value, { maximumFractionDigits: 1 });
  const { billingInterval, onIntervalChange, minimumSeats, seatsInUse, extraSeats, seats, total, onAddSeat, onRemoveSeat, payment, prepaidOffer } = draft;
  const alipay = payment === "alipay";
  // Whether a renewal's start has passed, from the live clock: the note changes when it does, on a page left open.
  const renewalStartsAt = prepaidOffer?.renewalStartsAt;
  const readRenewalStarted = () => (renewalStartsAt ? Date.parse(renewalStartsAt) < currentTimeMs() : false);
  const renewalStarted = useSyncExternalStore(subscribeLiveTime, readRenewalStarted, readRenewalStarted);
  const annualDiscount = alipay && prepaidOffer ? prepaidAnnualDiscountPercent(prepaidOffer) : PRO_PACK_ANNUAL_DISCOUNT_PERCENT;
  // Renewing before the offer is there (or when it can't be had): no price to choose or pay.
  if (alipay && !prepaidOffer) {
    return (
      <div className="flex flex-col gap-4 px-6 py-5 sm:px-7">
        {error ? <Banner intent="warning">{error}</Banner> : null}
        {draft.offerState === "loading" ? (
          <div className="grid gap-2.5 sm:grid-cols-2" aria-busy="true" data-testid={`${testIdPrefix}-prepaid-loading`}>
            {INTERVALS.map((interval) => <Skeleton key={interval} variant="block" className="h-16" />)}
          </div>
        ) : (
          <Banner intent="warning" data-testid={`${testIdPrefix}-prepaid-unavailable`}>
            {formatMessage({ id: "prepaidPro.renewUnavailable" })}
          </Banner>
        )}
      </div>
    );
  }
  return (
    // The right column scrolls on its own from md, in a raft-ui ScrollArea; below md it is
    // only as tall as its content and the frame's body scrolls (SetupStepFrame).
    <ScrollArea className="md:min-h-0" contentClassName="flex flex-col gap-4 px-6 py-5 sm:px-7">
      {error ? <Banner intent="warning">{error}</Banner> : null}

      <RadioGroup
        aria-label={formatMessage({ id: "billing.billingInterval" })}
        value={billingInterval}
        onValueChange={onIntervalChange}
        disabled={busy}
        className="grid gap-2.5 sm:grid-cols-2"
      >
        {INTERVALS.map((interval) => (
          <label key={interval} className={OPTION_CARD} data-testid={`${testIdPrefix}-interval-${interval}`}>
            <RadioGroupItem value={interval} className="mt-0.5" />
            <span className="grid min-w-0 gap-1">
              <span className="text-subhead font-bold text-foreground">
                {formatMessage({ id: interval === "annual" ? "billing.yearly" : "billing.monthly" })}
              </span>
              <span className="whitespace-nowrap text-footnote text-foreground-muted">
                {formatMessage({ id: "layout.onboarding.proPerSeatMonth" }, { amount: alipay && prepaidOffer ? prepaidSeatMonthUsd(prepaidOffer, interval) : monthlySeatUsd(interval) })}
              </span>
            </span>
            {interval === "annual" && annualDiscount > 0 ? (
              <Badge appearance="solid" variant="success" className="absolute -top-2.5 right-2 rotate-[3deg]">
                {formatMessage({ id: "billing.saveAnnualPercent" }, { percent: annualDiscount })}
              </Badge>
            ) : null}
          </label>
        ))}
      </RadioGroup>

      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-subhead font-bold text-foreground">{formatMessage({ id: "billing.seats" })}</p>
          {seatsInUse ? (
            <p className="text-footnote text-foreground-muted" data-testid={`${testIdPrefix}-seats-in-use`}>
              {seatsInUse.used === minimumSeats
                ? formatMessage({ id: "upgradeDialog.seatMinimum.inUse" }, { used: minimumSeats })
                : formatMessage({ id: "upgradeDialog.seatMinimum.inUseRounded" }, { used: formatSeats(seatsInUse.used), min: minimumSeats })}
            </p>
          ) : (
            <>
              <p className="text-footnote text-foreground-muted">
                {formatMessage({ id: "layout.onboarding.proSeatsHint" }, { min: minimumSeats })}
              </p>
              <p className="text-footnote text-foreground-hint">
                {formatMessage({ id: "layout.onboarding.proSeatNote" }, { agentBlock: PRO_AGENT_SEAT_BLOCK_SIZE })}
              </p>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-md"
            onClick={onRemoveSeat}
            disabled={busy || extraSeats === 0}
            aria-label={formatMessage({ id: "layout.onboarding.proRemoveSeat" })}
            data-testid={`${testIdPrefix}-seat-remove`}
          >
            <Minus size={16} aria-hidden="true" />
          </Button>
          <output
            className="w-8 text-center font-mono text-subhead font-bold text-foreground"
            aria-live="polite"
            data-testid={`${testIdPrefix}-seats`}
          >
            {seats}
          </output>
          <Button
            type="button"
            variant="outline"
            size="icon-md"
            onClick={onAddSeat}
            disabled={busy}
            aria-label={formatMessage({ id: "layout.onboarding.proAddSeat" })}
            data-testid={`${testIdPrefix}-seat-add`}
          >
            <Plus size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
      {/* What the seats in use are made of, under the whole row (cindyz, option 2). */}
      {seatsInUse?.breakdown ? (
        <SeatsBreakdown humans={seatsInUse.breakdown.humans} agents={seatsInUse.breakdown.agents} className="-mt-1" testId={`${testIdPrefix}-seats-breakdown`} />
      ) : null}

      {/* A renewal says where it starts; a first purchase's "paid once" is in its choice and its total. */}
      {alipay && prepaidOffer?.renewalStartsAt ? (
        <p className="text-footnote text-foreground-muted" data-testid={`${testIdPrefix}-prepaid-note`}>
          {/* In the grace days the new time still counts from the last end, already past. */}
          {formatMessage({ id: renewalStarted ? "prepaidPro.renewalNoteGrace" : "prepaidPro.renewalNote" }, { date: formatDate(prepaidOffer.renewalStartsAt, { dateStyle: "medium" }) })}
        </p>
      ) : null}

      <div className="mt-auto flex items-baseline justify-between gap-4 border-t border-line-hairline pt-4">
        <span className="text-callout text-foreground-muted" data-testid={`${testIdPrefix}-summary`}>
          {alipay
            ? formatMessage({ id: "prepaidPro.summary" }, { seats, months: draft.months })
            : formatMessage({ id: "layout.onboarding.proSummary" }, { seats, interval: billingInterval })}
        </span>
        <span className="text-title text-foreground" data-testid={`${testIdPrefix}-total`}>
          {formatMessage({ id: total.id }, { amount: total.amount })}
        </span>
      </div>
      {/* Alipay is offered as a link under the total, never in the way of the subscription. */}
      {prepaidOffer && !draft.prepaidOnly ? (
        <div className="-mt-2 flex items-baseline justify-between gap-4 text-footnote">
          <span className="text-foreground-muted" data-testid={`${testIdPrefix}-prepaid-note`}>
            {alipay ? formatMessage({ id: "prepaidPro.paidOnceNote" }) : null}
          </span>
          <TextLink
            variant="muted"
            className="shrink-0 whitespace-nowrap"
            onClick={draft.onTogglePayment}
            disabled={busy}
            data-testid={`${testIdPrefix}-payment-switch`}
          >
            {formatMessage({ id: alipay ? "prepaidPro.payByCardInstead" : "prepaidPro.preferAlipay" })}
          </TextLink>
        </div>
      ) : null}
    </ScrollArea>
  );
}
