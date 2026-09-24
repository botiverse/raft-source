import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  type HFamilyAssertionObservation,
  H1_LIVE_PROCESS_EMPTY_HOME,
  H_FAMILY_EXPECTED_ASSERTIONS,
  H_FAMILY_QA_FIXTURES,
  H_FAMILY_SERVER_ID,
  evaluateHFamilyExpectedAssertion,
  generateHFamilyCases,
  hFamilyExpectedAssertionDefinition,
  hFamilyQaOwnerPath,
  hFamilyTargetPath,
  identityAuthorityPilotCases,
  injectHFamilyCase,
  injectHFamilyQaFixture,
} from "./h-family-chaos.js";
import {
  serverAttachmentPath,
  servicePidPath,
  userSessionPath,
} from "../paths.js";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-h-family-"));
  try {
    return await fn(home);
  } finally {
    await chmodTreeBestEffort(home);
    await rm(home, { recursive: true, force: true });
  }
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

test("H-family identity pilot is deterministic and includes H-1", () => {
  const cases = identityAuthorityPilotCases();

  assert.equal(cases.length, 10);
  assert.equal(cases[0].id, "H-1-live-process-empty-home");
  assert.equal(new Set(cases.map((candidate) => candidate.id)).size, cases.length);
  for (const candidate of cases) {
    assert.equal(candidate.role, "identity-authority");
    assert.equal(candidate.expectedBehavior, "fail-closed-with-recovery");
    assert.match(candidate.expectedAssertionId, /^identity-/);
    assert.match(candidate.expectedAssertion, /recovery|fail closed|stop/i);
  }
});

test("H-family full matrix covers identity compatibility runtime and version roles", () => {
  const cases = generateHFamilyCases();
  const byRole = new Map<string, number>();
  for (const candidate of cases) {
    byRole.set(candidate.role, (byRole.get(candidate.role) ?? 0) + 1);
    assert.ok(candidate.expectedAssertionId.length > 0, candidate.id);
    assert.equal(
      hFamilyExpectedAssertionDefinition(candidate.expectedAssertionId).description,
      candidate.expectedAssertion,
      candidate.id,
    );
  }

  assert.equal(cases.length, 80);
  assert.deepEqual(Object.fromEntries(byRole), {
    "identity-authority": 16,
    "compatibility-fallback": 16,
    "runtime-evidence": 32,
    "version-evidence": 16,
  });
});

test("H-family assertion ids map to executable predicates", () => {
  const passing: Record<keyof typeof H_FAMILY_EXPECTED_ASSERTIONS, HFamilyAssertionObservation> = {
    "identity-fail-closed-recovery": observation({
      reportedAuthority: false,
      authoritySource: "none",
      recoveryActions: ["login"],
      userFacingFailure: true,
    }),
    "identity-live-process-not-authority": observation({
      reportedAuthority: false,
      authoritySource: "none",
      recoveryActions: ["stop"],
      userFacingFailure: true,
    }),
    "compatibility-silent-self-heal": observation({
      userFacingFailure: false,
      canonicalStateRebuilt: true,
    }),
    "runtime-regenerate-from-observation": observation({
      userFacingFailure: false,
      runtimeEvidenceRegenerated: true,
    }),
    "version-skew-suspect": observation({
      userFacingFailure: true,
      skewSuspect: true,
    }),
  };
  const failing = observation({
    reportedAuthority: true,
    authoritySource: "live-process",
    userFacingFailure: false,
  });

  assert.deepEqual(Object.keys(H_FAMILY_EXPECTED_ASSERTIONS).sort(), [
    "compatibility-silent-self-heal",
    "identity-fail-closed-recovery",
    "identity-live-process-not-authority",
    "runtime-regenerate-from-observation",
    "version-skew-suspect",
  ]);
  for (const [id, positive] of Object.entries(passing)) {
    assert.equal(
      evaluateHFamilyExpectedAssertion(id as keyof typeof H_FAMILY_EXPECTED_ASSERTIONS, positive),
      true,
      id,
    );
    assert.equal(
      evaluateHFamilyExpectedAssertion(id as keyof typeof H_FAMILY_EXPECTED_ASSERTIONS, failing),
      false,
      id,
    );
  }
});

test("H-family generator expands identity authority files before the full matrix", () => {
  const cases = generateHFamilyCases({ role: "identity-authority", limit: 4 });

  assert.deepEqual(cases.map((candidate) => candidate.id), [
    "H-user-session-absent-cold",
    "H-user-session-absent-live",
    "H-user-session-corrupt-json-cold",
    "H-user-session-corrupt-json-live",
  ]);
});

