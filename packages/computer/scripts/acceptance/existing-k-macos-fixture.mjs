#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const FIXTURE_ATTACHMENTS = Object.freeze([
  Object.freeze({
    serverId: "11111111-1111-4111-8111-111111111111",
    serverSlug: "task603-a",
    serverMachineId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    machineId: "a1111111-1111-4111-8111-111111111111",
    apiKey: "sk_computer_task603_a",
  }),
  Object.freeze({
    serverId: "22222222-2222-4222-8222-222222222222",
    serverSlug: "task603-b",
    serverMachineId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    machineId: "b2222222-2222-4222-8222-222222222222",
    apiKey: "sk_computer_task603_b",
  }),
  Object.freeze({
    serverId: "33333333-3333-4333-8333-333333333333",
    serverSlug: "task603-c",
    serverMachineId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    machineId: "c3333333-3333-4333-8333-333333333333",
    apiKey: "sk_computer_task603_c",
  }),
]);

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function option(name, args = process.argv.slice(2)) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) fail("FIXTURE_ARG_MISSING", name);
  return args[index + 1];
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fileSha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * The public 1.0.17 installer publishes only the PATH dispatcher. It does not
 * initialize K, so an acceptance run whose precondition is "existing K" must
 * materialize the first stable slot explicitly from those already-verified
 * public bytes. Computer 1.0.17 and the current package both bind
 * @botiverse/k-carrier 0.1.6. The dispatch-only workflow intentionally has no
 * dependency-install step, so mirror that version's bootstrapStable fresh-root
 * file effects here: staged copy + fsync + executable mode + VERSION + atomic
 * stable rename. This isolated run has no concurrent K writer, so the shared
 * library's inter-process lock has no competing participant to serialize.
 */
