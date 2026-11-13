// Seats added to prepaid Pro time mid-period (task #19 PR4, #proj-commercial;
// docs/billing/prepaid-pro.md): priced by the days left (cindyz, 2026-11-10,
// a started day counts whole), from now to the end of the paid time, each paid
// period at its own Price. The one place the amount is computed and rounded:
// the Checkout (prepaidProSeats.ts) and the webhook check (prepaidProBilling.ts)
// both call it, so they cannot disagree. No runtime dependencies on the DB.
import type Stripe from "stripe";
import { isProPrepaidMonths, type ProPrepaidMonths } from "@botiverse/raft-shared";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Stripe's smallest Alipay charge, in US cents. */
export const PREPAID_SEATS_MINIMUM_AMOUNT = 50;

/** One paid period the added seats run through: its Price (per seat, whole period) and the days charged. */
export interface PrepaidSeatSegment {
  months: ProPrepaidMonths;
  /** The period's Price per seat for the whole period, in cents. */
  periodUnitAmount: number;
  daysLeft: number;
  periodDays: number;
}

/**
 * The paid periods from `now` to `paidThrough` (the end of the chain), each
 * with the days left in it. Periods of one chain do not overlap (a renewal
 * starts where the paid time ends). Null unless they cover every moment from
 * now to `paidThrough` at a Price: seats are never granted for days not
 * charged (a gap, or a period of a length with no Price).
 */
export function prepaidSeatSegments(
  periods: readonly { months: number | null; startsAt: Date; endsAt: Date }[],
  now: Date,
  paidThrough: Date,
  periodUnitAmount: (months: ProPrepaidMonths) => number,
): PrepaidSeatSegment[] | null {
  const segments: PrepaidSeatSegment[] = [];
  const ordered = [...periods].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  let covered = now.getTime();
  for (const period of ordered) {
    const from = Math.max(period.startsAt.getTime(), now.getTime());
    const to = Math.min(period.endsAt.getTime(), paidThrough.getTime());
    if (to <= from) continue;
    if (from > covered || !isProPrepaidMonths(period.months)) return null;
    const periodDays = Math.max(1, Math.round((period.endsAt.getTime() - period.startsAt.getTime()) / DAY_MS));
    const daysLeft = Math.min(periodDays, Math.ceil((to - from) / DAY_MS));
    segments.push({ months: period.months, periodUnitAmount: periodUnitAmount(period.months), daysLeft, periodDays });
    covered = Math.max(covered, to);
  }
  return covered >= paidThrough.getTime() ? segments : null;
}

/** Per added seat: each period's share rounded to the cent, then summed. */
export function prepaidSeatUnitAmount(segments: readonly PrepaidSeatSegment[]): number {
  return segments.reduce((sum, segment) => sum + Math.round(segment.periodUnitAmount * segment.daysLeft / segment.periodDays), 0);
}

/**
 * The Checkout's one line for `seatQuantity` seats at `unitAmount` each. Under
 * Stripe's minimum the charge is the minimum, as one line of quantity 1.
 */
export function prepaidSeatsCheckoutLine(unitAmount: number, seatQuantity: number): { unitAmount: number; quantity: number; amountTotal: number; minimumApplied: boolean } {
  const total = unitAmount * seatQuantity;
  if (total < PREPAID_SEATS_MINIMUM_AMOUNT) {
    return { unitAmount: PREPAID_SEATS_MINIMUM_AMOUNT, quantity: 1, amountTotal: PREPAID_SEATS_MINIMUM_AMOUNT, minimumApplied: true };
  }
  return { unitAmount, quantity: seatQuantity, amountTotal: total, minimumApplied: false };
}

// ── Checkout metadata (written by our server; Stripe metadata is ours alone) ──

export interface PrepaidSeatsCheckoutTerms {
  seatQuantity: number;
  unitAmount: number;
  /** End of the paid time when the Checkout was created: the added seats run until then. */
  endsAt: Date;
  segments: PrepaidSeatSegment[];
}

export function encodePrepaidSeatSegments(segments: readonly PrepaidSeatSegment[]): string {
  return segments.map(s => `${s.months}:${s.periodUnitAmount}:${s.daysLeft}:${s.periodDays}`).join(",");
}

function decodePrepaidSeatSegments(value: unknown): PrepaidSeatSegment[] | null {
  if (typeof value !== "string" || !value) return null;
  const segments: PrepaidSeatSegment[] = [];
  for (const part of value.split(",")) {
    const fields = part.split(":").map(Number);
    if (fields.length !== 4 || !fields.every(Number.isSafeInteger)) return null;
    const [months, periodUnitAmount, daysLeft, periodDays] = fields;
    if (!isProPrepaidMonths(months) || periodUnitAmount <= 0 || daysLeft < 1 || periodDays < daysLeft) return null;
    segments.push({ months, periodUnitAmount, daysLeft, periodDays });
  }
  return segments;
}

/** The terms a seats Checkout was created with, or null when its metadata is unreadable or does not add up. */
export function parsePrepaidSeatsCheckoutTerms(metadata: Stripe.Metadata | null | undefined): PrepaidSeatsCheckoutTerms | null {
  const seatQuantity = Number(metadata?.seatQuantity);
  const unitAmount = Number(metadata?.unitAmount);
  const endsAt = new Date(typeof metadata?.endsAt === "string" ? metadata.endsAt : Number.NaN);
  const segments = decodePrepaidSeatSegments(metadata?.segments);
  if (!Number.isSafeInteger(seatQuantity) || seatQuantity < 1 || !Number.isSafeInteger(unitAmount) || unitAmount < 1) return null;
  if (Number.isNaN(endsAt.getTime()) || !segments || segments.length === 0) return null;
  // The same rounding the Checkout used: metadata that disagrees with itself is not ours to trust.
  if (prepaidSeatUnitAmount(segments) !== unitAmount) return null;
  return { seatQuantity, unitAmount, endsAt, segments };
}

/**
 * Whether Stripe charged exactly these terms: one line of the expected unit
 * amount and quantity, in USD, one time, and the subtotal (before tax and
 * discounts; this Checkout takes no promotion codes) equal to the line.
 */
export async function prepaidSeatsAmountMatches(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  terms: PrepaidSeatsCheckoutTerms,
  requestOptions: Stripe.RequestOptions,
): Promise<boolean> {
  const expected = prepaidSeatsCheckoutLine(terms.unitAmount, terms.seatQuantity);
  if (session.currency !== "usd" || session.amount_subtotal !== expected.amountTotal) return false;
  if ((session.total_details?.amount_discount ?? 0) !== 0) return false;
  const lines = await stripe.checkout.sessions.listLineItems(session.id, { limit: 5 }, requestOptions);
  if (!lines || lines.data.length !== 1 || lines.has_more) return false;
  const [line] = lines.data;
  const price = line.price;
  if (!price || line.quantity !== expected.quantity || price.type !== "one_time" || price.currency !== "usd") return false;
  return price.unit_amount === expected.unitAmount;
}
