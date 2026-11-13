import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { accountDeletionRequests, featureFlags } from "../db/schema";
import { requestAccountDeletion } from "../services/accountDeletion/requests";
import { computeTokenLookupHash } from "../services/agentCredentialService";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { signInForTest } from "../test/integration/credentials";

// The one-time link in the "scheduled for deletion" email
// (POST /api/auth/account-deletion/cancel, no sign-in): it cancels that one
// request through the same path as DELETE /api/me/account/deletion, once,
// until the request's scheduled_for; every refusal is the same 400.

/** The retired `account_deletion_v0` row as production may still hold it (#raft-architecture:#32): read by nothing now. */
async function seedRetiredDeletionFlag(defaultEnabled: boolean): Promise<void> {
  await getDb().insert(featureFlags)
    .values({ key: "account_deletion_v0", randomizationUnit: "user", salt: "test", defaultEnabled })
    .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled } });
}

const test = createApiTest();

const savedPepper = process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
beforeAll(() => {
  process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = "account-deletion-test-pepper-0123456789abcdef";
});
afterAll(() => {
  if (savedPepper === undefined) delete process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
  else process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = savedPepper;
});

const CANCEL = "/api/auth/account-deletion/cancel";
const passwordUser = { passwordCredentialEstablishedAt: new Date() };

/** The raw response, so invalid answers can be compared byte for byte. */
async function postCancel(baseUrl: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${baseUrl}${CANCEL}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

function captureEmails() {
  const deliveries: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => deliveries.push(delivery));
  return { deliveries, stop: () => __setEmailDeliveryObserverForTests(null) };
}

/** Requests the person's deletion and returns the token from the link in the "requested" email (text and html alike). */
async function requestAndReadLink(userId: string, deliveries: EmailDelivery[]): Promise<string> {
  const outcome = await requestAccountDeletion({ userId, source: "self", actorUserId: userId });
  assert.equal(outcome.kind, "scheduled");
  const mail = deliveries.at(-1)!;
  assert.match(mail.subject, /will be deleted on/);
  assert.match(mail.text!, /Changed your mind\? Cancel the deletion/);
  const fromText = /\/\?cancel_account_deletion=([A-Za-z0-9_-]+)/.exec(mail.text!)?.[1];
  const fromHtml = /\/\?cancel_account_deletion=([A-Za-z0-9_-]+)/.exec(mail.html)?.[1];
  assert.ok(fromText, mail.text);
  assert.equal(fromHtml, fromText);
  assert.match(mail.html, /Cancel the deletion<\/a>/);
  return fromText;
}

const pendingRequest = async (userId: string) =>
  (await getDb().select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, userId)))[0];

test("the emailed link cancels the request once: 200 none, cancelled, the cancelled email, token voided; only its hash was ever stored", async ({ app, seed }) => {
  const human = await seed.human(passwordUser);
  const emails = captureEmails();
  try {
    const token = await requestAndReadLink(human.id, emails.deliveries);
    const stored = await pendingRequest(human.id);
    assert.ok(stored?.cancelTokenHash);
    const storedHash = Buffer.from(stored.cancelTokenHash);
    assert.ok(storedHash.equals(computeTokenLookupHash(token)), "the HMAC lookup hash is stored");
    assert.ok(!storedHash.toString("utf8").includes(token), "never the raw token");

    // A repeat while pending: same request, no new email, no new token.
    const again = await requestAccountDeletion({ userId: human.id, source: "self", actorUserId: human.id });
    assert.equal(again.kind === "scheduled" && again.effects, null);
    assert.equal(emails.deliveries.length, 1);
    assert.ok(Buffer.from((await pendingRequest(human.id))!.cancelTokenHash!).equals(storedHash));

    const cancelled = await postCancel(app.baseUrl, { token });
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.deepEqual(JSON.parse(cancelled.text), { status: "none", subscriptionRestoration: "restored" });
    const row = await pendingRequest(human.id);
    assert.equal(row?.state, "cancelled");
    assert.ok(row?.cancelledAt);
    assert.equal(row?.cancelTokenHash, null, "voided once used");
    assert.equal(emails.deliveries.length, 2);
    assert.match(emails.deliveries[1]!.subject, /will not be deleted/);

    // Used: the same 400 as any invalid token; nothing more is sent.
    const reused = await postCancel(app.baseUrl, { token });
    assert.equal(reused.status, 400);
    assert.equal(JSON.parse(reused.text).code, "account_deletion_token_invalid");
    assert.equal(emails.deliveries.length, 2);
  } finally {
    emails.stop();
  }
});

