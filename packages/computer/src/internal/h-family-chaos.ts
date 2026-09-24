import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CURRENT_SCHEMA_VERSION,
  legacyServerAttachmentPath,
  legacyServerRunnerPidPath,
  serverConnectedMarkerPath,
  serverAttachmentPath,
  serverManagedFlagPath,
  serverRunnerPidPath,
  serverRunnerVersionPath,
  servicePidPath,
  serviceStatePath,
  serviceVersionPath,
  userSessionPath,
} from "../paths.js";

export const H_FAMILY_SERVER_ID = "11111111-1111-4111-8111-111111111111";

export type HFamilyRole =
  | "identity-authority"
  | "compatibility-fallback"
  | "runtime-evidence"
  | "version-evidence";

export type HFamilyMutation =
  | "absent"
  | "corrupt-json"
  | "eacces"
  | "stale-value";

export type HFamilyProcessState = "cold" | "live";

export type HFamilyExpectedBehavior =
  | "fail-closed-with-recovery"
  | "silent-self-heal"
  | "regenerate"
  | "skew-suspect";

export type HFamilyExpectedAssertionId =
  | "identity-fail-closed-recovery"
  | "identity-live-process-not-authority"
  | "compatibility-silent-self-heal"
  | "runtime-regenerate-from-observation"
  | "version-skew-suspect";

export type HFamilyAuthoritySource = "identity-state" | "live-process" | "none";

export type HFamilyRecoveryAction = "login" | "attach" | "stop" | "restart";

export interface HFamilyAssertionObservation {
  readonly reportedAuthority: boolean;
  readonly authoritySource: HFamilyAuthoritySource;
  readonly recoveryActions: readonly HFamilyRecoveryAction[];
  readonly userFacingFailure: boolean;
  readonly canonicalStateRebuilt: boolean;
  readonly runtimeEvidenceRegenerated: boolean;
  readonly skewSuspect: boolean;
}

export type HFamilyAssertionPredicate = (observation: HFamilyAssertionObservation) => boolean;

export interface HFamilyExpectedAssertionDefinition {
  readonly id: HFamilyExpectedAssertionId;
  readonly description: string;
  readonly predicate: HFamilyAssertionPredicate;
}

interface HFamilyTarget {
  readonly id: string;
  readonly role: HFamilyRole;
  readonly label: string;
  readonly path: (slockHome: string) => string;
  readonly baseline: string | Record<string, unknown>;
  readonly stale: string | Record<string, unknown>;
}

export interface HFamilyCase {
  readonly id: string;
  readonly targetId: string;
  readonly role: HFamilyRole;
  readonly label: string;
  readonly mutation: HFamilyMutation;
  readonly processState: HFamilyProcessState;
  readonly expectedBehavior: HFamilyExpectedBehavior;
  readonly expectedAssertionId: HFamilyExpectedAssertionId;
  readonly expectedAssertion: string;
}

export type HFamilyQaFixtureId =
  | "H-legacy-owner-old-schema"
  | "H-dual-daemon-env-mismatch";

export interface HFamilyQaFixture {
  readonly id: HFamilyQaFixtureId;
  readonly label: string;
  readonly expectedAssertion: string;
}

