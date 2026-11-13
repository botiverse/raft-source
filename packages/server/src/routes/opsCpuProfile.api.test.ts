import assert from "node:assert/strict";
import type { CpuProfile } from "../lib/cpuProfileCapture";
import type { StorageBackend } from "../services/storageService";
import { createApiTest } from "../test/integration/apiTest";

const TOKEN = "t".repeat(40);
const BUCKET = "raft-ops-test";
const INSTANCE_ID = "ecs:0123abcd";
const STARTED_AT = new Date("2026-10-26T08:09:10.123Z");
const PROFILE: CpuProfile = {
  nodes: [{ id: 1, callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 } }],
  startTime: 0,
  endTime: 1_000,
  samples: [1, 1, 1],
  timeDeltas: [1, 1, 1],
};

const env: NodeJS.ProcessEnv = {};
const puts: Array<{ key: string; data: Buffer; contentType: string }> = [];
let storage: StorageBackend | null = null;
let capture: (durationMs: number) => Promise<CpuProfile> = async () => PROFILE;

function fakeStorage(put: StorageBackend["put"] = async (key, data, contentType) => {
  puts.push({ key, data, contentType });
}): StorageBackend {
  return {
    put,
    get: async () => { throw new Error("unused"); },
    delete: async () => { throw new Error("unused"); },
  };
}

const test = createApiTest({
  opsCpuProfile: {
    env,
    getStorage: () => storage,
    capture: durationMs => capture(durationMs),
    serviceInstanceId: INSTANCE_ID,
    now: () => STARTED_AT,
  },
});

function enable(): void {
  Object.assign(env, { CPU_PROFILE_ENABLED: "true", OPS_PROFILE_TOKEN: TOKEN, S3_OPS_PROFILE_BUCKET: BUCKET, DEPLOYMENT_ENV: "production" });
  storage = fakeStorage();
}

function reset(): void {
  for (const key of Object.keys(env)) delete env[key];
  puts.length = 0;
  storage = null;
  capture = async () => PROFILE;
}

function post(baseUrl: string, body?: unknown, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}/api/ops/cpu-profile`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function assertHidden(response: Response): Promise<void> {
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found", code: "not_found", path: "/api/ops/cpu-profile" });
}

test("hidden (app JSON 404) unless flag, token, bucket and storage are all configured", async ({ app }) => {
  reset();
  let captures = 0;
  capture = async () => { captures += 1; return PROFILE; };
  await assertHidden(await post(app.baseUrl, {}));

  enable();
  for (const missing of ["CPU_PROFILE_ENABLED", "OPS_PROFILE_TOKEN", "S3_OPS_PROFILE_BUCKET"] as const) {
    const saved = env[missing];
    delete env[missing];
    await assertHidden(await post(app.baseUrl, {}));
    env[missing] = saved;
  }
  env.OPS_PROFILE_TOKEN = "short";
  await assertHidden(await post(app.baseUrl, {}, "short"));
  env.OPS_PROFILE_TOKEN = TOKEN;
  storage = null;
  await assertHidden(await post(app.baseUrl, {}));
  assert.equal(captures, 0);
  reset();
});

test("a missing, wrong or non-Bearer token gets the same 404 as an unmounted path", async ({ app }) => {
  reset();
  enable();
  await assertHidden(await post(app.baseUrl, {}, null));
  await assertHidden(await post(app.baseUrl, {}, `${TOKEN}x`));
  await assertHidden(await post(app.baseUrl, {}, TOKEN.slice(1)));
  const basic = await fetch(`${app.baseUrl}/api/ops/cpu-profile`, {
    method: "POST",
    headers: { authorization: `Basic ${TOKEN}` },
  });
  await assertHidden(basic);
  assert.equal(puts.length, 0);
  reset();
});

test("invalid durations and unknown fields are 400 before any capture", async ({ app }) => {
  reset();
  enable();
  let captures = 0;
  capture = async () => { captures += 1; return PROFILE; };
  for (const body of [{ durationSeconds: 0 }, { durationSeconds: 61 }, { durationSeconds: 1.5 }, { durationSeconds: "30" }, { durationSeconds: 5, intervalUs: 100 }, [5]]) {
    const response = await post(app.baseUrl, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json() as { code: string }).code, "invalid_cpu_profile_request");
  }
  assert.equal(captures, 0);
  reset();
});

test("captures, uploads the .cpuprofile and returns only metadata", async ({ app }) => {
  reset();
  enable();
  const durations: number[] = [];
  capture = async durationMs => { durations.push(durationMs); return PROFILE; };

  const response = await post(app.baseUrl, { durationSeconds: 2 });
  assert.equal(response.status, 200);
  const expectedKey = "ops/cpu-profiles/production/ecs_0123abcd/2026-10-26T08-09-10.123Z.cpuprofile";
  const bytes = Buffer.byteLength(JSON.stringify(PROFILE));
  assert.deepEqual(await response.json(), {
    bucket: BUCKET,
    key: expectedKey,
    instanceId: INSTANCE_ID,
    durationSeconds: 2,
    sampleCount: 3,
    bytes,
  });
  assert.deepEqual(durations, [2_000]);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, expectedKey);
  assert.equal(puts[0].contentType, "application/json");
  assert.deepEqual(JSON.parse(puts[0].data.toString("utf8")), PROFILE);

  // No body: the default duration.
  const defaulted = await post(app.baseUrl);
  assert.equal(defaulted.status, 200);
  assert.deepEqual(durations, [2_000, 30_000]);
  reset();
});

test("a second capture while one runs is 409; the slot frees afterwards, also after failures", async ({ app }) => {
  reset();
  enable();
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  capture = () => new Promise(resolve => {
    release = () => resolve(PROFILE);
    started();
  });

  const first = post(app.baseUrl, { durationSeconds: 1 });
  await running;
  const second = await post(app.baseUrl, { durationSeconds: 1 });
  assert.equal(second.status, 409);
  assert.equal((await second.json() as { code: string }).code, "cpu_profile_busy");
  release();
  assert.equal((await first).status, 200);

  capture = async () => { throw new Error("inspector unavailable"); };
  const failedCapture = await post(app.baseUrl, { durationSeconds: 1 });
  assert.equal(failedCapture.status, 500);
  assert.equal((await failedCapture.json() as { code: string }).code, "cpu_profile_capture_failed");

  capture = async () => PROFILE;
  storage = fakeStorage(async () => { throw new Error("s3 down"); });
  const failedUpload = await post(app.baseUrl, { durationSeconds: 1 });
  assert.equal(failedUpload.status, 502);
  assert.equal((await failedUpload.json() as { code: string }).code, "cpu_profile_upload_failed");

  storage = fakeStorage();
  assert.equal((await post(app.baseUrl, { durationSeconds: 1 })).status, 200);
  reset();
});
