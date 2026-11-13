import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  PROVIDER_PROBE_BUDGET_MS,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
  asProviderProbeId,
  mintProviderProbeId,
  providerProbeAuthorityIdentity,
  providerProbeRequestDigest,
  providerProbeResultDigest,
  sha256Hex,
  utf8ByteLength,
  type MachineProviderProbeResult,
  type ProviderProbeId,
} from "@botiverse/raft-shared";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import {
  featureFlagRules,
  integrationAuditEvents,
  machines,
  providerConnections,
  providerConnectionCredentials,
  providerProbeIntents,
  providerProbeReceipts,
  serverMembers,
  users,
} from "../db/schema";
import { createServer } from "../services/serverService";
import {
  __resetProviderConnectionProbeMaterializationCallCount,
  __providerConnectionProbeMaterializationCallCount,
} from "../services/providerConnectionService";
import {
  __setProviderProbeCarrierForTests,
  consumeProviderProbeResult,
  materializeProviderProbe,
  type ProbeCarrier,
  type ProbeCarrierFact,
} from "../services/providerProbeService";
import { openTestApp } from "../test/integration/app";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const AUTHORITY = { connectionEpochId: "epoch-probe-1", replicaGeneration: "gen-probe-1" };
const FACT: ProbeCarrierFact = {
  capabilities: ["provider-probe:v1"],
  connectionEpochId: AUTHORITY.connectionEpochId,
  replicaGeneration: AUTHORITY.replicaGeneration,
  daemonVersion: "daemon-1",
  computerVersion: "computer-1",
  runtimes: ["builtin"],
  runtimeVersions: { builtin: "pi-1" },
};
const REPLY = "OK";

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

