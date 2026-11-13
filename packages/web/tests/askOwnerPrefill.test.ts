import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { PLAN_UPGRADE_REASON_MAX_LENGTH, UPGRADE_GATES } from "@botiverse/raft-shared";
import { askOwnerPrefill } from "../src/components/billing/upgradeGateCopy";
import { en } from "../src/i18n/messages/en";
import { es } from "../src/i18n/messages/es";
import { ja } from "../src/i18n/messages/ja";
import { ko } from "../src/i18n/messages/ko";
import { ptBr } from "../src/i18n/messages/pt-br";
import { ru } from "../src/i18n/messages/ru";
import { zhCn } from "../src/i18n/messages/zh-cn";
import { zhTw } from "../src/i18n/messages/zh-tw";

const CATALOGS = { en, es, ja, ko, "pt-BR": ptBr, ru, "zh-CN": zhCn, "zh-TW": zhTw } as const;
// A server name runs to 100 characters (SERVER_NAME_MAX_LENGTH).
const LONGEST_NAME = `Northwind ${"Ł".repeat(90)}`;
const codePoints = (text: string) => Array.from(text).length;

// #proj-commercial:#24: the ask-an-owner prefill is a request card's reason,
// so in every language and for every limit it fits, the name cut short if need be.
test("every locale's ask for every limit fits a request card with the longest server name", () => {
  for (const [locale, messages] of Object.entries(CATALOGS)) {
    const intl = createIntl({ locale, messages: { ...en, ...messages } });
    for (const gate of UPGRADE_GATES) {
      const prefill = askOwnerPrefill(intl.formatMessage, gate, LONGEST_NAME, PLAN_UPGRADE_REASON_MAX_LENGTH);
      assert.ok(codePoints(prefill) <= PLAN_UPGRADE_REASON_MAX_LENGTH, `${locale} ${gate}: ${codePoints(prefill)}`);
      assert.ok(prefill.includes("Northwind"), `${locale} ${gate}: names the server`);
      // Whole where it fits (copy naming the server once), else cut short.
      assert.ok(prefill.includes(LONGEST_NAME) || prefill.includes("…"), `${locale} ${gate}: the name whole or cut short`);
    }
  }
});

test("a short server name is left whole, and copy with no room for one is left as written", () => {
  const intl = createIntl({ locale: "en", messages: en });
  assert.equal(askOwnerPrefill(intl.formatMessage, "general", "Acme", PLAN_UPGRADE_REASON_MAX_LENGTH), "Could we upgrade Acme to Pro? Some Free plan limits are getting in our way.");
  const full = intl.formatMessage({ id: "upgradeDialog.general.ask" }, { server: LONGEST_NAME });
  assert.equal(askOwnerPrefill(intl.formatMessage, "general", LONGEST_NAME, 40), full);
});

// cindyz, Warden: the external channel limit's ask names the channel holding the
// server's one Free slot when its Upgrade knows it; a long server name is still cut
// short around the channel, which stays whole.
test("the external channel limit's ask names the channel holding the slot, and still fits a request card", () => {
  const intl = createIntl({ locale: "en", messages: en });
  const ask = (context?: Parameters<typeof askOwnerPrefill>[4], gate: (typeof UPGRADE_GATES)[number] = "external_channel_free_limit") =>
    askOwnerPrefill(intl.formatMessage, gate, "Acme", PLAN_UPGRADE_REASON_MAX_LENGTH, context);
  const named = "Acme's one Free external channel is #launch. Could we upgrade Acme to Pro so we can share more channels outside it?";
  const generic = "Acme's one Free external channel is already in use. Could we upgrade Acme to Pro so we can share more channels outside it?";
  assert.equal(ask({ kind: "slot", channel: "#launch" }), named);
  assert.equal(ask({ kind: "slot", channel: "#launch", openInvite: true }), named);
  assert.equal(ask(), generic);
  assert.equal(ask({ kind: "slot" }), generic);
  assert.equal(ask({ kind: "connect", channel: "#launch" }), generic, "connecting: no slot of this server's to name");
  assert.equal(ask({ kind: "slot", channel: "#launch" }, "external_channel_frozen"), askOwnerPrefill(intl.formatMessage, "external_channel_frozen", "Acme", PLAN_UPGRADE_REASON_MAX_LENGTH));

  for (const [locale, messages] of Object.entries(CATALOGS)) {
    const localized = createIntl({ locale, messages: { ...en, ...messages } });
    const prefill = askOwnerPrefill(localized.formatMessage, "external_channel_free_limit", LONGEST_NAME, PLAN_UPGRADE_REASON_MAX_LENGTH, { kind: "slot", channel: "#launch-planning" });
    assert.ok(codePoints(prefill) <= PLAN_UPGRADE_REASON_MAX_LENGTH, `${locale}: ${codePoints(prefill)}`);
    assert.ok(prefill.includes("#launch-planning"), `${locale}: names the channel whole`);
    assert.ok(prefill.includes("Northwind") && prefill.includes("…"), `${locale}: the server name cut short`);
  }
});

// A channel name has no length limit and is never cut: one too long for the
// request card falls back to the message that names no channel (review of this change).
test("a channel name too long for a request card falls back to the message without it", () => {
  const longChannel = `#${"launch-".repeat(26)}`;
  for (const [locale, messages] of Object.entries(CATALOGS)) {
    const localized = createIntl({ locale, messages: { ...en, ...messages } });
    const prefill = askOwnerPrefill(localized.formatMessage, "external_channel_free_limit", "Acme", PLAN_UPGRADE_REASON_MAX_LENGTH, { kind: "slot", channel: longChannel });
    assert.ok(codePoints(prefill) <= PLAN_UPGRADE_REASON_MAX_LENGTH, `${locale}: ${codePoints(prefill)}`);
    assert.equal(prefill, askOwnerPrefill(localized.formatMessage, "external_channel_free_limit", "Acme", PLAN_UPGRADE_REASON_MAX_LENGTH), `${locale}: the message without the channel`);
  }
});
