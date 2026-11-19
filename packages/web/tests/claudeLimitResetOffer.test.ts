import assert from "node:assert/strict";
import { claudeLimitResetOffer } from "../src/features/computer/claudeLimitResetOffer";

// What the usage card offers about Claude limit resets (#triage:#373): a
// person who cannot use them may still read the list where the server lets
// them; where they could do nothing at all they get no entry, not a button
// beside a note explaining why it leads nowhere.

const CONNECTED = { canUse: true, canConsent: true };
const NOT_CONNECTED = { canUse: false, canConsent: false };
type Offer = Parameters<typeof claudeLimitResetOffer>[0];
const offer = (over: Partial<Offer> = {}) => claudeLimitResetOffer({
  provider: "claude",
  flagOn: true,
  canActOnRuntimes: true,
  authStatus: null,
  authView: { claudeLimitResets: "ok", claudeLimitResetAccess: CONNECTED },
  atFiveHourLimit: false,
  notSupportedHere: false,
  ...over,
});

test("the person who connected the Computer is offered its Claude limit resets", () => {
  assert.equal(offer(), "ok");
  assert.equal(offer({ atFiveHourLimit: true }), "ok");
});

test("an owner or admin who did not connect the Computer can only view the list, where the read needs no consent", () => {
  assert.equal(offer({ authView: { claudeLimitResets: "ok", claudeLimitResetAccess: NOT_CONNECTED } }), "view_only");
});

test("an owner or admin who did not connect the Computer gets no entry at the 5-hour limit, where the read needs consent", () => {
  assert.equal(offer({ atFiveHourLimit: true, authView: { claudeLimitResets: "ok", claudeLimitResetAccess: NOT_CONNECTED } }), null);
});

test("a person who cannot use a reset is never offered the consent step, whatever canConsent says", () => {
  // The server sends both alike; a read with consent can spend the connecting person's 5-hour reset.
  const access = { canUse: false, canConsent: true };
  assert.equal(offer({ atFiveHourLimit: true, authView: { claudeLimitResets: "ok", claudeLimitResetAccess: access } }), null);
  assert.equal(offer({ authView: { claudeLimitResets: "ok", claudeLimitResetAccess: access } }), "view_only");
});

test("a Computer that needs an upgrade for Claude limit resets is offered to no one: the card draws nothing for it", () => {
  assert.equal(offer({ authView: { claudeLimitResets: "computer_upgrade_required", claudeLimitResetAccess: CONNECTED } }), null);
  assert.equal(offer({ authView: { claudeLimitResets: "computer_upgrade_required", claudeLimitResetAccess: NOT_CONNECTED } }), null);
});

test("a server that does not say who may use them still offers them (its routes decide)", () => {
  assert.equal(offer({ authView: { claudeLimitResets: "ok" } }), "ok");
});

test("nothing is offered off Claude, with the flag off, to a person who may not act, signed out, or where the Computer cannot run them", () => {
  assert.equal(offer({ provider: "codex" }), null);
  assert.equal(offer({ flagOn: false }), null);
  assert.equal(offer({ canActOnRuntimes: false }), null);
  assert.equal(offer({ authStatus: { kind: "logged_out" } }), null);
  assert.equal(offer({ authView: {} }), null);
  assert.equal(offer({ authView: null }), null);
  assert.equal(offer({ notSupportedHere: true }), null);
});