test("H-1 injection creates live service evidence without login or attachment authority", async () => {
  await withHome(async (home) => {
    await injectHFamilyCase(home, H1_LIVE_PROCESS_EMPTY_HOME);

    assert.equal(await exists(servicePidPath(home)), true);
    assert.equal((await readFile(servicePidPath(home), "utf8")).trim(), String(process.pid));
    assert.equal(await exists(userSessionPath(home)), false);
    assert.equal(await exists(serverAttachmentPath(home, H_FAMILY_SERVER_ID)), false);
  });
});

test("H-family mutations materialize repeatable file states for every generated role", async () => {
  const cases = generateHFamilyCases();

  for (const candidate of cases) {
    await withHome(async (home) => {
      await injectHFamilyCase(home, candidate);

      const target = hFamilyTargetPath(home, candidate.targetId);

      if (candidate.processState === "live") {
        assert.equal(await exists(servicePidPath(home)), true, candidate.id);
      } else {
        assert.equal(await exists(servicePidPath(home)), false, candidate.id);
      }

      if (candidate.mutation === "absent") {
        assert.equal(await exists(target), false, candidate.id);
        return;
      }

      assert.equal(await exists(target), true, candidate.id);
      if (candidate.mutation === "eacces" && process.platform !== "win32") {
        const mode = (await stat(target)).mode & 0o777;
        assert.equal(mode, 0, candidate.id);
        return;
      }
      const raw = await readFile(target, "utf8");
      if (candidate.mutation === "corrupt-json") {
        assert.equal(raw, "{not-json");
        return;
      }
      if (candidate.mutation === "stale-value") {
        assert.match(raw, /old-|999999|stale-|degraded/);
        return;
      }
    });
  }
});

test("H-family QA fixture materializes old-schema legacy owner without fingerprint", async () => {
  await withHome(async (home) => {
    const fixture = H_FAMILY_QA_FIXTURES.find((candidate) => candidate.id === "H-legacy-owner-old-schema");
    assert.ok(fixture);

    await injectHFamilyQaFixture(home, fixture);

    const raw = await readFile(hFamilyQaOwnerPath(home, "aaaaaaaaaaaaaaaa"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(parsed.hostname, "wenyi-old-daemon");
    assert.equal(parsed.serverUrl, "https://api.raft.build");
    assert.equal("apiKeyFingerprint" in parsed, false);
  });
});

test("H-family QA fixture materializes dual-daemon production owners against staging session", async () => {
  await withHome(async (home) => {
    const fixture = H_FAMILY_QA_FIXTURES.find((candidate) => candidate.id === "H-dual-daemon-env-mismatch");
    assert.ok(fixture);

    await injectHFamilyQaFixture(home, fixture);

    const session = JSON.parse(await readFile(userSessionPath(home), "utf8")) as Record<string, unknown>;
    const ownerA = JSON.parse(await readFile(hFamilyQaOwnerPath(home, "aaaaaaaaaaaaaaaa"), "utf8")) as Record<string, unknown>;
    const ownerB = JSON.parse(await readFile(hFamilyQaOwnerPath(home, "bbbbbbbbbbbbbbbb"), "utf8")) as Record<string, unknown>;

    assert.equal(session.serverUrl, "https://api-aws-staging.botiverse.dev");
    assert.deepEqual(
      [ownerA.apiKeyFingerprint, ownerB.apiKeyFingerprint],
      ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
    );
    assert.deepEqual([ownerA.serverUrl, ownerB.serverUrl], ["https://api.raft.build", "https://api.raft.build"]);
    assert.deepEqual([ownerA.hostname, ownerB.hostname], ["prod-daemon-a", "prod-daemon-b"]);
  });
});

async function chmodTreeBestEffort(root: string): Promise<void> {
  try {
    await chmod(root, 0o700);
  } catch {
    /* best effort */
  }
  for (const file of [
    servicePidPath(root),
    userSessionPath(root),
    serverAttachmentPath(root, H_FAMILY_SERVER_ID),
    hFamilyQaOwnerPath(root, "aaaaaaaaaaaaaaaa"),
    hFamilyQaOwnerPath(root, "bbbbbbbbbbbbbbbb"),
    ...generateHFamilyCases().map((candidate) => hFamilyTargetPath(root, candidate.targetId)),
  ]) {
    try {
      await chmod(file, 0o600);
    } catch {
      /* best effort */
    }
  }
}

function observation(
  overrides: Partial<HFamilyAssertionObservation> = {},
): HFamilyAssertionObservation {
  return {
    reportedAuthority: false,
    authoritySource: "none",
    recoveryActions: [],
    userFacingFailure: false,
    canonicalStateRebuilt: false,
    runtimeEvidenceRegenerated: false,
    skewSuspect: false,
    ...overrides,
  };
}
