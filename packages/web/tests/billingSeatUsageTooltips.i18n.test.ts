import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Billing PR B2b part 5: the two seat-usage bar tooltips.
//
// Each held TWO hand-rolled English plurals in one sentence:
//
//   `${humanCount} human${humanCount === 1 ? "" : "s"} using
//    ${formatSeatUsageNumber(seats)} seat${seats === 1 ? "" : "s"}`
//
// Two separate plural decisions, both in code, both unreachable by a translator —
// and Chinese needs neither. They are one ICU message each now, taking the people
// count, the pre-formatted seat text (it can be fractional, e.g. "1.5"), and the
// raw seat count that drives the second plural.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const intls = {
  en: createIntl({ locale: "en", messages: en }),
  "zh-cn": createIntl({ locale: "zh-cn", messages: zh }),
};
const fmt = (loc: "en" | "zh-cn", id: string, v: Record<string, unknown>) =>
  String(intls[loc].formatMessage({ id }, v as never));

test("both plurals in the human tooltip agree with the old template", () => {
  const id = "billing.humansUsingSeats";
  assert.equal(fmt("en", id, { people: 1, seatsText: "1", seatCount: 1 }), "1 human using 1 seat");
  assert.equal(fmt("en", id, { people: 3, seatsText: "3", seatCount: 3 }), "3 humans using 3 seats");
  // The two counts pluralize INDEPENDENTLY — one human can hold several seats.
  assert.equal(fmt("en", id, { people: 1, seatsText: "2", seatCount: 2 }), "1 human using 2 seats");
  assert.equal(fmt("en", id, { people: 2, seatsText: "1", seatCount: 1 }), "2 humans using 1 seat");
  assert.equal(fmt("zh-cn", id, { people: 3, seatsText: "3", seatCount: 3 }), "3 位人类成员使用 3 个席位");
});

test("both plurals in the agent tooltip agree with the old template", () => {
  const id = "billing.agentsUsingSeats";
  assert.equal(fmt("en", id, { people: 1, seatsText: "0.1", seatCount: 0.1 }), "1 agent using 0.1 seats");
  assert.equal(fmt("en", id, { people: 5, seatsText: "0.5", seatCount: 0.5 }), "5 agents using 0.5 seats");
  assert.equal(fmt("zh-cn", id, { people: 5, seatsText: "0.5", seatCount: 0.5 }), "5 个 Agent 使用 0.5 个席位");
});

test("the seat text is passed through, not re-formatted by the message", () => {
  // formatSeatUsageNumber may return a fraction ("0.1"). If the message took the
  // raw number instead, ICU would apply its own number formatting and could round
  // or localise the separator, silently changing what the tooltip shows.
  for (const loc of ["en", "zh-cn"] as const) {
    assert.match(fmt(loc, "billing.agentsUsingSeats", { people: 2, seatsText: "0.25", seatCount: 0.25 }), /0\.25/);
  }
  for (const cat of [en, zh]) {
    assert.match(cat["billing.agentsUsingSeats"], /\{seatsText\}/, "seat text must be a plain argument");
  }
});

test("zh carries no English plural arms", () => {
  for (const id of ["billing.humansUsingSeats", "billing.agentsUsingSeats"]) {
    assert.ok(!/plural/.test(zh[id]), `${id}: zh needs no plural at all`);
    assert.match(en[id], /\{people, plural,/, `${id}: en pluralizes the people count`);
    assert.match(en[id], /\{seatCount, plural,/, `${id}: en pluralizes the seat noun`);
  }
});
