import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ONBOARDING_EVIDENCE,
  ONBOARDING_EXTERNAL_EVENTS,
  ONBOARDING_STATES,
  ONBOARDING_STATE_MACHINE_CONTRACT,
  ONBOARDING_TRANSITIONS,
} from "./onboardingStateMachineContract.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(`${repoRoot}RELEASE_SOURCE`);

const CANONICAL_TRANSITION_TUPLES = [
  "auth.register.needs_verification|A0_AUTH_ENTRY|A1_EMAIL_VERIFY",
  "auth.verified.needs_identity|A1_EMAIL_VERIFY|A2_IDENTITY_REQUIRED",
  "auth.oauth.needs_identity|A0_AUTH_ENTRY|A2_IDENTITY_REQUIRED",
  "auth.invite.resume|A0_AUTH_ENTRY|A3_INVITE_ACCEPT",
  "identity.invite.resume|A2_IDENTITY_REQUIRED|A3_INVITE_ACCEPT",
  "identity.server_select|A2_IDENTITY_REQUIRED|A4_SERVER_SELECT_CREATE",
  "invite.member_bypass|A3_INVITE_ACCEPT|A6_MEMBER_BYPASS",
  "server.owner_gate|A4_SERVER_SELECT_CREATE|A5_OWNER_GATE",
  "server.member_bypass|A4_SERVER_SELECT_CREATE|A6_MEMBER_BYPASS",
  "owner.new_server.connect|A5_OWNER_GATE|S0_CONNECT",
  "owner.legacy.resume|A5_OWNER_GATE|L0_LEGACY_DEFERRED",
  "owner.post_setup.survey|A5_OWNER_GATE|P1_SURVEY",
  "owner.post_setup.handoff|A5_OWNER_GATE|P2_HANDOFF",
  "owner.complete.normal_app|A5_OWNER_GATE|NORMAL_APP",
  "member.normal_app|A6_MEMBER_BYPASS|NORMAL_APP",
  "setup.connect.offline|S0_CONNECT|S1_OFFLINE_RECOVERY",
  "setup.connect.online|S0_CONNECT|S2_RUNTIME_CHECK",
  "setup.offline.online|S1_OFFLINE_RECOVERY|S2_RUNTIME_CHECK",
  "setup.offline.reset_confirm|S1_OFFLINE_RECOVERY|R0_RESET_CONFIRM",
  "setup.check.offline|S2_RUNTIME_CHECK|S1_OFFLINE_RECOVERY",
  "setup.check.missing|S2_RUNTIME_CHECK|S3_RUNTIME_MISSING",
  "setup.check.ready|S2_RUNTIME_CHECK|S4_READY",
  "setup.missing.offline|S3_RUNTIME_MISSING|S1_OFFLINE_RECOVERY",
  "setup.missing.ready|S3_RUNTIME_MISSING|S4_READY",
  "setup.ready.offline|S4_READY|S1_OFFLINE_RECOVERY",
  "setup.ready.meet_cindy|S4_READY|S5_MEET_CINDY",
  "setup.meet_cindy.reset_confirm|S5_MEET_CINDY|R0_RESET_CONFIRM",
  "setup.meet_cindy.checkpoint|S5_MEET_CINDY|P0_CINDY_COLD",
  "reset.cancel|R0_RESET_CONFIRM|ORIGIN",
  "reset.confirm|R0_RESET_CONFIRM|R1_RESETTING",
  "reset.success|R1_RESETTING|S0_CONNECT",
  "post_setup.survey|P0_CINDY_COLD|P1_SURVEY",
  "post_setup.handoff|P0_CINDY_COLD|P2_HANDOFF",
  "survey.handoff|P1_SURVEY|P2_HANDOFF",
  "handoff.online|P2_HANDOFF|N0_NORMAL_ONLINE",
  "handoff.offline|P2_HANDOFF|N1_NORMAL_OFFLINE",
  "normal.online.offline|N0_NORMAL_ONLINE|N1_NORMAL_OFFLINE",
  "normal.offline.online|N1_NORMAL_OFFLINE|N0_NORMAL_ONLINE",
  "legacy.resume.connect|L0_LEGACY_DEFERRED|S0_CONNECT",
  "legacy.resume.offline|L0_LEGACY_DEFERRED|S1_OFFLINE_RECOVERY",
  "legacy.resume.runtime|L0_LEGACY_DEFERRED|S2_RUNTIME_CHECK",
] as const;

function assertCanonicalTransitionTable(
  transitions: readonly { id: string; from: string; to: string }[],
) {
  assert.equal(transitions.length, 41, "canonical transition count drifted");
  assert.deepEqual(
    transitions.map(({ id, from, to }) => `${id}|${from}|${to}`),
    CANONICAL_TRANSITION_TUPLES,
    "canonical transition IDs/from/to drifted",
  );
}

test("onboarding state-machine SSOT has exactly 21 states, 41 transitions, and 16 external event classes", () => {
  assert.equal(ONBOARDING_STATE_MACHINE_CONTRACT.schemaVersion, "onboarding-state-machine.v1");
  assert.equal(ONBOARDING_STATES.length, 21);
  assertCanonicalTransitionTable(ONBOARDING_TRANSITIONS);
  assert.equal(ONBOARDING_EXTERNAL_EVENTS.length, 16);
  assert.equal(new Set(ONBOARDING_STATES.map((state) => state.id)).size, ONBOARDING_STATES.length);
  assert.equal(new Set(ONBOARDING_EXTERNAL_EVENTS.map((event) => event.id)).size, ONBOARDING_EXTERNAL_EVENTS.length);
  assert.equal(new Set(ONBOARDING_TRANSITIONS.map((transition) => transition.id)).size, ONBOARDING_TRANSITIONS.length);
});

