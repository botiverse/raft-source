import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import type { PrepaidOffer } from "@botiverse/raft-shared";

import { ProCheckoutChoices, useProCheckoutDraft } from "../src/components/billing/ProOffer";
import type { BillingInfo } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

// The checkout's seats row says why the seats start where they do (cindyz,
// #proj-commercial:83cff16f): the seats the server's people and agents already
// use, broken down as Plan & billing shows them, or Pro's floor of two. Never
// "Pro starts at N" for a minimum that is really this server's usage.

function billingWith(humans: number, agents: number): BillingInfo {
  return { usage: { humans, agents, universalSeats: humans + agents / 10 } } as unknown as BillingInfo;
}

const RENEWAL_OFFER: PrepaidOffer = {
  unavailableReason: null,
  periods: [{ months: 1, unitAmount: 1000, currency: "usd" }, { months: 12, unitAmount: 10560, currency: "usd" }],
  graceDays: 3,
  minimumSeatQuantity: 8,
  defaultSeatQuantity: 8,
  renewalStartsAt: null,
} as PrepaidOffer;

function Choices({ billing, renewal }: { billing: BillingInfo; renewal?: PrepaidOffer }) {
  const draft = useProCheckoutDraft(renewal ? { offer: renewal, only: true } : undefined, { billing });
  return <ProCheckoutChoices draft={draft} busy={false} testIdPrefix="t" />;
}

function renderChoices(billing: BillingInfo, renewal?: PrepaidOffer) {
  render(
    <TestIntlProvider locale="en">
      <Choices billing={billing} renewal={renewal} />
    </TestIntlProvider>,
  );
}

const detailsFor = (term: string) => screen.getByText(term).nextElementSibling?.textContent;

afterEach(() => {
  cleanup();
});

test("a whole number of seats in use is said as it is, with no Agents row when there are none", () => {
  renderChoices(billingWith(6, 0));
  assert.equal(screen.getByTestId("t-seats").textContent, "6");
  assert.equal(screen.getByTestId("t-seats-in-use").textContent, "In use on this server: 6 seats.");
  assert.equal(detailsFor("6 people"), "6 seats");
  assert.ok(screen.queryByText(/agents?$/) === null, "absent");
  assert.ok(screen.queryByText(/Pro starts at/) === null, "absent");
});

test("seats in use with a fraction say they are rounded up, and the rows add up to it", () => {
  renderChoices(billingWith(4, 15));
  assert.equal(screen.getByTestId("t-seats").textContent, "6");
  assert.equal(screen.getByTestId("t-seats-in-use").textContent, "In use on this server: 5.5 seats, rounded up to 6.");
  assert.equal(detailsFor("4 people"), "4 seats");
  assert.equal(detailsFor("15 agents"), "1.5 seats (1 per 10 agents)");
});

test("ten agents are one seat, said in the singular, with the rule beside it", () => {
  renderChoices(billingWith(2, 10));
  assert.equal(screen.getByTestId("t-seats-in-use").textContent, "In use on this server: 3 seats.");
  assert.equal(detailsFor("2 people"), "2 seats");
  assert.equal(detailsFor("10 agents"), "1 seat (1 per 10 agents)");
});

test("below two seats in use, the row keeps Pro's floor of two and its note", () => {
  renderChoices(billingWith(1, 0));
  assert.equal(screen.getByTestId("t-seats").textContent, "2");
  assert.ok(screen.getByText("Pro starts at 2 seats."));
  assert.ok(screen.getByText("A seat covers 1 person or 10 agents."));
  assert.ok(screen.queryByTestId("t-seats-in-use") === null, "absent");
  assert.ok(screen.queryByTestId("t-seats-breakdown") === null, "absent");
});

test("an Alipay renewal whose minimum is above what this page read says the seats in use, without the older breakdown", () => {
  renderChoices(billingWith(4, 15), RENEWAL_OFFER);
  assert.equal(screen.getByTestId("t-seats").textContent, "8");
  assert.equal(screen.getByTestId("t-seats-in-use").textContent, "In use on this server: 8 seats.");
  assert.ok(screen.queryByTestId("t-seats-breakdown") === null, "absent");
  assert.ok(screen.queryByText(/Pro starts at/) === null, "absent");
});