export async function materializeLegacyKStable(
  slockHome,
  version,
  artifactPath,
  expectedSha256,
  deps = {},
) {
  const sourceSha256 = await fileSha256(artifactPath);
  if (sourceSha256 !== expectedSha256) {
    fail("BASELINE_LEGACY_K_SOURCE_BYTES_MISMATCH", JSON.stringify({
      expectedSha256,
      sourceSha256,
    }));
  }
  const stateDir = join(slockHome, "computer", "k");
  const slotsDir = join(stateDir, "slots");
  const stableDir = join(slotsDir, "stable");
  const stagingDir = `${stableDir}.bootstrap`;
  for (const conflicting of [stableDir, join(stateDir, "journal.jsonl"), join(slotsDir, "experiment")]) {
    if (await exists(conflicting)) {
      fail("BASELINE_LEGACY_K_BOOTSTRAP_STATE_CONFLICT", conflicting);
    }
  }
  const source = await stat(artifactPath);
  if (!source.isFile()) {
    fail("BASELINE_LEGACY_K_BOOTSTRAP_SOURCE_INVALID", artifactPath);
  }
  await rm(stagingDir, { recursive: true, force: true });
  try {
    await mkdir(stagingDir, { recursive: true });
    const stagingArtifact = join(stagingDir, "artifact.bin");
    await (deps.copyFileFn ?? copyFile)(artifactPath, stagingArtifact);
    await (deps.syncArtifactFn ?? (async (path) => {
      const artifactHandle = await open(path, "r+");
      try {
        await artifactHandle.sync();
      } finally {
        await artifactHandle.close();
      }
    }))(stagingArtifact);
    await chmod(stagingArtifact, 0o755);
    await (deps.writeVersionFn ?? (async (path, value) => {
      const versionHandle = await open(path, "w");
      try {
        await versionHandle.writeFile(value);
        await versionHandle.sync();
      } finally {
        await versionHandle.close();
      }
    }))(join(stagingDir, "VERSION"), version);
    await mkdir(slotsDir, { recursive: true });
    await (deps.renameFn ?? rename)(stagingDir, stableDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const stablePath = join(stateDir, "slots", "stable", "artifact.bin");
  const stableVersion = (await readFile(join(stateDir, "slots", "stable", "VERSION"), "utf8")).trim();
  const stableSha256 = await fileSha256(stablePath);
  const stableMode = (await stat(stablePath)).mode & 0o777;
  if (stableVersion !== version || stableSha256 !== expectedSha256 || stableMode !== 0o755) {
    fail("BASELINE_LEGACY_K_STABLE_READBACK_MISMATCH", JSON.stringify({
      expectedSha256,
      stableSha256,
      expectedVersion: version,
      stableVersion,
      expectedMode: "0755",
      stableMode: stableMode.toString(8).padStart(4, "0"),
    }));
  }
  return { outcome: "bootstrapped", stablePath, stableVersion, stableSha256, stableMode: "0755" };
}

function websocketFrame(payload) {
  const body = Buffer.from(payload, "utf8");
  if (body.length >= 126) fail("FIXTURE_FRAME_TOO_LARGE", String(body.length));
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
}

export async function startFixtureServer(stateFile) {
  const socketsByCredential = new Map(
    FIXTURE_ATTACHMENTS.map(({ apiKey }) => [apiKey, new Set()]),
  );
  const connectionCounts = Object.fromEntries(
    FIXTURE_ATTACHMENTS.map(({ serverSlug }) => [serverSlug, 0]),
  );
  const labelForCredential = new Map(
    FIXTURE_ATTACHMENTS.map(({ apiKey, serverSlug }) => [apiKey, serverSlug]),
  );

  const state = () => ({
    active: Object.fromEntries(
      FIXTURE_ATTACHMENTS.map(({ apiKey, serverSlug }) => [
        serverSlug,
        socketsByCredential.get(apiKey)?.size ?? 0,
      ]),
    ),
    connectionCounts,
  });

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/fixture/state") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(state()));
      return;
    }
    if (request.method === "GET" && request.url === "/failure/1.0.18/manifest.json") {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("fixture source unavailable\n");
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found\n");
  });

  server.on("upgrade", (request, socket) => {
    const credential = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
    const key = request.headers["sec-websocket-key"];
    const owned = socketsByCredential.get(credential);
    if (request.url !== "/daemon/connect" || typeof key !== "string" || !owned) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    owned.add(socket);
    const label = labelForCredential.get(credential);
    connectionCounts[label] += 1;
    const sendPing = () => {
      if (!socket.destroyed) socket.write(websocketFrame('{"type":"ping"}'));
    };
    sendPing();
    const timer = setInterval(sendPing, 5_000);
    timer.unref();
    const forget = () => {
      clearInterval(timer);
      owned.delete(socket);
    };
    socket.on("close", forget);
    socket.on("error", forget);
    socket.on("data", () => {});
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") fail("FIXTURE_LISTEN_FAILED", "no TCP address");
  const fixtureState = {
    pid: process.pid,
    port: address.port,
    serverUrl: `http://127.0.0.1:${address.port}`,
  };
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(fixtureState)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(fixtureState)}\n`);

  const close = async () => {
    for (const sockets of socketsByCredential.values()) {
      for (const socket of sockets) socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
    await rm(stateFile, { force: true });
  };
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  return new Promise(() => {});
}

export async function seedAttachments(slockHome, serverUrl) {
  for (const attachment of FIXTURE_ATTACHMENTS) {
    const serverDir = join(slockHome, "computer", "servers", attachment.serverId);
    await mkdir(serverDir, { recursive: true });
    await writeFile(
      join(serverDir, "runner.state.json"),
      `${JSON.stringify({
        kind: "computer-attachment",
        schemaVersion: 1,
        ...attachment,
        serverUrl,
        attachedAt: "2026-08-29T00:00:00.000Z",
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(join(serverDir, "managed.flag"), "managed\n", { mode: 0o600 });
  }
  return {
    serverUrl,
    attachments: FIXTURE_ATTACHMENTS.map(({ apiKey: _apiKey, ...identity }) => identity),
  };
}

async function assertLiveOnce(slockHome, version, serverUrl) {
  const serviceEvidence = await readJson(join(slockHome, "computer", "service-version.json"));
  const servicePid = Number((await readFile(join(slockHome, "computer", "run", "service.pid"), "utf8")).trim());
  if (serviceEvidence.version !== version || serviceEvidence.pid !== servicePid || !processAlive(servicePid)) {
    fail("FIXTURE_SERVICE_NOT_LIVE", JSON.stringify({ version, serviceEvidence, servicePid }));
  }

  const observed = [];
  for (const expected of FIXTURE_ATTACHMENTS) {
    const serverDir = join(slockHome, "computer", "servers", expected.serverId);
    const attachment = await readJson(join(serverDir, "runner.state.json"));
    for (const key of ["serverId", "serverSlug", "serverMachineId", "machineId", "apiKey"]) {
      if (attachment[key] !== expected[key]) {
        fail("FIXTURE_ATTACHMENT_IDENTITY_DRIFT", `${expected.serverSlug}:${key}`);
      }
    }
    if (attachment.serverUrl !== serverUrl) {
      fail("FIXTURE_ATTACHMENT_ENDPOINT_DRIFT", expected.serverSlug);
    }
    const runnerPid = Number((await readFile(join(serverDir, "runner.pid"), "utf8")).trim());
    const runnerEvidence = await readJson(join(serverDir, "runner-version.json"));
    const connected = await readJson(join(serverDir, "runner.connected"));
    if (
      !processAlive(runnerPid)
      || runnerEvidence.version !== version
      || runnerEvidence.pid !== runnerPid
      || connected.pid !== runnerPid
    ) {
      fail("FIXTURE_RUNNER_NOT_LIVE", JSON.stringify({
        serverSlug: expected.serverSlug,
        version,
        runnerPid,
        runnerEvidence,
        connected,
      }));
    }
    observed.push({
      serverId: expected.serverId,
      serverMachineId: expected.serverMachineId,
      machineId: expected.machineId,
      pid: runnerPid,
      version: runnerEvidence.version,
      connectedAt: connected.connectedAt,
    });
  }

  const fixtureResponse = await fetch(`${serverUrl}/fixture/state`);
  if (!fixtureResponse.ok) fail("FIXTURE_STATE_UNAVAILABLE", String(fixtureResponse.status));
  const fixtureState = await fixtureResponse.json();
  for (const { serverSlug } of FIXTURE_ATTACHMENTS) {
    if (fixtureState.active?.[serverSlug] !== 1) {
      fail("FIXTURE_CONNECTION_SET_MISMATCH", JSON.stringify(fixtureState));
    }
  }
  return { version, servicePid, attachments: observed, fixtureState };
}

export async function waitForLive(slockHome, version, serverUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      return await assertLiveOnce(slockHome, version, serverUrl);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);
  throw lastError;
}

async function assertFailedReceiptOnce(slockHome) {
  const kDir = join(slockHome, "computer", "k");
  const operation = await readJson(join(kDir, "operation.json"));
  if (
    operation.fromVersion !== "1.0.17"
    || operation.previousStableVersion !== "1.0.17"
    || operation.targetVersion !== "1.0.18"
    || operation.phase !== "failed"
    || operation.outcome !== "failed"
    || operation.acknowledgedAtMs !== null
  ) {
    fail("FIXTURE_FAILED_RECEIPT_MISMATCH", JSON.stringify(operation));
  }
  const stableVersion = (await readFile(join(kDir, "slots", "stable", "VERSION"), "utf8")).trim();
  if (stableVersion !== "1.0.17" || await exists(join(kDir, "slots", "experiment"))) {
    fail("FIXTURE_FAILED_RECOVERY_MISMATCH", JSON.stringify({ stableVersion }));
  }
  const journalPath = join(kDir, "journal.jsonl");
  const intents = (await exists(journalPath))
    ? (await readFile(journalPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).intent)
    : [];
  const phase = intents.at(-1) ?? "idle";
  if (!new Set(["idle", "promoted", "rolled-back"]).has(phase)) {
    fail("FIXTURE_FAILED_RECOVERY_NOT_AT_REST", phase);
  }
  return { operation, stableVersion, phase };
}

export async function waitForFailedReceipt(slockHome, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      return await assertFailedReceiptOnce(slockHome);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);
  throw lastError;
}

export async function assertOperation(slockHome, expected) {
  const operation = await readJson(join(slockHome, "computer", "k", "operation.json"));
  for (const key of ["fromVersion", "targetVersion", "outcome"]) {
    if (operation[key] !== expected[key]) {
      fail("FIXTURE_OPERATION_MISMATCH", `${key}: expected=${expected[key]} actual=${operation[key]}`);
    }
  }
  if (operation.phase !== expected.outcome || !Number.isFinite(operation.acknowledgedAtMs)) {
    fail("FIXTURE_OPERATION_NOT_ACKNOWLEDGED", JSON.stringify(operation));
  }
  if (expected.carrier && operation.provenance?.carrier !== expected.carrier) {
    fail("FIXTURE_OPERATION_CARRIER_MISMATCH", JSON.stringify(operation.provenance));
  }
  if (expected.artifactSha256 && operation.metadata?.artifactSha256 !== expected.artifactSha256) {
    fail("FIXTURE_OPERATION_ARTIFACT_MISMATCH", JSON.stringify(operation.metadata));
  }
  return operation;
}

export async function probeMissingSelf(binary, copy, slockHome) {
  const stablePath = join(slockHome, "computer", "k", "slots", "stable", "artifact.bin");
  const operationPath = join(slockHome, "computer", "k", "operation.json");
  const servicePidPath = join(slockHome, "computer", "run", "service.pid");
  const before = {
    stableSha256: await fileSha256(stablePath),
    operationSha256: await fileSha256(operationPath),
    servicePid: Number((await readFile(servicePidPath, "utf8")).trim()),
  };
  if (!processAlive(before.servicePid)) {
    fail("MISSING_SELF_SERVICE_NOT_LIVE", String(before.servicePid));
  }

  await mkdir(dirname(copy), { recursive: true });
  await copyFile(binary, copy);
  await chmod(copy, 0o755);
  const child = spawn(copy, ["status"], {
    env: {
      ...process.env,
      SLOCK_HOME: slockHome,
      RAFT_HOME: slockHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await rm(copy, { force: true });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const output = Buffer.concat([...stdout, ...stderr]).toString("utf8");
  if (exit.code === 0 || !output.includes(copy)) {
    fail("MISSING_SELF_FAIL_CLOSED_TOOTH_MISSING", JSON.stringify({ exit, output }));
  }

  const after = {
    stableSha256: await fileSha256(stablePath),
    operationSha256: await fileSha256(operationPath),
    servicePid: Number((await readFile(servicePidPath, "utf8")).trim()),
  };
  if (
    after.stableSha256 !== before.stableSha256
    || after.operationSha256 !== before.operationSha256
    || after.servicePid !== before.servicePid
    || !processAlive(after.servicePid)
  ) {
    fail("MISSING_SELF_MUTATED_RESIDENT_STATE", JSON.stringify({ before, after }));
  }
  return { exit, missingSelf: copy, residentStatePreserved: true };
}

/**
 * Computer 1.0.17 compares the running SEA path with K's stable path by
 * spelling, before the real-file identity fix shipped. On macOS `/tmp` is a
 * symlink to `/private/tmp`: launchd canonicalizes process.execPath, while a
 * fixture-provided `/tmp/...` SLOCK_HOME makes the legacy resolver construct a
 * different `/tmp/.../artifact.bin` spelling for the same file. The old carrier
 * then execs itself forever instead of reaching service identity publication.
 *
 * Bind the historical source alias and the corrected canonical launch shape
 * explicitly. This command is diagnostic-only and never starts the binary.
 */
export async function assertLegacyKLaunchIdentity(sourceSlockHome, launchSlockHome, binary) {
  const stableParts = ["computer", "k", "slots", "stable", "artifact.bin"];
  const sourceStable = resolve(sourceSlockHome, ...stableParts);
  const launchStable = resolve(launchSlockHome, ...stableParts);
  const [canonicalSourceHome, canonicalLaunchHome, canonicalBinary, canonicalLaunchStable] =
    await Promise.all([
      realpath(sourceSlockHome),
      realpath(launchSlockHome),
      realpath(binary),
      realpath(launchStable),
    ]);
  const sourceWouldRedispatch = sourceStable !== canonicalBinary;
  const launchWouldRedispatch = launchStable !== canonicalBinary;

  if (canonicalSourceHome !== canonicalLaunchHome || canonicalLaunchStable !== canonicalBinary) {
    fail("BASELINE_LEGACY_K_REAL_FILE_IDENTITY_MISMATCH", JSON.stringify({
      canonicalSourceHome,
      canonicalLaunchHome,
      canonicalBinary,
      canonicalLaunchStable,
    }));
  }
  if (!sourceWouldRedispatch) {
    fail("BASELINE_LEGACY_K_ALIAS_PRECONDITION_MISSING", JSON.stringify({
      sourceStable,
      canonicalBinary,
    }));
  }
  if (launchWouldRedispatch) {
    fail("BASELINE_LEGACY_K_SELF_DISPATCH_ALIAS", JSON.stringify({
      launchStable,
      canonicalBinary,
    }));
  }
  return {
    sourceSlockHome,
    canonicalSourceHome,
    sourceStable,
    launchSlockHome,
    launchStable,
    canonicalBinary,
    sourceWouldRedispatch,
    launchWouldRedispatch,
  };
}

async function main(args = process.argv.slice(2)) {
  const command = args[0];
  if (command === "serve") {
    await startFixtureServer(option("--state-file", args));
    return;
  }
  if (command === "seed") {
    process.stdout.write(`${JSON.stringify(await seedAttachments(
      option("--slock-home", args),
      option("--server-url", args),
    ))}\n`);
    return;
  }
  if (command === "assert-live") {
    process.stdout.write(`${JSON.stringify(await waitForLive(
      option("--slock-home", args),
      option("--version", args),
      option("--server-url", args),
    ))}\n`);
    return;
  }
  if (command === "assert-failed-receipt") {
    process.stdout.write(`${JSON.stringify(await waitForFailedReceipt(option("--slock-home", args)))}\n`);
    return;
  }
  if (command === "assert-operation") {
    process.stdout.write(`${JSON.stringify(await assertOperation(option("--slock-home", args), {
      fromVersion: option("--from", args),
      targetVersion: option("--target", args),
      outcome: option("--outcome", args),
      carrier: option("--carrier", args),
      artifactSha256: option("--artifact-sha256", args),
    }))}\n`);
    return;
  }
  if (command === "probe-missing-self") {
    process.stdout.write(`${JSON.stringify(await probeMissingSelf(
      option("--binary", args),
      option("--copy", args),
      option("--slock-home", args),
    ))}\n`);
    return;
  }
  if (command === "materialize-legacy-k-stable") {
    process.stdout.write(`${JSON.stringify(await materializeLegacyKStable(
      option("--slock-home", args),
      option("--version", args),
      option("--artifact", args),
      option("--artifact-sha256", args),
    ))}\n`);
    return;
  }
  if (command === "assert-legacy-k-launch-identity") {
    process.stdout.write(`${JSON.stringify(await assertLegacyKLaunchIdentity(
      option("--source-slock-home", args),
      option("--launch-slock-home", args),
      option("--binary", args),
    ))}\n`);
    return;
  }
  fail("FIXTURE_COMMAND_INVALID", command ?? "missing");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
