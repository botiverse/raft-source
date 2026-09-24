import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import {
  acknowledgeLifecycleReceipt,
  discardLifecycleOperation,
  enqueueLifecycleOperation,
  findPendingLifecycleOperation,
  readPendingLifecycleAcknowledgements,
  retireCompletedUpgradeShutdownsFromLog,
} from "./lifecycleOperations.js";
import {
  prepareExactLocalUpgradeLifecycleOperation,
  prepareExactLocalUpgradeLifecycleOperationResult,
  prepareLocalUpgradeLifecycleOperation,
  prepareLocalLifecycleOperations,
} from "./localLifecycleIntents.js";
import { serverAttachmentPath, upgradeLogPath, userSessionPath } from "./paths.js";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_SERVER_ID = "11111111-1111-4111-8111-222222222222";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_OPERATION_ID = "33333333-3333-4333-8333-333333333333";

async function startLifecycleIntentServer(onRequest: (authorization: string | undefined) => void) {
  const server = createServer(async (req, res) => {
    onRequest(req.headers.authorization);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { operationId: string };
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ operationId: body.operationId }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("upgrade intent persists its exact target and definitive refusal discards only that operation", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-lifecycle-upgrade-target-"));
  try {
    await enqueueLifecycleOperation(home, SERVER_ID, {
      operationId: OPERATION_ID,
      action: "upgrade",
      targetVersion: "1.0.18",
      trigger: "cli",
      pendingPhases: ["shutdown", "ready"],
    });
    await enqueueLifecycleOperation(home, SERVER_ID, {
      operationId: SECOND_OPERATION_ID,
      action: "restart",
      pendingPhases: ["shutdown", "ready"],
    });

    assert.deepEqual(findPendingLifecycleOperation(home, SERVER_ID, "upgrade"), {
      operationId: OPERATION_ID,
      action: "upgrade",
      targetVersion: "1.0.18",
      trigger: "cli",
      pendingPhases: ["shutdown", "ready"],
      createdAt: findPendingLifecycleOperation(home, SERVER_ID, "upgrade")!.createdAt,
    });
    await assert.rejects(
      enqueueLifecycleOperation(home, SERVER_ID, {
        operationId: OPERATION_ID,
        action: "upgrade",
        targetVersion: "1.0.19",
        trigger: "cli",
        pendingPhases: ["shutdown", "ready"],
      }),
      /OPERATION_IDENTITY_CONFLICT/u,
    );
    await assert.rejects(
      enqueueLifecycleOperation(home, SERVER_ID, {
        operationId: OPERATION_ID,
        action: "upgrade",
        targetVersion: "1.0.18",
        trigger: "tray",
        pendingPhases: ["shutdown", "ready"],
      }),
      /OPERATION_IDENTITY_CONFLICT/u,
    );

    await discardLifecycleOperation(home, SERVER_ID, OPERATION_ID);
    assert.equal(findPendingLifecycleOperation(home, SERVER_ID, "upgrade"), null);
    assert.equal(findPendingLifecycleOperation(home, SERVER_ID, "restart")?.operationId, SECOND_OPERATION_ID);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("preparing an upgrade durably binds the accepted trigger to its retry identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-lifecycle-upgrade-trigger-"));
  const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OPERATION_ID];
  try {
    const prepared = await prepareLocalUpgradeLifecycleOperation(
      home,
      SERVER_ID,
      "1.0.18",
      "tray",
      {
        readAttachment: async () => ({
          kind: "computer-attachment",
          serverId: SERVER_ID,
          serverMachineId: `computer-${SERVER_ID}`,
          machineId: "44444444-4444-4444-8444-444444444444",
          apiKey: "sk_computer_test",
          serverUrl: "https://one.example.test",
        }),
        ensureSession: async () => ({
          status: "usable",
          accessToken: "token-one",
          refreshed: false,
        }),
        createIntent: async (_serverUrl, _accessToken, input) => ({
          status: "accepted",
          operationId: input.operationId,
        }),
        createId: () => ids.shift()!,
      },
    );

    assert.deepEqual(prepared, {
      status: "prepared",
      operation: { serverId: SERVER_ID, operationId: OPERATION_ID, trigger: "tray" },
    });
    assert.equal(findPendingLifecycleOperation(home, SERVER_ID, "upgrade")?.trigger, "tray");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("single-origin upgrade preparation preserves policy refusal and classifies pre-K failures", async () => {
  const attachment = {
    kind: "computer-attachment" as const,
    serverId: SERVER_ID,
    serverMachineId: `computer-${SERVER_ID}`,
    machineId: "44444444-4444-4444-8444-444444444444",
    apiKey: "sk_computer_test",
    serverUrl: "https://one.example.test",
  };
  const base = {
    readAttachment: async () => attachment,
    ensureSession: async () => ({ status: "usable" as const, accessToken: "token-one", refreshed: false }),
    createId: () => OPERATION_ID,
  };
  assert.deepEqual(await prepareLocalUpgradeLifecycleOperation(
    "/unused",
    SERVER_ID,
    "1.0.22",
    "cli",
    {
      ...base,
      createIntent: async () => ({
        status: "rejected",
        code: "computer_broadcast_not_eligible",
        reason: "policy_row_missing",
      }),
    },
  ), {
    status: "rejected",
    code: "computer_broadcast_not_eligible",
    reason: "policy_row_missing",
  });

  assert.deepEqual(await prepareLocalUpgradeLifecycleOperation(
    "/unused",
    SERVER_ID,
    "1.0.22",
    "cli",
    {
      ...base,
      createIntent: async () => ({ status: "rejected", code: "request_failed" }),
    },
  ), { status: "rejected", code: "request_failed" });

  assert.deepEqual(await prepareLocalUpgradeLifecycleOperation(
    "/unused",
    SERVER_ID,
    "1.0.22",
    "cli",
    {
      ...base,
      createIntent: async (_serverUrl, _accessToken, input) => ({
        status: "accepted",
        operationId: input.operationId,
      }),
      enqueue: async () => { throw new Error("disk full"); },
    },
  ), { status: "rejected", code: "local_lifecycle_persist_failed" });
});

test("legacy adoption prepares the exact K id and durably replays shutdown plus ready", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-lifecycle-exact-upgrade-"));
  const intentInputs: unknown[] = [];
  try {
    const prepared = await prepareExactLocalUpgradeLifecycleOperation(
      home,
      SERVER_ID,
      OPERATION_ID,
      "1.0.18",
      "cli",
      {
        readAttachment: async () => ({
          kind: "computer-attachment",
          serverId: SERVER_ID,
          serverMachineId: `computer-${SERVER_ID}`,
          machineId: "44444444-4444-4444-8444-444444444444",
          apiKey: "sk_computer_test",
          serverUrl: "https://one.example.test",
        }),
        ensureSession: async () => ({
          status: "usable",
          accessToken: "token-one",
          refreshed: false,
        }),
        createIntent: async (_serverUrl, _accessToken, input) => {
          intentInputs.push(input);
          return { status: "accepted", operationId: input.operationId };
        },
        createId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    );

    assert.deepEqual(prepared, { serverId: SERVER_ID, operationId: OPERATION_ID, trigger: "cli" });
    assert.deepEqual(intentInputs, [{
      serverId: SERVER_ID,
      machineId: "44444444-4444-4444-8444-444444444444",
      operationId: OPERATION_ID,
      parentOperationId: OPERATION_ID,
      action: "upgrade",
      targetVersion: "1.0.18",
      completionMode: "legacy_k_promoted",
    }]);
    assert.deepEqual(readPendingLifecycleAcknowledgements(home, SERVER_ID, undefined, "1.0.18"), [
      { operationId: OPERATION_ID, action: "upgrade", phase: "shutdown" },
      { operationId: OPERATION_ID, action: "upgrade", phase: "ready", loadedComputerVersion: "1.0.18" },
    ]);

    const replayed = await prepareExactLocalUpgradeLifecycleOperation(
      home,
      SERVER_ID,
      OPERATION_ID,
      "1.0.18",
      "cli",
      {
        readAttachment: async () => ({
          kind: "computer-attachment",
          serverId: SERVER_ID,
          serverMachineId: `computer-${SERVER_ID}`,
          machineId: "44444444-4444-4444-8444-444444444444",
          apiKey: "sk_computer_test",
          serverUrl: "https://one.example.test",
        }),
        ensureSession: async () => ({ status: "usable", accessToken: "token-one", refreshed: false }),
        createIntent: async (_serverUrl, _accessToken, input) => ({
          status: "accepted",
          operationId: input.operationId,
        }),
      },
    );
    assert.equal(replayed?.operationId, OPERATION_ID, "exact crash replay remains idempotent");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy adoption refuses another pending upgrade identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-lifecycle-exact-conflict-"));
  try {
    await enqueueLifecycleOperation(home, SERVER_ID, {
      operationId: SECOND_OPERATION_ID,
      action: "upgrade",
      targetVersion: "1.0.18",
      trigger: "cli",
      pendingPhases: ["ready"],
    });
    const prepared = await prepareExactLocalUpgradeLifecycleOperation(
      home,
      SERVER_ID,
      OPERATION_ID,
      "1.0.18",
      "cli",
      {
        readAttachment: async () => ({
          kind: "computer-attachment",
          serverId: SERVER_ID,
          serverMachineId: `computer-${SERVER_ID}`,
          machineId: "44444444-4444-4444-8444-444444444444",
          apiKey: "sk_computer_test",
          serverUrl: "https://one.example.test",
        }),
        ensureSession: async () => ({ status: "usable", accessToken: "token-one", refreshed: false }),
        createIntent: async (_serverUrl, _accessToken, input) => ({
          status: "accepted",
          operationId: input.operationId,
        }),
      },
    );
    assert.equal(prepared, null);
    assert.equal(findPendingLifecycleOperation(home, SERVER_ID, "upgrade")?.operationId, SECOND_OPERATION_ID);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy adoption never reports prepared when Server rejects or local durable enqueue fails", async () => {
  const attachment = {
    kind: "computer-attachment" as const,
    serverId: SERVER_ID,
    serverMachineId: `computer-${SERVER_ID}`,
    machineId: "44444444-4444-4444-8444-444444444444",
    apiKey: "sk_computer_test",
    serverUrl: "https://one.example.test",
  };
  for (const mode of ["server-reject", "enqueue-fail"] as const) {
    let enqueueCalls = 0;
    const prepared = await prepareExactLocalUpgradeLifecycleOperation(
      "/unused",
      SERVER_ID,
      OPERATION_ID,
      "1.0.18",
      "cli",
      {
        readAttachment: async () => attachment,
        ensureSession: async () => ({ status: "usable", accessToken: "token-one", refreshed: false }),
        createIntent: async (_serverUrl, _accessToken, input) => mode === "server-reject"
          ? { status: "rejected", code: "computer_offline" }
          : { status: "accepted", operationId: input.operationId },
        enqueueExact: async () => {
          enqueueCalls += 1;
          return false;
        },
      },
    );
    assert.equal(prepared, null);
    assert.equal(enqueueCalls, mode === "server-reject" ? 0 : 1);
  }
});

test("legacy adoption classifies only ready visibility as retryable and keeps the exact identity", async () => {
  const attachment = {
    kind: "computer-attachment" as const,
    serverId: SERVER_ID,
    serverMachineId: `computer-${SERVER_ID}`,
    machineId: "44444444-4444-4444-8444-444444444444",
    apiKey: "sk_computer_test",
    serverUrl: "https://one.example.test",
  };
  const intentInputs: Array<{ operationId: string; parentOperationId: string }> = [];
  for (const code of [
    "computer_offline",
    "computer_lifecycle_completion_ready_pending",
    "computer_lifecycle_completion_target_mismatch",
  ] as const) {
    const result = await prepareExactLocalUpgradeLifecycleOperationResult(
      "/unused",
      SERVER_ID,
      OPERATION_ID,
      "1.0.18",
      "cli",
      {
        readAttachment: async () => attachment,
        ensureSession: async () => ({ status: "usable", accessToken: "token-one", refreshed: false }),
        createIntent: async (_serverUrl, _accessToken, input) => {
          intentInputs.push({ operationId: input.operationId, parentOperationId: input.parentOperationId });
          return { status: "rejected", code };
        },
      },
    );
    assert.deepEqual(
      result,
      code === "computer_lifecycle_completion_target_mismatch"
        ? { status: "rejected", code }
        : { status: "retryable_ready_pending", code },
    );
  }
  assert.deepEqual(intentInputs, Array.from({ length: 3 }, () => ({
    operationId: OPERATION_ID,
    parentOperationId: OPERATION_ID,
  })));
});

test("restart acknowledgement survives process replacement until both phase receipts arrive", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-lifecycle-"));
  try {
    await enqueueLifecycleOperation(home, SERVER_ID, {
      operationId: OPERATION_ID,
      action: "restart",
      pendingPhases: ["shutdown", "ready"],
    });
    // Mixed-version duplicate delivery must not create another execution.
    await enqueueLifecycleOperation(home, SERVER_ID, {
      operationId: OPERATION_ID,
      action: "restart",
      pendingPhases: ["shutdown", "ready"],
    });

    assert.deepEqual(readPendingLifecycleAcknowledgements(home, SERVER_ID, undefined, "0.72.6"), [
      { operationId: OPERATION_ID, action: "restart", phase: "shutdown" },
      { operationId: OPERATION_ID, action: "restart", phase: "ready", loadedComputerVersion: "0.72.6" },
    ]);

    await acknowledgeLifecycleReceipt(home, SERVER_ID, OPERATION_ID, "shutdown");
    assert.deepEqual(readPendingLifecycleAcknowledgements(home, SERVER_ID, undefined, "0.72.6"), [
      { operationId: OPERATION_ID, action: "restart", phase: "ready", loadedComputerVersion: "0.72.6" },
    ]);

    await acknowledgeLifecycleReceipt(home, SERVER_ID, OPERATION_ID, "ready");
    assert.deepEqual(readPendingLifecycleAcknowledgements(home, SERVER_ID), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("back-to-back receipts and enqueue mutations preserve every operation phase", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-lifecycle-race-"));
  try {
    await enqueueLifecycleOperation(home, SERVER_ID, {
      operationId: OPERATION_ID,
      action: "restart",
      pendingPhases: ["shutdown", "ready"],
    });

    await Promise.all([
      acknowledgeLifecycleReceipt(home, SERVER_ID, OPERATION_ID, "shutdown"),
      acknowledgeLifecycleReceipt(home, SERVER_ID, OPERATION_ID, "ready"),
    ]);
    assert.deepEqual(readPendingLifecycleAcknowledgements(home, SERVER_ID), []);

    await enqueueLifecycleOperation(home, SERVER_ID, {
      operationId: OPERATION_ID,
      action: "restart",
      pendingPhases: ["shutdown", "ready"],
    });
    await Promise.all([
      acknowledgeLifecycleReceipt(home, SERVER_ID, OPERATION_ID, "shutdown"),
      enqueueLifecycleOperation(home, SERVER_ID, {
        operationId: SECOND_OPERATION_ID,
        action: "stop",
        pendingPhases: ["shutdown"],
      }),
    ]);
    assert.deepEqual(readPendingLifecycleAcknowledgements(home, SERVER_ID), [
      { operationId: OPERATION_ID, action: "restart", phase: "ready" },
      { operationId: SECOND_OPERATION_ID, action: "stop", phase: "shutdown" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("completed upgrade log retires only legacy shutdown phase for exact upgrade operation", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-lifecycle-upgrade-log-"));
  try {
    await enqueueLifecycleOperation(home, SERVER_ID, {
      operationId: OPERATION_ID,
      action: "upgrade",
      pendingPhases: ["shutdown"],
    });
    await enqueueLifecycleOperation(home, SERVER_ID, {
      operationId: SECOND_OPERATION_ID,
      action: "upgrade",
      pendingPhases: ["shutdown", "ready"],
    });
    await enqueueLifecycleOperation(home, SECOND_SERVER_ID, {
      operationId: OPERATION_ID,
      action: "upgrade",
      pendingPhases: ["shutdown"],
    });
    await mkdir(dirname(upgradeLogPath(home)), { recursive: true });
    await writeFile(
      upgradeLogPath(home),
      [
        JSON.stringify({ requestId: OPERATION_ID, outcome: "ok" }),
        JSON.stringify({ requestId: SECOND_OPERATION_ID, outcome: "err" }),
        "not-json",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    assert.equal(await retireCompletedUpgradeShutdownsFromLog(home, SERVER_ID), 1);
    assert.deepEqual(readPendingLifecycleAcknowledgements(home, SERVER_ID), [
      { operationId: SECOND_OPERATION_ID, action: "upgrade", phase: "shutdown" },
      { operationId: SECOND_OPERATION_ID, action: "upgrade", phase: "ready" },
    ]);
    assert.deepEqual(readPendingLifecycleAcknowledgements(home, SECOND_SERVER_ID), [
      { operationId: OPERATION_ID, action: "upgrade", phase: "shutdown" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("local lifecycle intent authority resolves a user session per server origin", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-lifecycle-origins-"));
  const ids = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    OPERATION_ID,
    SECOND_OPERATION_ID,
  ];
  const sessionOrigins: string[] = [];
  const intentCalls: Array<{ serverUrl: string; accessToken: string; serverId: string }> = [];
  try {
    const prepared = await prepareLocalLifecycleOperations(home, "restart", [SERVER_ID, SECOND_SERVER_ID], {
      readAttachment: async (_slockHome, serverId) => ({
        kind: "computer-attachment",
        serverId,
        serverMachineId: `computer-${serverId}`,
        machineId: serverId === SERVER_ID
          ? "44444444-4444-4444-8444-444444444444"
          : "55555555-5555-4555-8555-555555555555",
        apiKey: "sk_computer_test",
        serverUrl: serverId === SERVER_ID ? "https://one.example.test" : "https://two.example.test",
      }),
      ensureSession: async (_slockHome, serverUrl) => {
        sessionOrigins.push(serverUrl);
        return {
          status: "usable",
          accessToken: serverUrl.includes("one") ? "token-one" : "token-two",
          refreshed: false,
        };
      },
      createIntent: async (serverUrl, accessToken, input) => {
        intentCalls.push({ serverUrl, accessToken, serverId: input.serverId });
        return { status: "accepted", operationId: input.operationId };
      },
      createId: () => ids.shift()!,
    });

    assert.deepEqual(sessionOrigins, ["https://one.example.test", "https://two.example.test"]);
    assert.deepEqual(intentCalls, [
      { serverUrl: "https://one.example.test", accessToken: "token-one", serverId: SERVER_ID },
      { serverUrl: "https://two.example.test", accessToken: "token-two", serverId: SECOND_SERVER_ID },
    ]);
    assert.deepEqual(prepared, [
      { serverId: SERVER_ID, operationId: OPERATION_ID },
      { serverId: SECOND_SERVER_ID, operationId: SECOND_OPERATION_ID },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("default local intent path never sends one origin's refresh credential to another origin", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-lifecycle-origin-boundary-"));
  const originAAuth: Array<string | undefined> = [];
  let originBRequests = 0;
  const originA = await startLifecycleIntentServer((authorization) => originAAuth.push(authorization));
  const originB = await startLifecycleIntentServer(() => { originBRequests += 1; });
  try {
    const sessionFile = userSessionPath(home);
    await mkdir(dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, JSON.stringify({
      kind: "user-session",
      accessToken: "origin-a-access-token",
      refreshToken: "origin-a-refresh-secret",
      serverUrl: originA.url,
    }));
    for (const [serverId, serverUrl, machineId] of [
      [SERVER_ID, originA.url, "44444444-4444-4444-8444-444444444444"],
      [SECOND_SERVER_ID, originB.url, "55555555-5555-4555-8555-555555555555"],
    ] as const) {
      const file = serverAttachmentPath(home, serverId);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({
        kind: "computer-attachment",
        serverId,
        serverMachineId: `computer-${serverId}`,
        machineId,
        apiKey: "sk_computer_test",
        serverUrl,
      }));
    }

    const prepared = await prepareLocalLifecycleOperations(home, "restart", [SERVER_ID, SECOND_SERVER_ID]);
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0]?.serverId, SERVER_ID);
    assert.deepEqual(originAAuth, ["Bearer origin-a-access-token"]);
    assert.equal(originBRequests, 0, "origin mismatch must fail closed before any network request");
    assert.deepEqual(readPendingLifecycleAcknowledgements(home, SECOND_SERVER_ID), []);
  } finally {
    await Promise.all([originA.close(), originB.close()]);
    await rm(home, { recursive: true, force: true });
  }
});
