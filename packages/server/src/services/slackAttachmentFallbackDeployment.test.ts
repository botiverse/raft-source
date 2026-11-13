import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import { getDb } from "../db/index";
import { slackAttachmentPlanRollout } from "../db/schema";
import { applySlackAttachmentFallbackDeployment, parseSlackAttachmentFallbackDeployment } from "./slackAttachmentFallbackDeployment";
import { isSlackAttachmentPlanningEnabled } from "./slackAttachmentFallbackProtocol";

const NOW = new Date("2026-10-29T12:00:00Z");
function config(enabled: boolean, generation: number) {
  const result = parseSlackAttachmentFallbackDeployment({ SLACK_BRIDGE_ATTACHMENT_FALLBACK_ENABLED: String(enabled),
    SLACK_BRIDGE_ATTACHMENT_FALLBACK_CONFIG_GENERATION: String(generation),
    SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_RELEASE: "a".repeat(40), SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_BY: "@test-verifier" });
  assert.ok(result); return result;
}
beforeEach(async () => { await openTestDatabase(); });
afterEach(async () => { await closeTestDatabase(); });

test("deployment configuration is absent by default and rejects incomplete activation", () => {
  assert.equal(parseSlackAttachmentFallbackDeployment({}), undefined);
  for (const generation of [undefined, "0", "-1", "1.5", "01", "2147483648"]) {
    assert.throws(() => parseSlackAttachmentFallbackDeployment({ SLACK_BRIDGE_ATTACHMENT_FALLBACK_ENABLED: "true",
      SLACK_BRIDGE_ATTACHMENT_FALLBACK_CONFIG_GENERATION: generation, SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_RELEASE: "a".repeat(40), SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_BY: "@test-verifier" }));
  }
  assert.throws(() => parseSlackAttachmentFallbackDeployment({ SLACK_BRIDGE_ATTACHMENT_FALLBACK_ENABLED: "true",
    SLACK_BRIDGE_ATTACHMENT_FALLBACK_CONFIG_GENERATION: "1" }));
  for (const verifier of [undefined, "", "x".repeat(161), "@name\n@other"]) {
    assert.throws(() => parseSlackAttachmentFallbackDeployment({ SLACK_BRIDGE_ATTACHMENT_FALLBACK_ENABLED: "true",
      SLACK_BRIDGE_ATTACHMENT_FALLBACK_CONFIG_GENERATION: "1", SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_RELEASE: "a".repeat(40),
      SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_BY: verifier }));
  }
  assert.deepEqual(config(false, 1), { enabled: false, generation: 1 });
});

test("reviewed configuration enables the real DB control; higher-generation pause survives stale instances", async () => {
  const db = getDb();
  assert.equal(await isSlackAttachmentPlanningEnabled(db), false);
  assert.equal(await applySlackAttachmentFallbackDeployment({ db, config: config(true, 1), now: NOW }), "applied");
  assert.equal(await isSlackAttachmentPlanningEnabled(db), true);
  assert.equal(await applySlackAttachmentFallbackDeployment({ db, config: config(true, 1), now: NOW }), "unchanged");
  assert.equal(await applySlackAttachmentFallbackDeployment({ db, config: config(false, 1), now: NOW }), "conflict");
  assert.equal(await isSlackAttachmentPlanningEnabled(db), true, "same-generation contradictory configuration cannot overwrite the decision");
  const otherVerifier = parseSlackAttachmentFallbackDeployment({ SLACK_BRIDGE_ATTACHMENT_FALLBACK_ENABLED: "true",
    SLACK_BRIDGE_ATTACHMENT_FALLBACK_CONFIG_GENERATION: "1", SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_RELEASE: "a".repeat(40),
    SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_BY: "@other-verifier" });
  assert.ok(otherVerifier);
  assert.equal(await applySlackAttachmentFallbackDeployment({ db, config: otherVerifier, now: NOW }), "conflict",
    "changing the accountable verifier also requires a new generation");
  await assert.rejects(db.update(slackAttachmentPlanRollout).set({ enabled: false }), "old manual writers cannot override a generation");
  assert.equal(await applySlackAttachmentFallbackDeployment({ db, config: config(false, 2), now: NOW }), "applied");
  assert.equal(await isSlackAttachmentPlanningEnabled(db), false);
  const oldWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try { assert.equal(await applySlackAttachmentFallbackDeployment({ db, config: config(true, 1), now: NOW }), "older_config"); }
  finally { console.warn = oldWarn; }
  assert.deepEqual(warnings, [["[SlackBridge] older attachment deployment configuration ignored", { requestedGeneration: 1, currentGeneration: 2 }]]);
  assert.equal(await isSlackAttachmentPlanningEnabled(db), false, "restarted old-config instances cannot re-enable planning");
  const [state] = await db.select().from(slackAttachmentPlanRollout);
  assert.equal(state.configGeneration, 2); assert.equal(state.minimumWriterVersion, 1);
  assert.equal(state.verifiedBy, "@test-verifier", "the real accountable verifier survives a pause");
  await assert.rejects(db.update(slackAttachmentPlanRollout).set({ configGeneration: 1 }));
  await assert.rejects(db.delete(slackAttachmentPlanRollout));
  assert.equal(await applySlackAttachmentFallbackDeployment({ db, config: config(true, 3), now: NOW }), "applied");
  assert.equal(await isSlackAttachmentPlanningEnabled(db), true);
});

test("configuration cannot activate while a database writer barrier is missing", async () => {
  const db = getDb();
  await db.execute(sql`alter table external_attachment_transfer_jobs disable trigger slack_attachment_plan_job_write_fence`);
  await assert.rejects(applySlackAttachmentFallbackDeployment({ db, config: config(true, 1), now: NOW }), /database protocol/);
  assert.equal((await db.select().from(slackAttachmentPlanRollout).where(eq(slackAttachmentPlanRollout.id, "slack-attachment-plan-v1"))).length, 0,
    "failed activation rolls back its partial control row");
});