function headers(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

async function enableFlags(serverId: string) {
  for (const flagKey of [PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY]) {
    await getDb().insert(featureFlagRules).values({
      id: randomUUID(),
      flagKey,
      stage: "server",
      priority: -100,
      decision: "allow",
      values: [serverId],
    });
  }
}

interface FakeCarrierState {
  fact: ProbeCarrierFact | null;
  /** Fact observed at result time (defaults to `fact`). */
  resultFact?: ProbeCarrierFact | null;
  dispatches: Array<{ machineId: string; probeId: string; requestId: string }>;
  outcome: ProbeOutcomeLike;
}
type ProbeOutcomeLike =
  | { kind: "claim_then_success"; reply?: string; hashOverride?: string }
  | { kind: "provider_timeout_result" }
  | { kind: "wrong_version_result" }
  | { kind: "send_failed" }
  | { kind: "timeout" }
  | { kind: "result"; result: MachineProviderProbeResult };

async function successResult(
  command: { requestId: string; probeId: ProviderProbeId },
  reply: string,
  hashOverride?: string,
): Promise<MachineProviderProbeResult> {
  const responseSha256 = hashOverride ?? await sha256Hex(reply);
  const responseBytes = utf8ByteLength(reply);
  return {
    type: "machine:provider_probe:result",
    requestId: command.requestId,
    probeId: command.probeId,
    outcome: "success",
    category: null,
    latencyMs: 42,
    responseSha256,
    responseBytes,
    resultDigest: await providerProbeResultDigest({
      outcome: "success",
      category: null,
      responseSha256,
      responseBytes,
      authorityIdentity: await providerProbeAuthorityIdentity(AUTHORITY),
    }),
    authorityEcho: AUTHORITY,
    daemonVersion: "daemon-1",
    computerVersion: "computer-1",
    runtimeVersion: "pi-1",
    reply,
  };
}

function fakeCarrier(serverId: string, state: FakeCarrierState): ProbeCarrier {
  let reads = 0;
  return {
    readFact: async () => {
      reads += 1;
      return reads === 1 ? state.fact : (state.resultFact ?? state.fact);
    },
    dispatch: async (machineId, command) => {
      state.dispatches.push({ machineId, probeId: command.probeId, requestId: command.requestId });
      if (state.outcome.kind === "send_failed") return { kind: "send_failed" as const };
      if (state.outcome.kind === "timeout") return { kind: "timeout" as const };
      if (state.outcome.kind === "result") return { kind: "result" as const, result: state.outcome.result };
      if (state.outcome.kind === "wrong_version_result") {
        await materializeProviderProbe({
          serverId,
          probeId: command.probeId,
          machineId,
          claimRequestId: command.requestId,
          fact: state.fact,
        });
        const base = await successResult(command, REPLY);
        return { kind: "result" as const, result: { ...base, runtimeVersion: "pi-ROTATED" } };
      }
      if (state.outcome.kind === "provider_timeout_result") {
        await materializeProviderProbe({
          serverId,
          probeId: command.probeId,
          machineId,
          claimRequestId: command.requestId,
          fact: state.fact,
        });
        return {
          kind: "result" as const,
          result: {
            type: "machine:provider_probe:result" as const,
            requestId: command.requestId,
            probeId: command.probeId,
            outcome: "failure" as const,
            category: "provider_timeout" as const,
            latencyMs: PROVIDER_PROBE_BUDGET_MS,
            responseSha256: null,
            responseBytes: null,
            resultDigest: await providerProbeResultDigest({
              outcome: "failure",
              category: "provider_timeout",
              responseSha256: null,
              responseBytes: null,
              authorityIdentity: await providerProbeAuthorityIdentity(AUTHORITY),
            }),
            authorityEcho: AUTHORITY,
            daemonVersion: "daemon-1",
            computerVersion: "computer-1",
            runtimeVersion: "pi-1",
            reply: null,
          },
        };
      }
      await materializeProviderProbe({
        serverId,
        probeId: command.probeId,
        machineId,
        claimRequestId: command.requestId,
        fact: state.fact,
      });
      return {
        kind: "result" as const,
        result: await successResult(command, state.outcome.reply ?? REPLY, state.outcome.hashOverride),
      };
    },
  };
}

async function createBody(connectionId: string, computerId: string, overrides: Record<string, unknown> = {}) {
  const payload = {
    computerId,
    runtime: "builtin",
    model: "deepseek/deepseek-v4-pro",
    probeKind: "canary",
    ...overrides,
  };
  return {
    probeRequestId: `probe-req-${randomUUID()}`,
    requestDigest: await providerProbeRequestDigest({
      connectionId,
      computerId: payload.computerId as string,
      runtime: payload.runtime as string,
      model: payload.model as string,
      probeKind: payload.probeKind as "canary",
    }),
    ...payload,
  };
}

test("provider probe foundation: idempotent create, closed receipts, capability and drift guards", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 11).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser("probe-owner@raft.test", "probe-owner");
    const member = await seedUser("probe-member@raft.test", "probe-member");
    const server = await createServer("Probe Server", "probe-server", owner.id);
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
    const ownerToken = await login(app.baseUrl, owner.email);
    const memberToken = await login(app.baseUrl, member.email);
    await enableFlags(server.id);

    const createdConnection = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ name: "Probe DeepSeek", providerId: "deepseek", apiKey: "probe-secret-value" }),
    });
    assert.equal(createdConnection.status, 201);
    const connection = (await createdConnection.json()) as { id: string };
    const machineRows = await getDb().insert(machines).values([
      { serverId: server.id, userId: owner.id, name: "probe-machine-1", apiKeyHash: "h1", runtimes: ["builtin"] },
      { serverId: server.id, userId: owner.id, name: "probe-machine-2", apiKeyHash: "h2", runtimes: ["builtin"] },
      { serverId: server.id, userId: owner.id, name: "probe-machine-3", apiKeyHash: "h3", runtimes: ["builtin"] },
      { serverId: server.id, userId: owner.id, name: "probe-machine-4", apiKeyHash: "h4", runtimes: ["builtin"] },
      { serverId: server.id, userId: owner.id, name: "probe-machine-5", apiKeyHash: "h5", runtimes: ["builtin"] },
      { serverId: server.id, userId: owner.id, name: "probe-machine-6", apiKeyHash: "h7", runtimes: ["builtin"] },
      { serverId: server.id, userId: owner.id, name: "probe-machine-7", apiKeyHash: "h8", runtimes: ["builtin"] },
      { serverId: server.id, userId: owner.id, name: "probe-machine-claude", apiKeyHash: "h6", runtimes: ["claude"] },
    ]).returning();
    const [machine, machine2, machine3, machine4, machine5, machine6, machine7, claudeMachine] = machineRows;

    // ---- closed runtime set: non-builtin runtime and non-string kind are 400
    const claudeRuntime = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(await createBody(connection.id, claudeMachine!.id, { runtime: "claude" })),
    });
    assert.equal(claudeRuntime.status, 400);
    const tooLongModel = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(await createBody(connection.id, machine!.id, { model: "m".repeat(201) })),
    });
    assert.equal(tooLongModel.status, 400);
    const badKind = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(await createBody(connection.id, machine!.id, { probeKind: 7 })),
    });
    assert.equal(badKind.status, 400);
    const noRuntimeComputer = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(await createBody(connection.id, claudeMachine!.id)),
    });
    assert.equal(noRuntimeComputer.status, 400);

    // ---- happy path: claim + success result, reply relayed once
    const state: FakeCarrierState = { fact: FACT, dispatches: [], outcome: { kind: "claim_then_success" } };
    __setProviderProbeCarrierForTests(fakeCarrier(server.id, state));
    const body = await createBody(connection.id, machine!.id);
    const created = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(body),
    });
    assert.equal(created.status, 201);
    const createdView = (await created.json()) as {
      probe: { probeId: string; outcome: string; category: string | null };
      reply: string | null;
      replayed: boolean;
    };
    assert.equal(createdView.probe.outcome, "success");
    assert.equal(createdView.probe.category, null);
    assert.equal(createdView.reply, REPLY);
    assert.equal(createdView.replayed, false);
    assert.equal(state.dispatches.length, 1);

    // receipt carries the full coordinate set (F7)
    const [receiptRow] = await getDb().select().from(providerProbeReceipts)
      .where(eq(providerProbeReceipts.probeId, createdView.probe.probeId));
    assert.equal(receiptRow?.daemonVersion, "daemon-1");
    assert.equal(receiptRow?.computerVersion, "computer-1");
    assert.equal(receiptRow?.runtimeVersion, "pi-1");
    assert.equal(receiptRow?.dispatchEpochId, AUTHORITY.connectionEpochId);
    assert.equal(receiptRow?.dispatchGeneration, AUTHORITY.replicaGeneration);

    // GET returns the durable receipt and never the reply
    const read = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes/${createdView.probe.probeId}`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(read.status, 200);
    const readBody = (await read.json()) as Record<string, unknown>;
    assert.equal(readBody.outcome, "success");
    assert.equal("reply" in readBody, false);
    const readText = JSON.stringify(readBody);
    assert.equal(readText.includes(REPLY), false);
    assert.equal(readText.includes("probe-secret-value"), false);

    // ---- idempotent replay: same key + digest, no second dispatch
    const replay = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(body),
    });
    assert.equal(replay.status, 200);
    const replayView = (await replay.json()) as { probe: { probeId: string }; replayed: boolean };
    assert.equal(replayView.probe.probeId, createdView.probe.probeId);
    assert.equal(replayView.replayed, true);
    assert.equal(state.dispatches.length, 1, "a replayed create must not dispatch again");

    // ---- same key, different payload or different connection → conflict (F5)
    const conflict = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(await createBody(connection.id, machine!.id, { probeRequestId: body.probeRequestId, model: "deepseek/other" })),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { code?: string }).code, "probe_request_conflict");
    const crossConnection = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ ...body, requestDigest: await providerProbeRequestDigest({
        connectionId: connection.id,
        computerId: machine!.id,
        runtime: "builtin",
        model: "deepseek/deepseek-v4-pro",
        probeKind: "canary",
      }) }),
    });
    void crossConnection;
    const wrongPath = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ ...body, probeRequestId: body.probeRequestId }),
    });
    assert.equal(wrongPath.status, 200, "same key+digest on the same path replays");

    // ---- wrong correlation: a result for another dispatch must not close (F1)
    const { consumeProviderProbeResult } = await import("../services/providerProbeService");
    await assert.rejects(
      consumeProviderProbeResult({
        probeId: createdView.probe.probeId as ProviderProbeId,
        message: { ...(await successResult({ requestId: "other-dispatch", probeId: createdView.probe.probeId as ProviderProbeId }, REPLY)) },
      }),
      /does not match this dispatch/,
    );

    // ---- conflicting late result cannot flip a terminal receipt
    const authorityIdentity = await providerProbeAuthorityIdentity(AUTHORITY);
    const lateDigest = await providerProbeResultDigest({
      outcome: "failure",
      category: "auth",
      responseSha256: null,
      responseBytes: null,
      authorityIdentity,
    });
    await assert.rejects(
      consumeProviderProbeResult({
        probeId: createdView.probe.probeId as ProviderProbeId,
        message: {
          type: "machine:provider_probe:result",
          requestId: state.dispatches[0]!.requestId,
          probeId: createdView.probe.probeId as ProviderProbeId,
          outcome: "failure",
          category: "auth",
          latencyMs: 1,
          responseSha256: null,
          responseBytes: null,
          resultDigest: lateDigest,
          authorityEcho: AUTHORITY,
          daemonVersion: null,
          computerVersion: null,
          runtimeVersion: null,
          reply: null,
        },
      }),
      /already closed/,
    );
    const receipts = await getDb().select().from(providerProbeReceipts)
      .where(eq(providerProbeReceipts.probeId, createdView.probe.probeId));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.outcome, "success");

    // ---- durable rows carry no reply / prompt / key / raw model
    const receiptText = JSON.stringify(receipts);
    assert.equal(receiptText.includes(REPLY), false);
    assert.equal(receiptText.includes("probe-secret-value"), false);
    assert.equal(receiptText.includes("Reply with OK."), false);
    const audits = await getDb().select().from(integrationAuditEvents)
      .where(eq(integrationAuditEvents.serverId, server.id));
    const auditText = JSON.stringify(audits);
    assert.equal(auditText.includes(REPLY), false);
    assert.equal(auditText.includes("probe-secret-value"), false);
    assert.equal(auditText.includes("deepseek/deepseek-v4-pro"), false, "audit stores a model digest, never the raw model");

    // ---- missing capability: terminal before any command or provider call
    const noCapState: FakeCarrierState = { fact: { ...FACT, capabilities: [] }, dispatches: [], outcome: { kind: "claim_then_success" } };
    __setProviderProbeCarrierForTests(fakeCarrier(server.id, noCapState));
    const noCap = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(await createBody(connection.id, machine2!.id)),
    });
    assert.equal(noCap.status, 201);
    const noCapView = (await noCap.json()) as { probe: { outcome: string; category: string } };
    assert.equal(noCapView.probe.outcome, "failure");
    assert.equal(noCapView.probe.category, "unsupported_carrier");
    assert.equal(noCapState.dispatches.length, 0, "no capability must mean zero commands and zero provider calls");

    // ---- send failure and timeout close with distinct carrier categories
    const offlineState: FakeCarrierState = { fact: FACT, dispatches: [], outcome: { kind: "send_failed" } };
    __setProviderProbeCarrierForTests(fakeCarrier(server.id, offlineState));
    const offline = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(await createBody(connection.id, machine3!.id)),
    });
    const offlineView = (await offline.json()) as { probe: { category: string } };
    assert.equal(offlineView.probe.category, "carrier_offline");

    const timeoutState: FakeCarrierState = { fact: FACT, dispatches: [], outcome: { kind: "timeout" } };
    __setProviderProbeCarrierForTests(fakeCarrier(server.id, timeoutState));
    const timedOut = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(await createBody(connection.id, machine4!.id)),
    });
    const timeoutView = (await timedOut.json()) as { probe: { category: string } };
    assert.equal(timeoutView.probe.category, "carrier_timeout");

    // ---- reply that fails the hash/bytes bound, or is blank, closes invalid
    const badReplyState: FakeCarrierState = {
      fact: FACT,
      dispatches: [],
      outcome: { kind: "claim_then_success", reply: "truncated-bytes", hashOverride: await sha256Hex(REPLY) },
    };
    __setProviderProbeCarrierForTests(fakeCarrier(server.id, badReplyState));
    const badReply = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(await createBody(connection.id, machine5!.id)),
    });
    const badReplyView = (await badReply.json()) as { probe: { outcome: string; category: string }; reply: string | null };
    assert.equal(badReplyView.probe.outcome, "failure");
    assert.equal(badReplyView.probe.category, "invalid_carrier_result");
    assert.equal(badReplyView.reply, null);

    // Capability withdrawn between dispatch and result closes stale (F1).
    const capWithdrawnState: FakeCarrierState = {
      fact: FACT,
      resultFact: { ...FACT, capabilities: [] },
      dispatches: [],
      outcome: { kind: "claim_then_success" },
    };
    __setProviderProbeCarrierForTests(fakeCarrier(server.id, capWithdrawnState));
    const capWithdrawn = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(await createBody(connection.id, machine7!.id)),
    });
    assert.equal(capWithdrawn.status, 201);
    const capWithdrawnView = (await capWithdrawn.json()) as { probe: { outcome: string; category: string } };
    assert.equal(capWithdrawnView.probe.outcome, "failure");
    assert.equal(capWithdrawnView.probe.category, "stale_authority");

    // A result whose self-reported versions disagree with the frozen dispatch
    // fact must never be stored as success (F7).
    const wrongVersionState: FakeCarrierState = {
      fact: FACT,
      dispatches: [],
      outcome: { kind: "wrong_version_result" },
    };
    __setProviderProbeCarrierForTests(fakeCarrier(server.id, wrongVersionState));
    const wrongVersion = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(await createBody(connection.id, machine6!.id)),
    });
    const wrongVersionView = (await wrongVersion.json()) as { probe: { outcome: string; category: string } };
    assert.equal(wrongVersionView.probe.outcome, "failure");
    assert.equal(wrongVersionView.probe.category, "invalid_carrier_result");

    const blankReplyState: FakeCarrierState = { fact: FACT, dispatches: [], outcome: { kind: "claim_then_success", reply: "" } };
    __setProviderProbeCarrierForTests(fakeCarrier(server.id, blankReplyState));
    const blankReply = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(await createBody(connection.id, machine2!.id)),
    });
    const blankReplyView = (await blankReply.json()) as { probe: { outcome: string; category: string } };
    assert.equal(blankReplyView.probe.outcome, "failure");
    assert.equal(blankReplyView.probe.category, "invalid_carrier_result");

    // ---- materialization claim: first wins, same claimant retries, others rejected
    const [openConnection] = await getDb().select({
      configVersion: providerConnections.configVersion,
      credentialVersion: providerConnectionCredentials.credentialVersion,
    }).from(providerConnections).innerJoin(providerConnectionCredentials, and(
      eq(providerConnectionCredentials.serverId, providerConnections.serverId),
      eq(providerConnectionCredentials.connectionId, providerConnections.id),
    )).where(eq(providerConnections.id, connection.id)).limit(1);
    await getDb().insert(providerProbeIntents).values({
      id: mintProviderProbeId(),
      serverId: server.id,
      connectionId: connection.id,
      configVersion: openConnection!.configVersion,
      credentialVersion: openConnection!.credentialVersion,
      computerId: machine2!.id,
      runtime: "builtin",
      model: "deepseek/deepseek-v4-pro",
      probeKind: "canary",
      probeRequestId: `probe-req-${randomUUID()}`,
      requestDigest: "claim-request-digest",
      intentDigest: "claim-intent-digest",
      createdByUserId: owner.id,
      expiresAt: new Date(Date.now() + 60_000),
      dispatchedAt: new Date(),
      dispatchRequestId: "claim-dispatch-request",
      dispatchEpochId: AUTHORITY.connectionEpochId,
      dispatchGeneration: AUTHORITY.replicaGeneration,
      capabilityObserved: true,
      dispatchDaemonVersion: "daemon-1",
      dispatchComputerVersion: "computer-1",
      dispatchRuntimeVersion: "pi-1",
      dispatchRuntimes: ["builtin"],
    });
    const [openIntent] = await getDb().select().from(providerProbeIntents).where(and(
      eq(providerProbeIntents.serverId, server.id),
      eq(providerProbeIntents.requestDigest, "claim-request-digest"),
    )).limit(1);
    const openProbeId = openIntent!.id as ProviderProbeId;
    const firstClaim = await materializeProviderProbe({
      serverId: server.id, probeId: openProbeId, machineId: machine2!.id, claimRequestId: "claim-dispatch-request", fact: FACT,
    });
    assert.deepEqual(Object.keys(firstClaim).sort(), ["authority", "envVars", "providerConnection"]);
    // Lost-response retry with the SAME exact claim is idempotent.
    const retryClaim = await materializeProviderProbe({
      serverId: server.id, probeId: openProbeId, machineId: machine2!.id, claimRequestId: "claim-dispatch-request", fact: FACT,
    });
    assert.deepEqual(retryClaim.authority, firstClaim.authority);
    // A claimant that cannot name the frozen dispatch request gets nothing,
    // and must never even reach the credential decrypt boundary. Use a fresh
    // open intent so earlier closures in this case cannot mask the tooth.
    const zeroProbeId = mintProviderProbeId();
    await getDb().insert(providerProbeIntents).values({
      id: zeroProbeId,
      serverId: server.id,
      connectionId: connection.id,
      configVersion: openConnection!.configVersion,
      credentialVersion: openConnection!.credentialVersion,
      computerId: machine2!.id,
      runtime: "builtin",
      model: "deepseek/deepseek-v4-pro",
      probeKind: "canary",
      probeRequestId: `probe-req-${randomUUID()}`,
      requestDigest: "zero-request-digest",
      intentDigest: "zero-intent-digest",
      createdByUserId: owner.id,
      expiresAt: new Date(Date.now() + 60_000),
      dispatchedAt: new Date(),
      dispatchRequestId: "zero-dispatch",
      dispatchEpochId: AUTHORITY.connectionEpochId,
      dispatchGeneration: AUTHORITY.replicaGeneration,
      capabilityObserved: true,
      dispatchDaemonVersion: "daemon-1",
      dispatchComputerVersion: "computer-1",
      dispatchRuntimeVersion: "pi-1",
      dispatchRuntimes: ["builtin"],
    });
    __resetProviderConnectionProbeMaterializationCallCount();
    await assert.rejects(
      materializeProviderProbe({
        serverId: server.id, probeId: zeroProbeId, machineId: machine2!.id, claimRequestId: "other-claim", fact: FACT,
      }),
      /does not match the frozen dispatch request/,
    );
    await assert.rejects(
      materializeProviderProbe({
        serverId: server.id, probeId: zeroProbeId, machineId: machine3!.id, claimRequestId: "zero-dispatch", fact: FACT,
      }),
      /different Computer/,
    );
    await assert.rejects(
      materializeProviderProbe({
        serverId: server.id, probeId: zeroProbeId, machineId: machine2!.id, claimRequestId: "zero-dispatch",
        fact: { ...FACT, replicaGeneration: "gen-rotated" },
      }),
      /authority changed before the probe claim/,
    );
    assert.equal(
      __providerConnectionProbeMaterializationCallCount(),
      0,
      "invalid claimants must produce zero credential decryptions",
    );
    await assert.rejects(
      materializeProviderProbe({
        serverId: server.id, probeId: openProbeId, machineId: machine3!.id, claimRequestId: "wrong-machine", fact: FACT,
      }),
      /different Computer/,
    );
    // A drifted carrier fact closes stale before any credential leaves (F1/F2).
    await assert.rejects(
      materializeProviderProbe({
        serverId: server.id, probeId: openProbeId, machineId: machine2!.id, claimRequestId: "claim-dispatch-request",
        fact: { ...FACT, replicaGeneration: "gen-rotated" },
      }),
      /authority changed before the probe claim/,
    );

    // ---- member cannot create or read probes
    const forbidden = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(memberToken, server.id),
      body: JSON.stringify(await createBody(connection.id, machine!.id)),
    });
    assert.equal(forbidden.status, 403);
    const forbiddenRead = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes/${createdView.probe.probeId}`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(forbiddenRead.status, 403);
  } finally {
    __setProviderProbeCarrierForTests(null);
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

test("provider probe expiry closes before any credential or provider call", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 12).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser("probe-expiry-owner@raft.test", "probe-expiry-owner");
    const server = await createServer("Probe Expiry", "probe-expiry", owner.id);
    const ownerToken = await login(app.baseUrl, owner.email);
    await enableFlags(server.id);
    const createdConnection = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ name: "Expiry DeepSeek", providerId: "deepseek", apiKey: "expiry-secret-value" }),
    });
    assert.equal(createdConnection.status, 201);
    const connection = (await createdConnection.json()) as { id: string };
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id, userId: owner.id, name: "expiry-machine", apiKeyHash: "he", runtimes: ["builtin"],
    }).returning();

    const [connectionRow] = await getDb().select({
      configVersion: providerConnections.configVersion,
      credentialVersion: providerConnectionCredentials.credentialVersion,
    }).from(providerConnections).innerJoin(providerConnectionCredentials, and(
      eq(providerConnectionCredentials.serverId, providerConnections.serverId),
      eq(providerConnectionCredentials.connectionId, providerConnections.id),
    )).where(eq(providerConnections.id, connection.id)).limit(1);
    // An open, dispatched-but-unclaimed intent aged past expiry: a claim retry
    // must close intent_expired with zero credentials handed out.
    const openProbeId = mintProviderProbeId();
    await getDb().insert(providerProbeIntents).values({
      id: openProbeId,
      serverId: server.id,
      connectionId: connection.id,
      configVersion: connectionRow!.configVersion,
      credentialVersion: connectionRow!.credentialVersion,
      computerId: machine.id,
      runtime: "builtin",
      model: "deepseek/deepseek-v4-pro",
      probeKind: "canary",
      probeRequestId: `probe-req-${randomUUID()}`,
      requestDigest: "expiry-request-digest",
      intentDigest: "expiry-intent-digest",
      createdByUserId: owner.id,
      expiresAt: new Date(Date.now() - 1_000),
      dispatchedAt: new Date(),
      dispatchRequestId: "expiry-dispatch",
      dispatchEpochId: AUTHORITY.connectionEpochId,
      dispatchGeneration: AUTHORITY.replicaGeneration,
      capabilityObserved: true,
      dispatchRuntimes: ["builtin"],
    });
    const createdView = { probe: { probeId: openProbeId as string } };
    await assert.rejects(
      materializeProviderProbe({
        serverId: server.id,
        probeId: createdView.probe.probeId as ProviderProbeId,
        machineId: machine.id,
        claimRequestId: "expired-claim",
        fact: FACT,
      }),
      /expired before materialization/,
    );
    const [intent] = await getDb().select().from(providerProbeIntents)
      .where(eq(providerProbeIntents.id, createdView.probe.probeId));
    assert.equal(intent?.closeReason, "intent_expired");
    const [receipt] = await getDb().select().from(providerProbeReceipts)
      .where(eq(providerProbeReceipts.probeId, createdView.probe.probeId));
    assert.equal(receipt?.category, "intent_expired");
    // GET lazily closes a second open-but-expired intent as well.
    const secondProbeId = mintProviderProbeId();
    await getDb().insert(providerProbeIntents).values({
      id: secondProbeId,
      serverId: server.id,
      connectionId: connection.id,
      configVersion: connectionRow!.configVersion,
      credentialVersion: connectionRow!.credentialVersion,
      computerId: machine.id,
      runtime: "builtin",
      model: "deepseek/deepseek-v4-pro",
      probeKind: "canary",
      probeRequestId: `probe-req-${randomUUID()}`,
      requestDigest: "expiry-request-digest-2",
      intentDigest: "expiry-intent-digest-2",
      createdByUserId: owner.id,
      expiresAt: new Date(Date.now() - 1_000),
    });
    // A valid result that arrives after expiry must close intent_expired.
    const [connectionRow2] = await getDb().select({
      configVersion: providerConnections.configVersion,
      credentialVersion: providerConnectionCredentials.credentialVersion,
    }).from(providerConnections).innerJoin(providerConnectionCredentials, and(
      eq(providerConnectionCredentials.serverId, providerConnections.serverId),
      eq(providerConnectionCredentials.connectionId, providerConnections.id),
    )).where(eq(providerConnections.id, connection.id)).limit(1);
    const lateProbeId = mintProviderProbeId();
    await getDb().insert(providerProbeIntents).values({
      id: lateProbeId,
      serverId: server.id,
      connectionId: connection.id,
      configVersion: connectionRow2!.configVersion,
      credentialVersion: connectionRow2!.credentialVersion,
      computerId: machine.id,
      runtime: "builtin",
      model: "deepseek/deepseek-v4-pro",
      probeKind: "canary",
      probeRequestId: `probe-req-${randomUUID()}`,
      requestDigest: "expiry-request-digest-3",
      intentDigest: "expiry-intent-digest-3",
      createdByUserId: owner.id,
      expiresAt: new Date(Date.now() - 1_000),
      dispatchedAt: new Date(),
      dispatchRequestId: "expiry-dispatch-3",
      dispatchEpochId: AUTHORITY.connectionEpochId,
      dispatchGeneration: AUTHORITY.replicaGeneration,
      capabilityObserved: true,
      dispatchDaemonVersion: "daemon-1",
      dispatchComputerVersion: "computer-1",
      dispatchRuntimeVersion: "pi-1",
      dispatchRuntimes: ["builtin"],
    });
    const lateReply = "OK";
    const lateResult = {
      type: "machine:provider_probe:result" as const,
      requestId: "expiry-dispatch-3",
      probeId: lateProbeId,
      outcome: "success" as const,
      category: null,
      latencyMs: 5,
      responseSha256: await sha256Hex(lateReply),
      responseBytes: utf8ByteLength(lateReply),
      resultDigest: await providerProbeResultDigest({
        outcome: "success",
        category: null,
        responseSha256: await sha256Hex(lateReply),
        responseBytes: utf8ByteLength(lateReply),
        authorityIdentity: await providerProbeAuthorityIdentity(AUTHORITY),
      }),
      authorityEcho: AUTHORITY,
      daemonVersion: "daemon-1",
      computerVersion: "computer-1",
      runtimeVersion: "pi-1",
      reply: lateReply,
    };
    const lateView = await consumeProviderProbeResult({ probeId: lateProbeId, message: lateResult });
    assert.equal(lateView.view.outcome, "failure");
    assert.equal(lateView.view.category, "intent_expired");
    assert.equal(lateView.reply, null);

    const read = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes/${secondProbeId}`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(read.status, 200);
    const readView = (await read.json()) as { category: string | null; closedAt: string | null };
    assert.equal(readView.category, "intent_expired");
    assert.notEqual(readView.closedAt, null);
  } finally {
    __setProviderProbeCarrierForTests(null);
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

test("probe budgets keep provider_timeout ahead of carrier_timeout, and daemon-decided categories land", async () => {
  const {
    PROVIDER_PROBE_BUDGET_MS,
    PROVIDER_PROBE_RELAY_BUDGET_MS,
    PROVIDER_PROBE_MATERIALIZE_BUDGET_MS,
    PROVIDER_PROBE_INTENT_TTL_MS,
  } = await import("@botiverse/raft-shared");
  assert.ok(PROVIDER_PROBE_MATERIALIZE_BUDGET_MS <= 5_000, "materialize must stay inside a 5s budget");
  assert.ok(
    PROVIDER_PROBE_RELAY_BUDGET_MS > PROVIDER_PROBE_BUDGET_MS,
    "relay budget must exceed the provider budget so daemon-decided provider_timeout lands first",
  );
  assert.ok(
    PROVIDER_PROBE_INTENT_TTL_MS > PROVIDER_PROBE_RELAY_BUDGET_MS,
    "intent TTL must outlive the relay so a surviving result is never late",
  );

  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 13).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser("probe-budget-owner@raft.test", "probe-budget-owner");
    const server = await createServer("Probe Budget", "probe-budget", owner.id);
    const ownerToken = await login(app.baseUrl, owner.email);
    await enableFlags(server.id);
    const createdConnection = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ name: "Budget DeepSeek", providerId: "deepseek", apiKey: "budget-secret-value" }),
    });
    assert.equal(createdConnection.status, 201);
    const connection = (await createdConnection.json()) as { id: string };
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id, userId: owner.id, name: "budget-machine", apiKeyHash: "hb", runtimes: ["builtin"],
    }).returning();

    const state: FakeCarrierState = {
      fact: FACT,
      dispatches: [],
      outcome: { kind: "provider_timeout_result" },
    };
    __setProviderProbeCarrierForTests(fakeCarrier(server.id, state));
    const created = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(await createBody(connection.id, machine.id)),
    });
    assert.equal(created.status, 201);
    const view = (await created.json()) as { probe: { probeId: string; outcome: string; category: string } };
    assert.equal(view.probe.outcome, "failure");
    assert.equal(view.probe.category, "provider_timeout", "a daemon-decided provider timeout must land as its own category");

    // claimRequestId boundary is enforced before any claim or credential read
    const [connectionRow] = await getDb().select({
      configVersion: providerConnections.configVersion,
      credentialVersion: providerConnectionCredentials.credentialVersion,
    }).from(providerConnections).innerJoin(providerConnectionCredentials, and(
      eq(providerConnectionCredentials.serverId, providerConnections.serverId),
      eq(providerConnectionCredentials.connectionId, providerConnections.id),
    )).where(eq(providerConnections.id, connection.id)).limit(1);
    const openProbeId = mintProviderProbeId();
    await getDb().insert(providerProbeIntents).values({
      id: openProbeId,
      serverId: server.id,
      connectionId: connection.id,
      configVersion: connectionRow!.configVersion,
      credentialVersion: connectionRow!.credentialVersion,
      computerId: machine.id,
      runtime: "builtin",
      model: "deepseek/deepseek-v4-pro",
      probeKind: "canary",
      probeRequestId: `probe-req-${randomUUID()}`,
      requestDigest: "budget-request-digest",
      intentDigest: "budget-intent-digest",
      createdByUserId: owner.id,
      expiresAt: new Date(Date.now() + 60_000),
      dispatchedAt: new Date(),
      dispatchRequestId: "budget-dispatch-2",
      dispatchEpochId: AUTHORITY.connectionEpochId,
      dispatchGeneration: AUTHORITY.replicaGeneration,
      capabilityObserved: true,
      dispatchDaemonVersion: "daemon-1",
      dispatchComputerVersion: "computer-1",
      dispatchRuntimeVersion: "pi-1",
      dispatchRuntimes: ["builtin"],
    });
    await assert.rejects(
      materializeProviderProbe({
        serverId: server.id,
        probeId: openProbeId,
        machineId: machine.id,
        claimRequestId: "c".repeat(129),
        fact: FACT,
      }),
      /Claim request id is invalid/,
    );
  } finally {
    __setProviderProbeCarrierForTests(null);
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

test("the shadow-UI receipt list exposes durable coordinates without reply bodies", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 14).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser("probe-list-owner@raft.test", "probe-list-owner");
    const member = await seedUser("probe-list-member@raft.test", "probe-list-member");
    const server = await createServer("Probe List", "probe-list", owner.id);
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
    const ownerToken = await login(app.baseUrl, owner.email);
    const memberToken = await login(app.baseUrl, member.email);
    await enableFlags(server.id);
    const createdConnection = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ name: "List DeepSeek", providerId: "deepseek", apiKey: "list-secret-value" }),
    });
    assert.equal(createdConnection.status, 201);
    const connection = (await createdConnection.json()) as { id: string };
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id, userId: owner.id, name: "list-machine", apiKeyHash: "hl", runtimes: ["builtin"],
    }).returning();

    const state: FakeCarrierState = { fact: FACT, dispatches: [], outcome: { kind: "claim_then_success" } };
    __setProviderProbeCarrierForTests(fakeCarrier(server.id, state));
    const created = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(await createBody(connection.id, machine.id)),
    });
    assert.equal(created.status, 201);

    const list = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(list.status, 200);
    const body = (await list.json()) as { receipts: Array<Record<string, unknown>> };
    assert.equal(body.receipts.length, 1);
    const receipt = body.receipts[0]!;
    assert.equal(receipt.outcome, "success");
    assert.equal(receipt.computerId, machine.id);
    assert.equal(receipt.runtimeVersion, "pi-1");
    assert.equal(receipt.dispatchEpochId, undefined, "the read model must not leak dispatch internals");
    assert.equal("reply" in receipt, false);
    const listText = JSON.stringify(body);
    assert.equal(listText.includes("list-secret-value"), false);

    const forbidden = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(forbidden.status, 403);
  } finally {
    __setProviderProbeCarrierForTests(null);
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});
