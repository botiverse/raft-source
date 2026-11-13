import assert from "node:assert/strict";
import { test } from "vitest";
import {
  PREPAID_SEATS_MINIMUM_AMOUNT,
  encodePrepaidSeatSegments,
  parsePrepaidSeatsCheckoutTerms,
  prepaidSeatSegments,
  prepaidSeatUnitAmount,
  prepaidSeatsCheckoutLine,
} from "./prepaidProSeatsPricing";

const DAY = 24 * 60 * 60 * 1000;
const UNIT = { 1: 1000, 12: 10560 } as const;
const unit = (months: 1 | 12) => UNIT[months];
const at = (iso: string) => new Date(iso);

test("one yearly period: the days left, a started day counted whole, each seat rounded to the cent", () => {
  const period = { months: 12, startsAt: at("2026-01-01T00:00:00Z"), endsAt: at("2027-01-01T00:00:00Z") };
  // 182 days and an hour left: 183 days charged of 365.
  const now = new Date(period.endsAt.getTime() - 182 * DAY - 60 * 60 * 1000);
  const segments = prepaidSeatSegments([period], now, period.endsAt, unit);
  assert.deepEqual(segments, [{ months: 12, periodUnitAmount: 10560, daysLeft: 183, periodDays: 365 }]);
  assert.equal(prepaidSeatUnitAmount(segments), Math.round(10560 * 183 / 365)); // 5294 cents
  assert.equal(prepaidSeatUnitAmount(segments), 5294);
});

test("a month bought ahead: each period at its own Price and length, rounded per period, then summed", () => {
  // A month from Jan 15 (31 days), then a year renewed ahead from Feb 15.
  const month = { months: 1, startsAt: at("2026-01-15T00:00:00Z"), endsAt: at("2026-02-15T00:00:00Z") };
  const year = { months: 12, startsAt: month.endsAt, endsAt: at("2027-02-15T00:00:00Z") };
  const now = at("2026-02-05T12:00:00Z"); // 9.5 days left in the month
  const segments = prepaidSeatSegments([year, month], now, year.endsAt, unit);
  assert.deepEqual(segments, [
    { months: 1, periodUnitAmount: 1000, daysLeft: 10, periodDays: 31 },
    { months: 12, periodUnitAmount: 10560, daysLeft: 365, periodDays: 365 },
  ]);
  assert.equal(prepaidSeatUnitAmount(segments), Math.round(1000 * 10 / 31) + 10560); // 323 + 10560
});

test("the boundary day between two periods: none of the first is left, all of the second", () => {
  const month = { months: 1, startsAt: at("2026-01-15T00:00:00Z"), endsAt: at("2026-02-15T00:00:00Z") };
  const next = { months: 1, startsAt: month.endsAt, endsAt: at("2026-03-15T00:00:00Z") };
  const segments = prepaidSeatSegments([month, next], month.endsAt, next.endsAt, unit);
  assert.deepEqual(segments, [{ months: 1, periodUnitAmount: 1000, daysLeft: 28, periodDays: 28 }]);
  assert.equal(prepaidSeatUnitAmount(segments), 1000);
  // A millisecond before it: one started day of the first period, then the whole second.
  const before = prepaidSeatSegments([month, next], new Date(month.endsAt.getTime() - 1), next.endsAt, unit);
  assert.equal(prepaidSeatUnitAmount(before!), Math.round(1000 * 1 / 31) + 1000);
});

test("periods past the paid end or already over are left out", () => {
  const old = { months: 1, startsAt: at("2025-01-01T00:00:00Z"), endsAt: at("2025-02-01T00:00:00Z") };
  const current = { months: 1, startsAt: at("2026-01-01T00:00:00Z"), endsAt: at("2026-02-01T00:00:00Z") };
  assert.deepEqual(prepaidSeatSegments([old, current], at("2026-01-31T00:00:00Z"), current.endsAt, unit)?.map(s => s.daysLeft), [1]);
  assert.deepEqual(prepaidSeatSegments([current], current.endsAt, current.endsAt, unit), []);
});

test("paid time that can't all be priced gives no segments: no seats for days not charged", () => {
  const month = { months: 1, startsAt: at("2026-01-01T00:00:00Z"), endsAt: at("2026-02-01T00:00:00Z") };
  const now = at("2026-01-20T00:00:00Z");
  // A quarter (the table still admits 3 months, with no Price) bought ahead.
  const quarter = { months: 3, startsAt: month.endsAt, endsAt: at("2026-05-01T00:00:00Z") };
  assert.equal(prepaidSeatSegments([month, quarter], now, quarter.endsAt, unit), null);
  // A gap between two periods.
  const later = { months: 1, startsAt: at("2026-02-05T00:00:00Z"), endsAt: at("2026-03-05T00:00:00Z") };
  assert.equal(prepaidSeatSegments([month, later], now, later.endsAt, unit), null);
  // Periods that stop short of the paid end.
  assert.equal(prepaidSeatSegments([month], now, at("2026-03-01T00:00:00Z"), unit), null);
});

test("under Stripe's minimum the charge is the minimum, as one line", () => {
  assert.deepEqual(prepaidSeatsCheckoutLine(33, 1), { unitAmount: PREPAID_SEATS_MINIMUM_AMOUNT, quantity: 1, amountTotal: 50, minimumApplied: true });
  assert.deepEqual(prepaidSeatsCheckoutLine(33, 2), { unitAmount: 33, quantity: 2, amountTotal: 66, minimumApplied: false });
  assert.deepEqual(prepaidSeatsCheckoutLine(5294, 3), { unitAmount: 5294, quantity: 3, amountTotal: 15882, minimumApplied: false });
});

test("checkout terms read back from the metadata only when they add up", () => {
  const segments = [{ months: 1 as const, periodUnitAmount: 1000, daysLeft: 10, periodDays: 31 }, { months: 12 as const, periodUnitAmount: 10560, daysLeft: 365, periodDays: 365 }];
  const metadata = { seatQuantity: "3", unitAmount: String(prepaidSeatUnitAmount(segments)), endsAt: "2027-02-15T00:00:00.000Z", segments: encodePrepaidSeatSegments(segments) };
  assert.deepEqual(parsePrepaidSeatsCheckoutTerms(metadata), { seatQuantity: 3, unitAmount: 10883, endsAt: at("2027-02-15T00:00:00Z"), segments });
  for (const broken of [
    { ...metadata, unitAmount: "10884" },
    { ...metadata, seatQuantity: "0" },
    { ...metadata, endsAt: "soon" },
    { ...metadata, segments: "" },
    { ...metadata, segments: "3:3000:10:31" },
    { ...metadata, segments: "1:1000:40:31" },
  ]) {
    assert.equal(parsePrepaidSeatsCheckoutTerms(broken), null, JSON.stringify(broken));
  }
});
