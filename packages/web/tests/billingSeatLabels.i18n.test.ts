import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Billing PR B2b (part 1): the three seat/capacity label helpers.
//
// They used to hand-roll English plurals inside a locale branch:
//   locale === "zh-CN" ? `${n} 个席位` : `${n} seat${n === 1 ? "" : "s"}`
//
// Two defects in one line: the plural rule is English-specific code, and the
// branch forces both languages to share a sentence position. Each is now one ICU
// message, so English gets its plural arm, Chinese needs none, and the composed
// labels ("Adds …" / "增加 …") can order the pieces differently.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const intls = {
  en: createIntl({ locale: "en", messages: en }),
  "zh-cn": createIntl({ locale: "zh-cn", messages: zh }),
};
const fmt = (loc: "en" | "zh-cn", id: string, v?: Record<string, unknown>) =>
  String(intls[loc].formatMessage({ id }, v as never));

test("seat and capacity counts pluralize in English and not in Chinese", () => {
  assert.equal(fmt("en", "billing.seatCount", { count: 1 }), "1 seat");
  assert.equal(fmt("en", "billing.seatCount", { count: 3 }), "3 seats");
  assert.equal(fmt("zh-cn", "billing.seatCount", { count: 1 }), "1 个席位");
  assert.equal(fmt("zh-cn", "billing.seatCount", { count: 3 }), "3 个席位");

  assert.equal(fmt("en", "billing.upToHumans", { count: 1 }), "up to 1 Human");
  assert.equal(fmt("en", "billing.upToHumans", { count: 5 }), "up to 5 Humans");
  assert.equal(fmt("zh-cn", "billing.upToHumans", { count: 5 }), "最多 5 位人类成员");

  assert.equal(fmt("en", "billing.orAgents", { count: 1 }), "or 1 Agent");
  assert.equal(fmt("en", "billing.orAgents", { count: 5 }), "or 5 Agents");
  assert.equal(fmt("zh-cn", "billing.orAgents", { count: 5 }), "或 5 个 Agent");
});

test("the composed seat-delta labels place the count where each language wants it", () => {
  // English appends ("3 seats selected"), Chinese prepends ("已选择 3 个席位").
  // That reordering is the reason these are messages with a {seats} argument
  // rather than string concatenation.
  const seatsEn = fmt("en", "billing.seatCount", { count: 3 });
  const seatsZh = fmt("zh-cn", "billing.seatCount", { count: 3 });

  assert.equal(fmt("en", "billing.addsSeats", { seats: seatsEn }), "Adds 3 seats");
  assert.equal(fmt("zh-cn", "billing.addsSeats", { seats: seatsZh }), "增加 3 个席位");
  assert.equal(fmt("en", "billing.removesSeats", { seats: seatsEn }), "Removes 3 seats");
  assert.equal(fmt("zh-cn", "billing.removesSeats", { seats: seatsZh }), "减少 3 个席位");

  assert.equal(fmt("en", "billing.selectedSeats", { seats: seatsEn }), "3 seats selected");
  assert.equal(fmt("zh-cn", "billing.selectedSeats", { seats: seatsZh }), "已选择 3 个席位");

  // The argument sits at DIFFERENT offsets in the two locales for `selected`.
  // Asserting only that both contain {seats} would pass even if zh were forced
  // into English word order, which is the thing worth preventing.
  assert.notEqual(
    en["billing.selectedSeats"].indexOf("{seats}"),
    zh["billing.selectedSeats"].indexOf("{seats}"),
    "zh must be free to place the count differently from en",
  );
});

test("zh carries no English plural arm", () => {
  for (const id of ["billing.seatCount", "billing.upToHumans", "billing.orAgents"]) {
    assert.ok(!/\bone\s*\{/.test(zh[id]), `${id}: zh must not copy an English one-arm`);
  }
  assert.match(en["billing.seatCount"], /\{count, plural,/, "en seatCount must be an ICU plural");
});
