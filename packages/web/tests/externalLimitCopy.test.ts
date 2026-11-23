import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { externalContextForGate, externalLimitCopy, upgradeDoneMessageId } from "../src/components/billing/upgradeGateCopy";
import { en } from "../src/i18n/messages/en";

// cindyz, Warden: what the external channel limit's dialog says instead of the
// gate's own title or line, from where its Upgrade was met.
test("the external channel limit's words name the channel holding the slot, the open invite, or the channel to connect to", () => {
  const { formatMessage, formatDate } = createIntl({ locale: "en", messages: en });
  const copy = (context: Parameters<typeof externalLimitCopy>[1]) => externalLimitCopy(formatMessage, context, "Acme", formatDate);

  // No channel known: the gate's own title and line.
  assert.deepEqual(copy(undefined), {});
  assert.deepEqual(copy({ kind: "slot" }), {});
  assert.deepEqual(copy({ kind: "slot", openInvite: true }), {});

  assert.deepEqual(copy({ kind: "slot", channel: "#launch" }), {
    hint: "Free includes 1 external channel, and Acme's is #launch. On Pro, Acme can share as many as it needs.",
  });
  assert.deepEqual(copy({ kind: "slot", channel: "#launch", openInvite: true }), {
    hint: "Free includes 1 external channel, and Acme has an open invite to #launch. On Pro, Acme can share as many as it needs.",
  });
  assert.deepEqual(copy({ kind: "connect", channel: "#launch" }), {
    title: "Connect Acme to #launch",
    hint: "Acme's Free plan allows 1 external channel. Pro has no limit.",
  });
});

// Warden: the freeze's dialog before it starts (ExternalFreezeNotice) says from when the
// server can't post; each context is read only with the gate it belongs to.
test("before the external freeze, its dialog says from when, and each context pairs only with its own gate", () => {
  // The deadline is the channel's ISO externalFreezeAt, formatted in the viewer's locale and time zone.
  const { formatMessage, formatDate } = createIntl({ locale: "en", messages: en, timeZone: "UTC" });
  const upcoming = { kind: "freeze_upcoming", deadline: "2026-11-25T15:00:00.000Z" } as const;
  assert.deepEqual(externalLimitCopy(formatMessage, upcoming, "Acme", formatDate), {
    title: "Keep posting in your external channels",
    hint: "Free allows 1 external channel. From Nov 25, 2026, 3:00 PM, Acme can't post in its external channels. Upgrade to keep posting in all of them.",
  });

  const slot = { kind: "slot", channel: "#launch" } as const;
  const connect = { kind: "connect", channel: "#launch" } as const;
  assert.equal(externalContextForGate("external_channel_frozen", upcoming), upcoming);
  assert.equal(externalContextForGate("external_channel_frozen", slot), undefined);
  assert.equal(externalContextForGate("external_channel_frozen", connect), undefined);
  assert.equal(externalContextForGate("external_channel_free_limit", slot), slot);
  assert.equal(externalContextForGate("external_channel_free_limit", connect), connect);
  assert.equal(externalContextForGate("external_channel_free_limit", upcoming), undefined);
  assert.equal(externalContextForGate("history_30d", upcoming), undefined);
  assert.equal(externalContextForGate("external_channel_frozen", undefined), undefined);
});

// Kirby (#15653): the paid toast after upgrading from the notice before the
// freeze must not say "again": the server never stopped posting.
test("the paid toast's line before the freeze says the server keeps posting, after it the gate's own", () => {
  const { formatMessage } = createIntl({ locale: "en", messages: en });
  const upcoming = { kind: "freeze_upcoming", deadline: "2026-11-25T15:00:00.000Z" } as const;
  assert.equal(upgradeDoneMessageId("external_channel_frozen", upcoming), "upgradeDialog.externalFreezeUpcoming.done");
  assert.equal(formatMessage({ id: upgradeDoneMessageId("external_channel_frozen", upcoming) }, { server: "Acme" }), "Acme can keep posting in all its external channels.");
  assert.equal(upgradeDoneMessageId("external_channel_frozen", undefined), "upgradeDialog.externalFrozen.done");
  assert.equal(upgradeDoneMessageId("external_channel_free_limit", upcoming), "upgradeDialog.externalLimit.done");
  assert.equal(upgradeDoneMessageId("history_30d", undefined), "upgradeDialog.history.done");
});
