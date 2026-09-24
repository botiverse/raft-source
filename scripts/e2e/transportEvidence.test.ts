import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir, copyFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "playwright";
import { createEvidenceWriter, observeLogin, prepareTransportEvidence, SEGMENT_BYTES } from "./transportEvidence.js";
import type { EvidenceConfig } from "./transportEvidence.js";
import { loginViaApiWithCredentials } from "../../packages/web/tests/e2e/fixtures/auth.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = path.join(root, "scripts/e2e/fixtures/api.ts");

async function directory(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "login-evidence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return realpath(dir);
}
async function rows(dir: string, prefix = "server.jsonl") {
  const files = (await readdir(dir)).filter((name) => name.startsWith(prefix));
  return (await Promise.all(files.map((name) => readFile(path.join(dir, name), "utf8"))))
    .flatMap((text) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
}
async function start(t: TestContext, config: EvidenceConfig, mode = "normal", observe = true) {
  const child = fork(fixture, [], {
    execArgv: ["--import", "tsx"], silent: true,
    env: { ...process.env, SLOCK_E2E_TRANSPORT_DIR: config.directory, SLOCK_E2E_TRANSPORT_RUN_ID: config.runId,
      FIXTURE_MODE: mode, FIXTURE_OBSERVE: observe ? "on" : "off" },
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  const [message] = await once(child, "message");
  return { child, exited, url: `http://127.0.0.1:${message.port}` };
}
async function close(service: Awaited<ReturnType<typeof start>>) {
  service.child.send("close");
  assert.deepEqual(await service.exited, { code: 0, signal: null });
}

for (const mode of ["normal", "close", "reset"] as const) {
  test(`real isolated login: ${mode} has distinct lifecycle evidence`, { timeout: 15000 }, async (t) => {
    const dir = await directory(t);
    const config = prepareTransportEvidence(dir)!;
    const service = await start(t, config, mode);
    const api = await request.newContext();
    t.after(() => api.dispose());
    let original: unknown;
    const operation = observeLogin(config, { retry: 0, workerIndex: 3, parallelIndex: 0 }, async (headers) => {
      try {
        const response = await api.post(`${service.url}/api/auth/login`, {
          headers: { ...headers, authorization: "SECRET_HEADER" },
          data: { email: "SECRET_EMAIL", password: "SECRET_PASSWORD" },
        });
        return await response.json();
      } catch (error) { original = error; throw error; }
    });
    if (mode === "normal") assert.equal((await operation).accessToken, "SECRET_RESPONSE_TOKEN");
    else await assert.rejects(operation, (error) => error === original);
    await close(service);
    const events = await rows(dir);
    const client = await rows(dir, "client-0.jsonl");
    const arrival = events.find((row) => row.event === "login_arrival");
    assert.equal(arrival.requestId, client[0].requestId);
    assert.ok(events.some((row) => row.event === "connection_open" && row.connectionId === arrival.connectionId));
    assert.ok(events.some((row) => row.event === "process_start"));
    assert.ok(events.some((row) => row.event === "process_exit" && row.exitCode === 0));
    if (mode === "normal") {
      assert.ok(events.some((row) => row.event === "login_finish" && row.status === 200));
      assert.equal(client.at(-1).event, "login_success");
    } else {
      assert.equal(events.filter((row) => row.event === "login_finish").length, 0);
      assert.ok(events.some((row) => row.event === "connection_close"));
      assert.equal(client.at(-1).event, "login_failure");
      const marker = JSON.parse(await readFile(path.join(dir, "first-failure-client-0.json"), "utf8"));
      assert.equal(marker.requestId, arrival.requestId);
      assert.ok(marker.serverSnapshots.length > 0);
      const closeIndex = events.findIndex((row) => row.event === "listener_close");
      const exitIndex = events.findIndex((row) => row.event === "process_exit");
      assert.ok(closeIndex >= 0 && closeIndex < exitIndex);
      // For reset, listener_close occurs only when the parent later asks it to stop.
      // Prove listener survival by a fresh TCP request before that stop in a separate test below.
    }
    const all = (await Promise.all((await readdir(dir)).map((name) => readFile(path.join(dir, name), "utf8")))).join("");
    assert.doesNotMatch(all, /SECRET_|authorization|password|accessToken|refreshToken/);
    if (process.env.EVIDENCE_SAMPLE_DIR) {
      const destination = path.join(process.env.EVIDENCE_SAMPLE_DIR, mode);
      await mkdir(destination, { recursive: true });
      for (const name of await readdir(dir)) await copyFile(path.join(dir, name), path.join(destination, name));
    }
  });
}

test("reset leaves the same listener alive; close removes it", { timeout: 15000 }, async (t) => {
  for (const mode of ["reset-once", "close"]) {
    const config = prepareTransportEvidence(await directory(t))!;
    const service = await start(t, config, mode);
    const api = await request.newContext();
    t.after(() => api.dispose());
    await assert.rejects(api.post(`${service.url}/api/auth/login`));
    if (mode === "reset-once") assert.equal((await api.post(`${service.url}/api/auth/login`)).status(), 200);
    else await assert.rejects(api.post(`${service.url}/api/auth/login`));
    const events = await rows(config.directory);
    assert.equal(events.some((row) => row.event === "listener_close"), mode === "close");
    await close(service);
  }
});

test("observer preserves default fatal error and SIGTERM behavior", { timeout: 15000 }, async (t) => {
  for (const action of ["unhandled-error", "SIGTERM"]) {
    for (const observe of [false, true]) {
      const config = prepareTransportEvidence(await directory(t))!;
      const service = await start(t, config, "normal", observe);
      if (action === "SIGTERM") service.child.kill("SIGTERM");
      else service.child.send(action);
      const result = await service.exited;
      assert.deepEqual(result, action === "SIGTERM" ? { code: null, signal: "SIGTERM" } : { code: 1, signal: null });
      if (observe) {
        const events = await rows(config.directory);
        assert.equal(events.some((row) => row.event === "process_uncaught"), action === "unhandled-error");
        assert.equal(events.some((row) => row.event === "process_exit"), action === "unhandled-error",
          "default signal termination is unobserved, never fabricated as a normal exit");
      }
    }
  }
});

test("rotation is bounded; pinned first failure survives later failures and chatter", async (t) => {
  const config = prepareTransportEvidence(await directory(t))!;
  const emit = createEvidenceWriter(config, "server");
  emit("process_start");
  const sentinel = new Error("SECRET_PASSWORD");
  await assert.rejects(observeLogin(config, { retry: 0, workerIndex: 0, parallelIndex: 0 }, async () => { throw sentinel; }), (err) => err === sentinel);
  const pinned = await readFile(path.join(config.directory, "first-failure-client-0-server.jsonl"), "utf8");
  const marker = await readFile(path.join(config.directory, "first-failure-client-0.json"), "utf8");
  for (let i = 0; i < 5000; i++) emit("connection_open", { connectionId: i });
  await assert.rejects(observeLogin(config, { retry: 1, workerIndex: 1, parallelIndex: 0 }, async () => { throw sentinel; }));
  assert.equal(await readFile(path.join(config.directory, "first-failure-client-0-server.jsonl"), "utf8"), pinned);
  assert.equal(await readFile(path.join(config.directory, "first-failure-client-0.json"), "utf8"), marker);
  assert.equal((await readdir(config.directory)).filter((name) => name.startsWith("server.jsonl")).length, 2);
  for (const name of await readdir(config.directory)) assert.ok((await stat(path.join(config.directory, name))).size <= SEGMENT_BYTES);
});

test("missing server evidence and unwritable storage preserve errors without cause claims", async (t) => {
  const dir = await directory(t);
  const config = prepareTransportEvidence(path.join(dir, "logs"))!;
  const original = Object.defineProperty(new Error("SECRET_EXCEPTION"), "code", { get() { throw new Error("diagnostic accessor failed"); } });
  await assert.rejects(observeLogin(config, undefined, async () => { throw original; }), (error) => error === original);
  const marker = JSON.parse(await readFile(path.join(config.directory, "first-failure-client-setup.json"), "utf8"));
  assert.deepEqual(marker.serverSnapshots, []);
  assert.match(marker.interpretation, /missing events do not establish a cause/);
  const invalid = path.join(dir, "not-a-directory");
  await writeFile(invalid, "occupied");
  await assert.rejects(observeLogin({ ...config, directory: invalid }, undefined, async () => { throw original; }), (error) => error === original);
  assert.equal(await observeLogin(undefined, undefined, async (headers) => { assert.equal(headers, undefined); return 42; }), 42);
});

for (const recovered of [false, true]) {
  test(`real Playwright ${recovered ? "retry recovery" : "terminal failure"} retains first-attempt artifacts`, { timeout: 30000 }, async (t) => {
    const dir = await directory(t);
    const config = prepareTransportEvidence(path.join(dir, "playwright-report/transport"))!;
    const service = await start(t, config, recovered ? "reset-once" : "reset");
    const pw = path.join(root, "packages/web/node_modules/@playwright/test/index.mjs");
    const auth = path.join(root, "packages/web/tests/e2e/fixtures/auth.ts");
    await writeFile(path.join(dir, "login.spec.ts"), `import { test } from ${JSON.stringify(pw)};\nimport { loginViaApiWithCredentials } from ${JSON.stringify(auth)};\ntest('login transport', async ({request}) => { await loginViaApiWithCredentials(request, { urls: { api: ${JSON.stringify(service.url)} } } as never, {email: 'SECRET_EMAIL', password: 'SECRET_PASSWORD'}); });\n`);
    const report = path.join(dir, "test-results/results.json");
    await writeFile(path.join(dir, "playwright.config.ts"), `export default { testDir: '.', retries: ${recovered ? 1 : 0}, workers: 1, outputDir: './test-results', reporter: [['json', {outputFile: ${JSON.stringify(report)}}]] };`);
    const child = spawn(process.execPath, [path.join(root, "node_modules/playwright/cli.js"), "test", "--config", path.join(dir, "playwright.config.ts")], {
      cwd: dir, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SLOCK_E2E_TRANSPORT_DIR: config.directory, SLOCK_E2E_TRANSPORT_RUN_ID: config.runId },
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    const [code] = await once(child, "exit");
    assert.equal(code, recovered ? 0 : 1, output);
    const result = JSON.parse(await readFile(report, "utf8"));
    const testResult = result.suites[0].specs[0].tests[0];
    assert.equal(testResult.results[0].status, "failed");
    assert.match(testResult.results[0].error.message, /ECONNRESET|socket hang up/);
    if (recovered) assert.equal(testResult.results[1].status, "passed");
    const marker = JSON.parse(await readFile(path.join(config.directory, "first-failure-client-0.json"), "utf8"));
    assert.ok(marker.serverSnapshots.length > 0);
    assert.equal((await rows(config.directory, "client-0.jsonl"))[0].retry, 0);
    const classifier = spawn(process.execPath, [path.join(root, "scripts/ci/playwright-artifact-decision.mjs")], {
      env: { ...process.env, PLAYWRIGHT_STEP_OUTCOME: recovered ? "success" : "failure", PLAYWRIGHT_JSON_REPORT: report, GITHUB_OUTPUT: path.join(dir, "upload.txt") },
      stdio: "ignore",
    });
    assert.equal((await once(classifier, "exit"))[0], 0);
    assert.match(await readFile(path.join(dir, "upload.txt"), "utf8"), /should-upload=true/);
    const workflow = await readFile(path.join(root, ".github/workflows/test.yml"), "utf8");
    assert.match(workflow, /packages\/web\/playwright-report\//);
    assert.match(workflow, /retention-days: 7/);
    await close(service);
  });
}


test("actual Playwright API launcher and auth fixture emit correlated evidence", { timeout: 60000 }, async (t) => {
  const dir = await directory(t);
  const config = prepareTransportEvidence(path.join(dir, "transport"))!;
  const statePath = path.join(dir, "state.json");
  const child = fork(path.join(root, "packages/server/src/test/startPlaywrightServer.ts"), [], {
    cwd: path.join(root, "packages/server"), execArgv: ["--import", "tsx"], silent: true,
    env: { ...process.env, DATABASE_URL: "pglite://", SLOCK_TEST_SERVER_PORT: "0", SLOCK_TEST_STATE_PATH: statePath,
      SLOCK_E2E_TRANSPORT_DIR: config.directory, SLOCK_E2E_TRANSPORT_RUN_ID: config.runId },
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  child.stdout?.resume();
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exited; });
  let seed;
  for (let i = 0; i < 400; i++) {
    try { seed = JSON.parse(await readFile(statePath, "utf8")); break; } catch { /* startup incomplete */ }
    assert.equal(child.exitCode, null, stderr);
    await delay(100);
  }
  assert.ok(seed, "real API server must finish seeding");
  const previousDir = process.env.SLOCK_E2E_TRANSPORT_DIR;
  const previousRun = process.env.SLOCK_E2E_TRANSPORT_RUN_ID;
  process.env.SLOCK_E2E_TRANSPORT_DIR = config.directory;
  process.env.SLOCK_E2E_TRANSPORT_RUN_ID = config.runId;
  t.after(() => {
    if (previousDir === undefined) delete process.env.SLOCK_E2E_TRANSPORT_DIR;
    else process.env.SLOCK_E2E_TRANSPORT_DIR = previousDir;
    if (previousRun === undefined) delete process.env.SLOCK_E2E_TRANSPORT_RUN_ID;
    else process.env.SLOCK_E2E_TRANSPORT_RUN_ID = previousRun;
  });
  const api = await request.newContext();
  t.after(() => api.dispose());
  const result = await loginViaApiWithCredentials(api, seed, { email: seed.user.email, password: seed.user.password });
  assert.ok(result.accessToken);
  const client = await rows(config.directory, "client-setup.jsonl");
  const server = await rows(config.directory);
  assert.equal(client.at(-1).event, "login_success");
  assert.ok(server.some((row) => row.event === "login_finish" && row.requestId === client[0].requestId));
  const text = (await readdir(config.directory)).map((name) => readFile(path.join(config.directory, name), "utf8"));
  for (const body of await Promise.all(text)) {
    assert.ok(!body.includes(seed.user.password));
    assert.ok(!body.includes(result.accessToken));
  }
});

test("actual shard runner passes collection identity and preserves child failure", { timeout: 15000 }, async (t) => {
  const dir = await directory(t);
  const web = path.join(dir, "packages/web");
  const runner = path.join(web, "scripts/runE2eShard.ts");
  await mkdir(path.dirname(runner), { recursive: true });
  await mkdir(path.join(dir, "scripts/e2e"), { recursive: true });
  await copyFile(path.join(root, "packages/web/scripts/runE2eShard.ts"), runner);
  await copyFile(path.join(root, "scripts/e2e/transportEvidence.ts"), path.join(dir, "scripts/e2e/transportEvidence.ts"));
  await mkdir(path.join(web, "tests/e2e/tests"), { recursive: true });
  await writeFile(path.join(web, "tests/e2e/tests/probe.spec.ts"), "// stub command does not execute tests\n");
  await writeFile(path.join(web, "e2e-shard-manifest.json"), JSON.stringify({
    shardCount: 1, shards: [{ shard: 1, expectedDurationMs: 1, files: ["tests/e2e/tests/probe.spec.ts"] }],
  }));
  const artifacts = path.join(web, "playwright-report/transport");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "stale.json"), "old run");
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "pnpm"), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.SLOCK_E2E_TRANSPORT_DIR + '/probe.json', JSON.stringify({runId: process.env.SLOCK_E2E_TRANSPORT_RUN_ID}));\nprocess.exit(7);\n`, { mode: 0o755 });
  const child = spawn(process.execPath, ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), runner, "1"], {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  assert.equal((await once(child, "exit"))[0], 7, output);
  const probe = JSON.parse(await readFile(path.join(artifacts, "probe.json"), "utf8"));
  assert.match(probe.runId, /^[a-f0-9-]{36}$/);
  assert.ok(output.includes(`runId=${probe.runId}`));
  await assert.rejects(stat(path.join(artifacts, "stale.json")), { code: "ENOENT" });
});
