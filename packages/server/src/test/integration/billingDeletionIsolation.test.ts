import assert from "node:assert/strict";
import https from "node:https";
import { billingDeletionTestTarget, withBillingDeletionIsolation } from "./billingDeletionIsolation";

const target = "postgres://postgres@127.0.0.1:15432/billing_deletion_test";
const env = (url = target): NodeJS.ProcessEnv => ({ BILLING_DELETION_REAL_PG_URL: url, BILLING_DELETION_DISPOSABLE_INSTANCE: "1" });

test("test target refuses nonlocal, overridden, credential-bearing and unacknowledged inputs before loading", async () => {
  for (const input of [
    { ...env(), BILLING_DELETION_DISPOSABLE_INSTANCE: "0" }, env("not a URL"),
    env(target.replace("127.0.0.1", "production.invalid")), env(target.replace("billing_deletion_test", "postgres")),
    env(target + "?host=production.invalid"), env(target + "?options=-c%20search_path=public"),
    env(target + "#fragment"), env(target.replace("postgres@", "postgres:synthetic-secret-marker@")),
    env(target.replace(":15432", "")),
  ]) {
    let loaded = false;
    await assert.rejects(withBillingDeletionIsolation(input, async () => { loaded = true; }), /Billing deletion test/);
    assert.equal(loaded, false, "no connection or mail module loader may run for a refused target");
  }
});

test("test target produces explicit driver fields that cannot inherit pg credentials", () => {
  const configured = billingDeletionTestTarget(env(target.replace("127.0.0.1", "localhost")));
  assert.equal(configured.pool.host, "127.0.0.1");
  assert.equal(configured.pool.database, "billing_deletion_test");
  assert.equal(configured.pool.password, "synthetic-billing-test-only");
  assert.equal(configured.pool.ssl, false);
  assert.ok(!("connectionString" in configured.pool), "URL queries cannot override validated driver fields");
});

test("test entry clears inherited delivery and pg credentials before its module loader and blocks external transport", async () => {
  const configured = { ...env(), PGPASSWORD: "synthetic-pg-marker", PGPASSFILE: "/synthetic/path", PGHOST: "production.invalid", STRIPE_SECRET_KEY: "synthetic-stripe-marker", RESEND_API_KEY: "synthetic-mail-marker" };
  const before = { ...configured };
  await withBillingDeletionIsolation(configured, async () => {
    assert.equal(configured.PGPASSWORD, undefined);
    assert.equal(configured.PGPASSFILE, undefined);
    assert.equal(configured.PGHOST, undefined);
    assert.equal(configured.RESEND_API_KEY, "");
    assert.equal(configured.STRIPE_SECRET_KEY, "sk_test_synthetic_only");
    assert.throws(() => https.request("https://external.invalid/"), /refuse HTTP delivery/);
    await assert.rejects(async () => fetch("https://external.invalid/"), /refuse HTTP delivery/);
  });
  assert.deepEqual(configured, before, "restore inherited values and remove every synthetic setting only after the isolated work settles");
});