test("every refusal is the same 400 account_deletion_token_invalid: malformed, unknown, used, expired, no longer pending, flag off", async ({ app, seed }) => {
  const emails = captureEmails();
  try {
    const answers: Array<{ what: string; status: number; text: string }> = [];
    const record = async (what: string, body: unknown) => answers.push({ what, ...(await postCancel(app.baseUrl, body)) });

    await record("no token", {});
    await record("not a string", { token: 42 });
    await record("malformed", { token: "not-a-cancel-token" });
    await record("unknown", { token: `adcl_${"A".repeat(43)}` });
    await record("too long", { token: `adcl_${"A".repeat(200)}` });

    // Used.
    const used = await seed.human(passwordUser);
    const usedToken = await requestAndReadLink(used.id, emails.deliveries);
    assert.equal((await postCancel(app.baseUrl, { token: usedToken })).status, 200);
    await record("used", { token: usedToken });

    // Expired: the request's scheduled_for has come (the cleanup hasn't run yet).
    const expired = await seed.human(passwordUser);
    const expiredToken = await requestAndReadLink(expired.id, emails.deliveries);
    await getDb().update(accountDeletionRequests).set({ scheduledFor: new Date(Date.now() - 1000) }).where(eq(accountDeletionRequests.userId, expired.id));
    await record("expired", { token: expiredToken });
    assert.equal((await pendingRequest(expired.id))?.state, "pending", "an expired link cancels nothing");

    // No longer pending (completed by the cleanup), the hash somehow still set.
    const completed = await seed.human(passwordUser);
    const completedToken = await requestAndReadLink(completed.id, emails.deliveries);
    await getDb().update(accountDeletionRequests).set({ state: "completed", completedAt: new Date() }).where(eq(accountDeletionRequests.userId, completed.id));
    await record("completed", { token: completedToken });

    // Cancelled while signed in: that voids the link too.
    const signedIn = await seed.human(passwordUser);
    const signedInToken = await requestAndReadLink(signedIn.id, emails.deliveries);
    const session = await signInForTest(signedIn.id);
    const deleted = await fetch(`${app.baseUrl}/api/me/account/deletion`, { method: "DELETE", headers: { Authorization: `Bearer ${session.token}` } });
    assert.equal(deleted.status, 200);
    assert.equal((await pendingRequest(signedIn.id))?.cancelTokenHash, null);
    await record("cancelled signed in", { token: signedInToken });

    // A leftover account_deletion_v0 row, even off, no longer voids the link.
    const retiredFlagOff = await seed.human(passwordUser);
    const retiredFlagOffToken = await requestAndReadLink(retiredFlagOff.id, emails.deliveries);
    await seedRetiredDeletionFlag(false);
    assert.equal((await postCancel(app.baseUrl, { token: retiredFlagOffToken })).status, 200, "the link works whatever the retired row says");

    for (const answer of answers) {
      assert.equal(answer.status, 400, answer.what);
      assert.equal(answer.text, answers[0]!.text, `${answer.what}: byte-identical to every other refusal`);
    }
    assert.equal(JSON.parse(answers[0]!.text).code, "account_deletion_token_invalid");
    assert.equal(typeof JSON.parse(answers[0]!.text).error, "string");
  } finally {
    emails.stop();
  }
});

test("a cancel link still succeeds when its subscription cannot be restored and returns the warning", async ({ app, seed }) => {
  const human = await seed.human(passwordUser);
  const server = await seed.server({ owner: human, name: "Unconfirmed billing" });
  const emails = captureEmails();
  try {
    const token = await requestAndReadLink(human.id, emails.deliveries);
    await getDb().update(accountDeletionRequests).set({ cancelledSubscriptionSnapshots: {
      [server.id]: { stripeSubscriptionId: "sub_unconfirmed_fixture", canceledAt: null },
    } }).where(eq(accountDeletionRequests.userId, human.id));
    const result = await postCancel(app.baseUrl, { token });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.text), { status: "none", subscriptionNotResumed: true, subscriptionRestoration: "not_restored" });
    const row = await pendingRequest(human.id);
    assert.equal(row?.state, "cancelled");
    assert.equal(row?.cancelTokenHash, null);
    assert.match(emails.deliveries.at(-1)?.text ?? "", /not automatically restored/);
  } finally { emails.stop(); }
});
