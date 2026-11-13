import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { externalLimitCopy } from "../src/components/billing/upgradeGateCopy";
import { en } from "../src/i18n/messages/en";

// cindyz, Warden: what the external channel limit's dialog says instead of the
// gate's own title or line, from where its Upgrade was met.
test("the external channel limit's words name the channel holding the slot, the open invite, or the channel to connect to", () => {
  const { formatMessage } = createIntl({ locale: "en", messages: en });
  const copy = (context: Parameters<typeof externalLimitCopy>[1]) => externalLimitCopy(formatMessage, context, "Acme");

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
