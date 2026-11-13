import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { describeEnv, parseJsonc, REQUIRED_SECRETS, selectVersionId, verifySecretList, verifyVersion } from "../scripts/deploy-config";

// scripts/deploy-config.ts: what .github/workflows/deploy-check-worker.yml deploys with.
const BASE = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const MESSAGE = `source_sha=${"a".repeat(40)};github_run=1:1`;
const VERSION_ID = "0f6f4a4e-5d1c-4f43-9a27-6a3a1b9c2d10";

type Section = Record<string, unknown> & { vars: Record<string, string> };
type Config = Section & { env: Record<string, Section> };
const edited = (edit: (config: Config, staging: Section) => void) => {
  const config = parseJsonc(BASE, "wrangler.jsonc") as Config;
  edit(config, config.env.staging!);
  return JSON.stringify(config);
};

test("the committed config: two environments with their names and Raft's API origins, a cron each, the browser bound", () => {
  assert.deepEqual(describeEnv(BASE, "staging"), { name: "raft-artifact-check-staging", apiOrigin: "https://api-aws-staging.botiverse.dev", crons: ["* * * * *"], browserPool: "off" });
  assert.deepEqual(describeEnv(BASE, "production"), { name: "raft-artifact-check", apiOrigin: "https://api.raft.build", crons: ["* * * * *"], browserPool: "on" });
  assert.throws(() => describeEnv(BASE, "dev"), /one of staging, production/);
  const top = parseJsonc(BASE, "wrangler.jsonc");
  assert.equal((top.vars as Record<string, string>).RAFT_API_ORIGIN, "", "the top level is no deployment");
  assert.equal((top.vars as Record<string, string>).CHECK_BROWSER_POOL, "off", "nor pools");
  assert.equal("routes" in top, false);
});

test("describe refuses a config the deploy doesn't know", () => {
  const cases: Array<[(config: Config, staging: Section) => void, RegExp]> = [
    [(config) => (config.workers_dev = true), /workers_dev/],
    [(config) => (config.preview_urls = true), /preview_urls/],
    [(config) => (config.compatibility_flags = []), /nodejs_compat/],
    [(config) => (config.vars.RAFT_API_ORIGIN = "https://api.raft.build"), /top-level RAFT_API_ORIGIN/],
    [(_, staging) => (staging.vars.RAFT_API_ORIGIN = "http://api.example.com"), /not an https origin/],
    [(_, staging) => (staging.vars.EXTRA = "x"), /vars must be exactly CHECK_BROWSER_POOL, RAFT_API_ORIGIN/],
    [(_, staging) => delete staging.vars.CHECK_BROWSER_POOL, /vars must be exactly CHECK_BROWSER_POOL, RAFT_API_ORIGIN/],
    [(_, staging) => (staging.vars.CHECK_BROWSER_POOL = "yes"), /CHECK_BROWSER_POOL must be "on" or "off"/],
    // Staging never pools: at most one environment of a Cloudflare account does, and that is production.
    [(_, staging) => (staging.vars.CHECK_BROWSER_POOL = "on"), /env.staging CHECK_BROWSER_POOL must be off/],
    [(config) => (config.vars.CHECK_BROWSER_POOL = "on"), /top-level CHECK_BROWSER_POOL must stay off/],
    [(_, staging) => delete staging.browser, /bind the browser as BROWSER/],
    [(_, staging) => (staging.triggers = { crons: [] }), /exactly one cron trigger/],
    [(_, staging) => (staging.routes = ["x.example/*"]), /declares routes/],
    [(_, staging) => (staging.r2_buckets = []), /declares r2_buckets/],
    [(config) => (config.env.preview = { vars: {} }), /exactly the environments/],
    [(_, staging) => (staging.name = "Bad Name"), /not a Worker name/],
  ];
  for (const [edit, error] of cases) assert.throws(() => describeEnv(edited(edit), "staging"), error);
});