const TARGETS: readonly HFamilyTarget[] = [
  {
    id: "user-session",
    role: "identity-authority",
    label: "shared user session",
    path: userSessionPath,
    baseline: {
      kind: "user-session",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      userId: "user-h-family",
      accessToken: "test.access.token",
      refreshToken: "test.refresh.token",
      serverUrl: "https://api.example.test",
      createdAt: "2026-07-07T00:00:00.000Z",
    },
    stale: {
      kind: "user-session",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      userId: "old-user",
      accessToken: "",
      refreshToken: "",
      serverUrl: "https://api.example.test",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  },
  {
    id: "runner-state",
    role: "identity-authority",
    label: "per-server runner state",
    path: (slockHome) => serverAttachmentPath(slockHome, H_FAMILY_SERVER_ID),
    baseline: {
      kind: "computer-attachment",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      serverId: H_FAMILY_SERVER_ID,
      serverMachineId: "server-machine-h-family",
      machineId: "machine-h-family",
      apiKey: "sk_computer_test",
      serverUrl: "https://api.example.test",
      attachedAt: "2026-07-07T00:00:00.000Z",
    },
    stale: {
      kind: "computer-attachment",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      serverId: H_FAMILY_SERVER_ID,
      serverMachineId: "old-server-machine",
      apiKey: "",
      serverUrl: "https://api.example.test",
      attachedAt: "2026-01-01T00:00:00.000Z",
    },
  },
  {
    id: "legacy-attachment",
    role: "compatibility-fallback",
    label: "legacy per-server attachment fallback",
    path: (slockHome) => legacyServerAttachmentPath(slockHome, H_FAMILY_SERVER_ID),
    baseline: {
      kind: "computer-attachment",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      serverId: H_FAMILY_SERVER_ID,
      serverMachineId: "legacy-server-machine-h-family",
      apiKey: "sk_computer_legacy_test",
      serverUrl: "https://api.example.test",
      attachedAt: "2026-07-07T00:00:00.000Z",
    },
    stale: {
      kind: "computer-attachment",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      serverId: H_FAMILY_SERVER_ID,
      serverMachineId: "old-legacy-server-machine",
      apiKey: "",
      serverUrl: "https://api.example.test",
      attachedAt: "2026-01-01T00:00:00.000Z",
    },
  },
  {
    id: "legacy-runner-pid",
    role: "compatibility-fallback",
    label: "legacy server-runner pid fallback",
    path: (slockHome) => legacyServerRunnerPidPath(slockHome, H_FAMILY_SERVER_ID),
    baseline: String(process.pid),
    stale: "999999",
  },
  {
    id: "service-state",
    role: "runtime-evidence",
    label: "service runtime state",
    path: serviceStatePath,
    baseline: {
      kind: "service-state",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      state: "running",
      crashHistory: [],
    },
    stale: {
      kind: "service-state",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      state: "degraded",
      crashHistory: [{ timestamp: "2026-01-01T00:00:00.000Z", exitCode: 1 }],
    },
  },
  {
    id: "runner-pid",
    role: "runtime-evidence",
    label: "per-server runner pid",
    path: (slockHome) => serverRunnerPidPath(slockHome, H_FAMILY_SERVER_ID),
    baseline: String(process.pid),
    stale: "999999",
  },
  {
    id: "managed-flag",
    role: "runtime-evidence",
    label: "per-server managed flag",
    path: (slockHome) => serverManagedFlagPath(slockHome, H_FAMILY_SERVER_ID),
    baseline: "managed\n",
    stale: "stale-managed\n",
  },
  {
    id: "connected-marker",
    role: "runtime-evidence",
    label: "per-server connected marker",
    path: (slockHome) => serverConnectedMarkerPath(slockHome, H_FAMILY_SERVER_ID),
    baseline: "connected\n",
    stale: "stale-connected\n",
  },
  {
    id: "service-version",
    role: "version-evidence",
    label: "running service version evidence",
    path: serviceVersionPath,
    baseline: {
      version: "0.0.76",
      installRoot: "/tmp/raft-computer-current",
      pid: process.pid,
      writtenAt: "2026-07-07T00:00:00.000Z",
    },
    stale: {
      version: "0.0.1",
      installRoot: "/tmp/raft-computer-old",
      pid: 999999,
      writtenAt: "2026-01-01T00:00:00.000Z",
    },
  },
  {
    id: "runner-version",
    role: "version-evidence",
    label: "per-server runner version evidence",
    path: (slockHome) => serverRunnerVersionPath(slockHome, H_FAMILY_SERVER_ID),
    baseline: {
      version: "0.0.76",
      installRoot: "/tmp/raft-computer-current",
      pid: process.pid,
      writtenAt: "2026-07-07T00:00:00.000Z",
    },
    stale: {
      version: "0.0.1",
      installRoot: "/tmp/raft-computer-old",
      pid: 999999,
      writtenAt: "2026-01-01T00:00:00.000Z",
    },
  },
] as const;

const MUTATIONS: readonly HFamilyMutation[] = [
  "absent",
  "corrupt-json",
  "eacces",
  "stale-value",
] as const;

const PROCESS_STATES: readonly HFamilyProcessState[] = ["cold", "live"] as const;

export function hFamilyExpectedBehavior(role: HFamilyRole): HFamilyExpectedBehavior {
  switch (role) {
    case "identity-authority":
      return "fail-closed-with-recovery";
    case "compatibility-fallback":
      return "silent-self-heal";
    case "runtime-evidence":
      return "regenerate";
    case "version-evidence":
      return "skew-suspect";
  }
}

export function hFamilyExpectedAssertion(
  role: HFamilyRole,
  processState: HFamilyProcessState,
): string {
  if (role === "identity-authority" && processState === "live") {
    return "must not report attached/logged-in from live process evidence alone; recovery must point at stop/login/attach";
  }
  if (role === "identity-authority") {
    return "must fail closed with an explicit login/attach recovery path";
  }
  if (role === "compatibility-fallback") return "must rebuild from canonical source without user-facing failure";
  if (role === "runtime-evidence") return "must regenerate from live process observation";
  return "must fail closed as SKEW_SUSPECT until fresh version evidence exists";
}

export function hFamilyExpectedAssertionId(
  role: HFamilyRole,
  processState: HFamilyProcessState,
): HFamilyExpectedAssertionId {
  if (role === "identity-authority" && processState === "live") return "identity-live-process-not-authority";
  if (role === "identity-authority") return "identity-fail-closed-recovery";
  if (role === "compatibility-fallback") return "compatibility-silent-self-heal";
  if (role === "runtime-evidence") return "runtime-regenerate-from-observation";
  return "version-skew-suspect";
}

export const H_FAMILY_EXPECTED_ASSERTIONS: {
  readonly [id in HFamilyExpectedAssertionId]: HFamilyExpectedAssertionDefinition;
} = {
  "identity-fail-closed-recovery": {
    id: "identity-fail-closed-recovery",
    description: hFamilyExpectedAssertion("identity-authority", "cold"),
    predicate: (observation) =>
      !observation.reportedAuthority &&
      observation.authoritySource !== "live-process" &&
      observation.userFacingFailure &&
      hasRecoveryAction(observation, "login", "attach"),
  },
  "identity-live-process-not-authority": {
    id: "identity-live-process-not-authority",
    description: hFamilyExpectedAssertion("identity-authority", "live"),
    predicate: (observation) =>
      !observation.reportedAuthority &&
      observation.authoritySource !== "live-process" &&
      observation.userFacingFailure &&
      hasRecoveryAction(observation, "stop", "login", "attach"),
  },
  "compatibility-silent-self-heal": {
    id: "compatibility-silent-self-heal",
    description: hFamilyExpectedAssertion("compatibility-fallback", "cold"),
    predicate: (observation) =>
      !observation.userFacingFailure && observation.canonicalStateRebuilt,
  },
  "runtime-regenerate-from-observation": {
    id: "runtime-regenerate-from-observation",
    description: hFamilyExpectedAssertion("runtime-evidence", "live"),
    predicate: (observation) =>
      !observation.userFacingFailure && observation.runtimeEvidenceRegenerated,
  },
  "version-skew-suspect": {
    id: "version-skew-suspect",
    description: hFamilyExpectedAssertion("version-evidence", "live"),
    predicate: (observation) => observation.userFacingFailure && observation.skewSuspect,
  },
} as const;

export function hFamilyExpectedAssertionDefinition(
  id: HFamilyExpectedAssertionId,
): HFamilyExpectedAssertionDefinition {
  return H_FAMILY_EXPECTED_ASSERTIONS[id];
}

export function evaluateHFamilyExpectedAssertion(
  id: HFamilyExpectedAssertionId,
  observation: HFamilyAssertionObservation,
): boolean {
  return H_FAMILY_EXPECTED_ASSERTIONS[id].predicate(observation);
}

export function generateHFamilyCases(options: {
  role?: HFamilyRole;
  limit?: number;
} = {}): HFamilyCase[] {
  const cases: HFamilyCase[] = [];
  for (const target of TARGETS) {
    if (options.role && target.role !== options.role) continue;
    for (const mutation of MUTATIONS) {
      for (const processState of PROCESS_STATES) {
        cases.push({
          id: `H-${target.id}-${mutation}-${processState}`,
          targetId: target.id,
          role: target.role,
          label: target.label,
          mutation,
          processState,
          expectedBehavior: hFamilyExpectedBehavior(target.role),
          expectedAssertionId: hFamilyExpectedAssertionId(target.role, processState),
          expectedAssertion: hFamilyExpectedAssertion(target.role, processState),
        });
        if (options.limit && cases.length >= options.limit) return cases;
      }
    }
  }
  return cases;
}

export const H1_LIVE_PROCESS_EMPTY_HOME: HFamilyCase = {
  id: "H-1-live-process-empty-home",
  targetId: "computer-home",
  role: "identity-authority",
  label: "live service process with empty Computer home",
  mutation: "absent",
  processState: "live",
  expectedBehavior: "fail-closed-with-recovery",
  expectedAssertionId: "identity-live-process-not-authority",
  expectedAssertion:
    "must detect orphan live service evidence without claiming login/attachment; recovery must tell the user to stop the old service",
};

export const H_FAMILY_QA_FIXTURES: readonly HFamilyQaFixture[] = [
  {
    id: "H-legacy-owner-old-schema",
    label: "realistic old-schema legacy daemon owner without apiKeyFingerprint",
    expectedAssertion:
      "migration discovery evidence must preserve a legal owner.json that lacks apiKeyFingerprint instead of collapsing it into no local evidence",
  },
  {
    id: "H-dual-daemon-env-mismatch",
    label: "two local legacy daemons from production while setup targets staging",
    expectedAssertion:
      "migration discovery must explain serverUrl mismatch and zero-match decisions instead of silently fresh-attaching",
  },
] as const;

export function identityAuthorityPilotCases(): HFamilyCase[] {
  return [
    H1_LIVE_PROCESS_EMPTY_HOME,
    ...generateHFamilyCases({ role: "identity-authority", limit: 9 }),
  ];
}

export async function injectHFamilyQaFixture(
  slockHome: string,
  fixture: HFamilyQaFixture,
): Promise<void> {
  await rm(slockHome, { recursive: true, force: true });
  switch (fixture.id) {
    case "H-legacy-owner-old-schema":
      await writeLegacyOwnerFixture(slockHome, "aaaaaaaaaaaaaaaa", {
        pid: 999999,
        hostname: "wenyi-old-daemon",
        machineName: "wenyi-old-schema",
        startedAt: "2026-01-01T00:00:00.000Z",
        serverUrl: "https://api.raft.build",
      });
      return;
    case "H-dual-daemon-env-mismatch":
      await writeValue(userSessionPath(slockHome), {
        kind: "user-session",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        userId: "user-h-family",
        accessToken: "test.access.token",
        refreshToken: "test.refresh.token",
        serverUrl: "https://api-aws-staging.botiverse.dev",
        createdAt: "2026-07-07T00:00:00.000Z",
      });
      await writeLegacyOwnerFixture(slockHome, "aaaaaaaaaaaaaaaa", {
        pid: 999999,
        hostname: "prod-daemon-a",
        startedAt: "2026-07-07T00:00:00.000Z",
        serverUrl: "https://api.raft.build",
        apiKeyFingerprint: "aaaaaaaaaaaaaaaa",
      });
      await writeLegacyOwnerFixture(slockHome, "bbbbbbbbbbbbbbbb", {
        pid: 999998,
        hostname: "prod-daemon-b",
        startedAt: "2026-07-07T00:01:00.000Z",
        serverUrl: "https://api.raft.build",
        apiKeyFingerprint: "bbbbbbbbbbbbbbbb",
      });
      return;
  }
}

export async function injectHFamilyCase(
  slockHome: string,
  testCase: HFamilyCase,
): Promise<void> {
  await rm(slockHome, { recursive: true, force: true });
  if (testCase.id === H1_LIVE_PROCESS_EMPTY_HOME.id) {
    await writeLiveServiceEvidence(slockHome);
    return;
  }

  await writeBaselineIdentityState(slockHome);
  await writeBaselineNonIdentityEvidence(slockHome);
  if (testCase.processState === "live") {
    await writeLiveServiceEvidence(slockHome);
  }

  const target = findTarget(testCase.targetId);
  const file = target.path(slockHome);
  await applyMutation(file, target, testCase);
}

export function hFamilyTargetPath(slockHome: string, targetId: string): string {
  return findTarget(targetId).path(slockHome);
}

export function hFamilyQaOwnerPath(slockHome: string, machineFingerprint: string): string {
  return legacyOwnerPath(slockHome, machineFingerprint);
}

function findTarget(targetId: string): HFamilyTarget {
  const target = TARGETS.find((candidate) => candidate.id === targetId);
  if (!target) {
    throw new Error(`unknown H-family target: ${targetId}`);
  }
  return target;
}

function hasRecoveryAction(
  observation: HFamilyAssertionObservation,
  ...actions: readonly HFamilyRecoveryAction[]
): boolean {
  return actions.some((action) => observation.recoveryActions.includes(action));
}

async function writeBaselineIdentityState(slockHome: string): Promise<void> {
  for (const target of TARGETS.filter((candidate) => candidate.role === "identity-authority")) {
    await writeValue(target.path(slockHome), target.baseline);
  }
}

async function writeBaselineNonIdentityEvidence(slockHome: string): Promise<void> {
  for (const target of TARGETS.filter((candidate) => candidate.role !== "identity-authority")) {
    await writeValue(target.path(slockHome), target.baseline);
  }
}

async function writeLegacyOwnerFixture(
  slockHome: string,
  machineFingerprint: string,
  value: Record<string, unknown>,
): Promise<void> {
  await writeJson(legacyOwnerPath(slockHome, machineFingerprint), value);
}

function legacyOwnerPath(slockHome: string, machineFingerprint: string): string {
  return join(slockHome, "machines", `machine-${machineFingerprint}`, "daemon.lock", "owner.json");
}

async function applyMutation(file: string, target: HFamilyTarget, testCase: HFamilyCase): Promise<void> {
  switch (testCase.mutation) {
    case "absent":
      await rm(file, { force: true });
      return;
    case "corrupt-json":
      await writeRaw(file, "{not-json");
      return;
    case "eacces":
      await writeRaw(file, JSON.stringify({ blocked: true }));
      if (process.platform !== "win32") await chmod(file, 0o000);
      return;
    case "stale-value":
      await writeValue(file, target.stale);
      return;
  }
}

async function writeLiveServiceEvidence(slockHome: string): Promise<void> {
  await writeRaw(servicePidPath(slockHome), String(process.pid));
}

async function writeValue(file: string, value: string | Record<string, unknown>): Promise<void> {
  if (typeof value === "string") {
    await writeRaw(file, value);
    return;
  }
  await writeJson(file, value);
}

async function writeJson(file: string, value: Record<string, unknown>): Promise<void> {
  await writeRaw(file, JSON.stringify(value, null, 2));
}

async function writeRaw(file: string, value: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, value, { mode: 0o600 });
}