test("deleting any one canonical transition is rejected", () => {
  for (const deleted of ONBOARDING_TRANSITIONS) {
    assert.throws(
      () => assertCanonicalTransitionTable(
        ONBOARDING_TRANSITIONS.filter((transition) => transition.id !== deleted.id),
      ),
      `deleting ${deleted.id} must fail the canonical transition ratchet`,
    );
  }
});

test("every onboarding state, transition, and external event has executable evidence", () => {
  const evidenceIds = new Set(ONBOARDING_EVIDENCE.map((evidence) => evidence.id));
  const stateIds = new Set(ONBOARDING_STATES.map((state) => state.id));

  for (const subject of [...ONBOARDING_STATES, ...ONBOARDING_TRANSITIONS, ...ONBOARDING_EXTERNAL_EVENTS]) {
    assert.ok(subject.evidence.length > 0, `${subject.id} has no evidence`);
    for (const evidenceId of subject.evidence) {
      assert.ok(evidenceIds.has(evidenceId), `${subject.id} references missing evidence ${evidenceId}`);
    }
  }

  for (const state of ONBOARDING_STATES) assert.ok(state.invariant.trim(), `${state.id} has no invariant`);
  for (const transition of ONBOARDING_TRANSITIONS) assert.ok(transition.trigger.trim(), `${transition.id} has no trigger`);
  for (const event of ONBOARDING_EXTERNAL_EVENTS) assert.ok(event.invariant.trim(), `${event.id} has no invariant`);

  for (const transition of ONBOARDING_TRANSITIONS) {
    assert.ok(stateIds.has(transition.from), `${transition.id} has unknown source ${transition.from}`);
    assert.ok(
      transition.to === "ORIGIN" || transition.to === "NORMAL_APP" || stateIds.has(transition.to),
      `${transition.id} has unknown destination ${transition.to}`,
    );
  }

  for (const state of ONBOARDING_STATES) {
    assert.ok(
      ONBOARDING_TRANSITIONS.some((transition) => transition.from === state.id),
      `${state.id} has no explicit outgoing transition`,
    );
  }
});

test("every onboarding evidence anchor still names a real executable test", async () => {
  for (const evidence of ONBOARDING_EVIDENCE) {
    const source = await readFile(`${repoRoot}${evidence.file}`, "utf8");
    assert.ok(
      source.includes(`test("${evidence.testName}"`) || source.includes(`test('${evidence.testName}'`),
      `${evidence.id} no longer resolves to test ${evidence.testName} in ${evidence.file}`,
    );
  }
});

test("staging audit is scheduled, artifact-exact, locale-independent, pull-request runnable, repo-Node pinned, and evidence preserving", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, async () => {
  const workflow = await readFile(`${repoRoot}.github/workflows/onboarding-staging-audit.yml`, "utf8");
  const stagingSpec = await readFile(
    `${repoRoot}packages/web/tests/e2e/staging/onboarding-entry.staging.spec.ts`,
    "utf8",
  );
  const releaseIdentityProducer = await readFile(
    `${repoRoot}packages/web/scripts/frontendReleaseIdentity.ts`,
    "utf8",
  );

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /cron: "23 18 \* \* \*"/);
  assert.match(workflow, /node-version-file: \.node-version/);
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.doesNotMatch(
    workflow,
    /ONBOARDING_STAGING_EXPECTED_SHA|github\.event_name.*schedule.*github\.sha/,
    "the live audit must not compare a deployed artifact with the independently advancing workflow source",
  );
  assert.match(workflow, /playwright test --config playwright\.staging\.config\.ts/);
  assert.match(workflow, /if: failure\(\)/);
  assert.match(workflow, /retention-days: 14/);

  assert.match(
    stagingSpec,
    /page\.locator\(["']#raft-frontend-release-identity["']\)\.textContent\(\)/,
    "the staging spec must read the release identity embedded in the served artifact",
  );
  assert.match(
    stagingSpec,
    /environmentBadgeText\.toLowerCase\(\)[\s\S]*?\.toContain\(deployedCommitSha\.slice\(0,\s*8\)\.toLowerCase\(\)\)/,
    "the staging spec must require the badge to match the served artifact's short revision",
  );
  assert.match(
    releaseIdentityProducer,
    /deploymentEnvironment:\s*clean\(environment\.VITE_DEPLOYMENT_ENV\)/,
    "the served artifact identity must preserve its build-time deployment environment",
  );
  assert.match(
    stagingSpec,
    /deploymentEnvironment[\s\S]*?\.toBe\(["']staging["']\)/,
    "the staging audit must require the served artifact to identify itself as staging",
  );
  assert.match(
    stagingSpec,
    /LEGACY_STAGING_IDENTITY_COMMIT\s*=\s*[\s\S]*?["']5ec11a117b015142bae8b8a29b45fa2dcc6ed328["'][\s\S]*?\.toBe\(LEGACY_STAGING_IDENTITY_COMMIT\)/,
    "the one pre-field staging artifact must be the only bounded compatibility exception",
  );
  assert.doesNotMatch(
    stagingSpec,
    /\.toContain\(["']staging["']\)/i,
    "the staging audit must not pin the translated environment label to English presentation copy",
  );
});