test("secrets: exactly the token", () => {
  verifySecretList(JSON.stringify(REQUIRED_SECRETS.map((name) => ({ name, type: "secret_text" }))));
  assert.throws(() => verifySecretList("[]"), /exactly ARTIFACTS_CHECK_WORKER_TOKEN; found none/);
  assert.throws(() => verifySecretList(JSON.stringify([{ name: "ARTIFACTS_CHECK_WORKER_TOKEN", type: "secret_text" }, { name: "OTHER", type: "secret_text" }])), /found ARTIFACTS_CHECK_WORKER_TOKEN, OTHER/);
  assert.throws(() => verifySecretList("{"), /not valid JSON/);
});

test("select-version: the deployment naming the message, else the newest; one version at 100%", () => {
  const deployment = (id: string, created: string, message?: string) => ({ created_on: created, annotations: message ? { "workers/message": message } : {}, versions: [{ version_id: id, percentage: 100 }] });
  const other = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b";
  assert.equal(selectVersionId(JSON.stringify([deployment(other, "2026-11-04T10:00:00Z"), deployment(VERSION_ID, "2026-11-04T09:00:00Z", MESSAGE)]), MESSAGE), VERSION_ID);
  assert.equal(selectVersionId(JSON.stringify([deployment(other, "2026-11-04T08:00:00Z"), deployment(VERSION_ID, "2026-11-04T09:00:00Z")]), MESSAGE), VERSION_ID);
  assert.throws(() => selectVersionId("[]", MESSAGE), /no deployments/);
});

test("verify-version: the message, the browser binding, RAFT_API_ORIGIN's value and the token's name", () => {
  const env = describeEnv(BASE, "staging");
  const version = (bindings: unknown[]) => JSON.stringify({ id: VERSION_ID, annotations: { "workers/message": MESSAGE }, resources: { bindings } });
  const good = [
    { name: "BROWSER", type: "browser" },
    { name: "RAFT_API_ORIGIN", type: "plain_text", text: env.apiOrigin },
    { name: "CHECK_BROWSER_POOL", type: "plain_text", text: "off" },
    { name: "ARTIFACTS_CHECK_WORKER_TOKEN", type: "secret_text" },
  ];
  verifyVersion(version(good), { env, versionId: VERSION_ID, message: MESSAGE, secrets: true });
  verifyVersion(version(good.slice(0, 3)), { env, versionId: VERSION_ID, message: MESSAGE, secrets: false });
  assert.throws(() => verifyVersion(version(good.slice(0, 3)), { env, versionId: VERSION_ID, message: MESSAGE, secrets: true }), /secret names mismatch/);
  assert.throws(() => verifyVersion(version([good[0], { ...good[1], text: "https://api.raft.build" }, good[2], good[3]]), { env, versionId: VERSION_ID, message: MESSAGE, secrets: true }), /RAFT_API_ORIGIN readback mismatch/);
  // A staging version that pools (the deployed value, not the config's) is refused.
  assert.throws(() => verifyVersion(version([good[0], good[1], { ...good[2], text: "on" }, good[3]]), { env, versionId: VERSION_ID, message: MESSAGE, secrets: true }), /CHECK_BROWSER_POOL readback mismatch/);
  assert.throws(() => verifyVersion(version([good[0], good[1], good[3]]), { env, versionId: VERSION_ID, message: MESSAGE, secrets: true }), /binding set mismatch/);
  const production = describeEnv(BASE, "production");
  verifyVersion(version([good[0], { ...good[1], text: production.apiOrigin }, { ...good[2], text: "on" }, good[3]]), { env: production, versionId: VERSION_ID, message: MESSAGE, secrets: true });
  assert.throws(() => verifyVersion(version([...good, { name: "BUCKET", type: "r2_bucket" }]), { env, versionId: VERSION_ID, message: MESSAGE, secrets: true }), /binding set mismatch/);
  assert.throws(() => verifyVersion(version([{ name: "BROWSER", type: "service" }, good[1], good[2], good[3]]), { env, versionId: VERSION_ID, message: MESSAGE, secrets: true }), /one browser binding/);
  assert.throws(() => verifyVersion(version(good), { env, versionId: VERSION_ID, message: "other", secrets: true }), /message readback mismatch/);
});
