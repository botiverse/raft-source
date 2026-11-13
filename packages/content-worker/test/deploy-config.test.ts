import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  REQUIRED_SECRETS,
  deployEnvOf,
  renderDeployConfig,
  selectVersionId,
  verifySecretList,
  verifyVersion,
} from "../scripts/deploy-config";

// scripts/deploy-config.ts: what .github/workflows/deploy-content-worker.yml deploys with. Example
// values only: a deployment's real names live in its deploy, never in this package.
const BASE = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const VALUES = {
  CONTENT_WORKER_NAME: "content-example",
  CONTENT_WORKER_R2_BUCKET: "objects-example",
  CONTENT_WORKER_R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  CONTENT_WORKER_D1_DATABASE_NAME: "tickets-example",
  CONTENT_WORKER_D1_DATABASE_ID: "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b",
  CONTENT_WORKER_CONTENT_DOMAIN: "content.example",
  CONTENT_WORKER_APP_ORIGIN: "https://app.example.com",
  CONTENT_WORKER_RAFT_API_URL: "https://api.example.com",
};
const MESSAGE = `source_sha=${"a".repeat(40)};github_run=1:1`;
const VERSION_ID = "0f6f4a4e-5d1c-4f43-9a27-6a3a1b9c2d10";

test("render adds one environment with the deploy's names and keeps the committed config as it is", () => {
  const rendered = renderDeployConfig(BASE, "staging", VALUES);
  const env = deployEnvOf(rendered, "staging");
  assert.equal(env.name, "content-example");
  assert.equal("r2_buckets" in env || "r2_buckets" in rendered, false, "no R2 binding: the Worker reads R2 with a read-only token");
  assert.deepEqual(env.d1_databases, [
    { binding: "TICKETS", database_name: "tickets-example", database_id: VALUES.CONTENT_WORKER_D1_DATABASE_ID, migrations_dir: "migrations" },
  ]);
  assert.deepEqual(env.vars, {
    APP_ORIGIN: "https://app.example.com",
    CONTENT_DOMAIN: "content.example",
    EMBEDS: "",
    EMBED_DOMAIN: "",
    EXTRA_APP_ORIGINS: "",
    FRAMED_BY_ORIGINS: "",
    R2_BUCKET: "objects-example",
    R2_ENDPOINT: VALUES.CONTENT_WORKER_R2_ENDPOINT,
    RAFT_API_URL: "https://api.example.com",
  });
  assert.equal("routes" in rendered || "routes" in env, false, "routes are never declared");
  assert.equal(rendered.workers_dev, true);
  assert.equal(rendered.preview_urls, false);
  assert.throws(() => deployEnvOf(rendered, "production"), /exactly the environment production/);
});

test("render refuses a missing or malformed value, the placeholder id, and a content domain over the app", () => {
  const without = (name: keyof typeof VALUES) => ({ ...VALUES, [name]: "" });
  for (const name of Object.keys(VALUES) as (keyof typeof VALUES)[])
    assert.throws(() => renderDeployConfig(BASE, "staging", without(name)), new RegExp(`missing ${name}`));
  const bad: Partial<typeof VALUES>[] = [
    { CONTENT_WORKER_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000000" },
    { CONTENT_WORKER_D1_DATABASE_ID: "not-a-uuid" },
    { CONTENT_WORKER_CONTENT_DOMAIN: "https://content.example" },
    { CONTENT_WORKER_CONTENT_DOMAIN: "content.example:8443" },
    { CONTENT_WORKER_APP_ORIGIN: "http://app.example.com" },
    { CONTENT_WORKER_APP_ORIGIN: "https://app.example.com/" },
    { CONTENT_WORKER_RAFT_API_URL: "https://api.example.com/" },
    { CONTENT_WORKER_RAFT_API_URL: "https://api.example.com?x=1" },
    { CONTENT_WORKER_APP_ORIGIN: "https://app.content.example" },
    { CONTENT_WORKER_CONTENT_DOMAIN: "example.com" },
    { CONTENT_WORKER_R2_BUCKET: "Objects_Example" },
    { CONTENT_WORKER_R2_ENDPOINT: "http://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com" },
    { CONTENT_WORKER_R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/" },
    { CONTENT_WORKER_R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/objects-example" },
    { CONTENT_WORKER_R2_ENDPOINT: "https://objects.example.com" },
    { CONTENT_WORKER_R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com.example.com" },
  ];
  // A jurisdiction's endpoint is one.
  renderDeployConfig(BASE, "staging", { ...VALUES, CONTENT_WORKER_R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com" });
  for (const each of bad) assert.throws(() => renderDeployConfig(BASE, "staging", { ...VALUES, ...each }), Error, JSON.stringify(each));
});

test("render takes EXTRA_APP_ORIGINS as the Worker does: https origins or app://raft, nothing else", () => {
  const extra = (value: string) =>
    deployEnvOf(renderDeployConfig(BASE, "staging", { ...VALUES, CONTENT_WORKER_EXTRA_APP_ORIGINS: value }), "staging").vars.EXTRA_APP_ORIGINS;
  assert.equal(extra("app://raft"), "app://raft");
  assert.equal(extra(" app://raft , https://desk.example.com,app://raft"), "app://raft,https://desk.example.com", "trimmed, without repeats");
  assert.equal(extra(""), "");
  for (const bad of ["http://x", "*", "app://evil", "app://raft/", "https://desk.example.com/", "https://*.example.com", "null", "file://", "https://desk.content.example"])
    assert.throws(() => extra(bad), Error, bad);
});

test("render takes FRAMED_BY_ORIGINS as the Worker does: https origins, none an app origin, apart from the content domain", () => {
  const framedBy = (value: string, extra = "app://raft") =>
    deployEnvOf(
      renderDeployConfig(BASE, "staging", { ...VALUES, CONTENT_WORKER_EXTRA_APP_ORIGINS: extra, CONTENT_WORKER_FRAMED_BY_ORIGINS: value }),
      "staging",
    ).vars.FRAMED_BY_ORIGINS;
  assert.equal(framedBy("https://deck.example.com"), "https://deck.example.com");
  assert.equal(framedBy(" https://deck.example.com, https://deck-dev.example.com https://deck.example.com"), "https://deck.example.com,https://deck-dev.example.com");
  assert.equal(framedBy(""), "");
  for (const bad of ["app://raft", "http://deck.example.com", "*", "https://*.example.com", "https://deck.example.com/", "https://app.example.com", "https://deck.content.example"])
    assert.throws(() => framedBy(bad), Error, bad);
  assert.throws(() => framedBy("https://desk.example.com", "https://desk.example.com"), /app origin already/);
});

test("render takes the embed settings together: on only with an embed host on the content domain's site, outside it and off the app's", () => {
  const embedVars = (embeds: string, domain: string) => {
    const vars = deployEnvOf(
      renderDeployConfig(BASE, "staging", { ...VALUES, CONTENT_WORKER_CONTENT_DOMAIN: "w.content.example", CONTENT_WORKER_EMBEDS: embeds, CONTENT_WORKER_EMBED_DOMAIN: domain }),
      "staging",
    ).vars;
    return [vars.EMBEDS, vars.EMBED_DOMAIN];
  };
  assert.deepEqual(embedVars("1", "embed.content.example"), ["1", "embed.content.example"]);
  assert.deepEqual(embedVars(" TRUE ", "embed.content.example"), ["true", "embed.content.example"]);
  assert.deepEqual(embedVars("", ""), ["", ""], "off: neither set");
  assert.deepEqual(embedVars("0", "embed.content.example"), ["0", "embed.content.example"], "the kill switch off, the host kept");
  assert.throws(() => embedVars("1", ""), /EMBEDS is on without/);
  assert.throws(() => embedVars("yes", "embed.content.example"), /CONTENT_WORKER_EMBEDS is not/);
  for (const bad of ["w.content.example", "x.w.content.example", "content.example", "embed.other.example", "https://embed.content.example", "embed.content.example:8443", "Embed.content.example"])
    assert.throws(() => embedVars("1", bad), Error, bad);
  assert.throws(
    () => renderDeployConfig(BASE, "staging", { ...VALUES, CONTENT_WORKER_CONTENT_DOMAIN: "w.example.com", CONTENT_WORKER_EMBEDS: "1", CONTENT_WORKER_EMBED_DOMAIN: "embed.example.com" }),
    /on APP_ORIGIN's site/,
  );
});

test("render refuses a committed config with routes, an environment, or a var the deploy doesn't set", () => {
  const edited = (from: string, to: string) => {
    assert.ok(BASE.includes(from), from);
    return BASE.replace(from, to);
  };
  assert.throws(() => renderDeployConfig(edited('"main":', '"routes": [], "main":'), "staging", VALUES), /must not declare "routes"/);
  assert.throws(() => renderDeployConfig(edited('"main":', '"env": {}, "main":'), "staging", VALUES), /must not declare "env"/);
  assert.throws(() => renderDeployConfig(edited('"workers_dev": true', '"workers_dev": false'), "staging", VALUES), /workers_dev/);
  assert.throws(() => renderDeployConfig(edited('"CONTENT_DOMAIN": ""', '"CONTENT_DOMAIN": "", "NEW": ""'), "staging", VALUES), /vars must be exactly/);
  assert.throws(() => renderDeployConfig(edited('"R2_ENDPOINT": "",', ""), "staging", VALUES), /vars must be exactly/);
  // An R2 binding could write: the committed config must not bring one back.
  assert.throws(
    () => renderDeployConfig(edited('"main":', '"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "set-at-deploy" }], "main":'), "staging", VALUES),
    /must not bind an R2 bucket/,
  );
});

test("the secret list must name exactly the Worker's secrets, and says which are missing", () => {
  const list = (names: string[]) => JSON.stringify(names.map((name) => ({ name, type: "secret_text" })));
  verifySecretList(list([...REQUIRED_SECRETS]));
  assert.throws(() => verifySecretList(list(["PORTHOLE_SECRET"])), /missing: RAFT_API_TOKEN, RAFT_TOKENS, R2_READ_ACCESS_KEY_ID, R2_READ_SECRET_ACCESS_KEY/);
  assert.throws(() => verifySecretList(list(REQUIRED_SECRETS.filter((name) => name !== "R2_READ_SECRET_ACCESS_KEY"))), /missing: R2_READ_SECRET_ACCESS_KEY$/);
  assert.throws(() => verifySecretList(list([...REQUIRED_SECRETS, "EXTRA"])), /unexpected: EXTRA/);
  assert.throws(() => verifySecretList("[]"), /missing: PORTHOLE_SECRET, RAFT_API_TOKEN, RAFT_TOKENS, R2_READ_ACCESS_KEY_ID, R2_READ_SECRET_ACCESS_KEY/);
});

test("the readback selects the run's deployment and requires exactly the rendered bindings", () => {
  const deployments = [
    { annotations: { "workers/message": "older" }, versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }] },
    { annotations: { "workers/message": MESSAGE }, versions: [{ version_id: VERSION_ID, percentage: 100 }] },
  ];
  assert.equal(selectVersionId(JSON.stringify(deployments), MESSAGE), VERSION_ID);
  assert.throws(() => selectVersionId(JSON.stringify([...deployments, deployments[1]]), MESSAGE), /at most one deployment/);
  assert.throws(() => selectVersionId("[]", MESSAGE), /no deployments/);
  // What `wrangler deploy --message` leaves: the message is on the version, the deployment only says it came from an upload.
  const uploads = [
    { created_on: "2026-10-27T14:00:00Z", annotations: { "workers/triggered_by": "upload" }, versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }] },
    { created_on: "2026-10-27T14:31:26Z", annotations: { "workers/triggered_by": "upload" }, versions: [{ version_id: VERSION_ID, percentage: 100 }] },
  ];
  assert.equal(selectVersionId(JSON.stringify(uploads), MESSAGE), VERSION_ID, "the newest deployment");
  assert.equal(selectVersionId(JSON.stringify([...uploads].reverse()), MESSAGE), VERSION_ID, "whatever order wrangler lists them in");

  const env = deployEnvOf(renderDeployConfig(BASE, "production", VALUES), "production");
  const bindings = [
    { name: "TICKETS", type: "d1", id: VALUES.CONTENT_WORKER_D1_DATABASE_ID },
    { name: "APP_ORIGIN", type: "plain_text", text: "https://app.example.com" },
    { name: "CONTENT_DOMAIN", type: "plain_text", text: "content.example" },
    { name: "EMBEDS", type: "plain_text", text: "" },
    { name: "EMBED_DOMAIN", type: "plain_text", text: "" },
    { name: "EXTRA_APP_ORIGINS", type: "plain_text", text: "" },
    { name: "FRAMED_BY_ORIGINS", type: "plain_text", text: "" },
    { name: "R2_BUCKET", type: "plain_text", text: "objects-example" },
    { name: "R2_ENDPOINT", type: "plain_text", text: VALUES.CONTENT_WORKER_R2_ENDPOINT },
    { name: "RAFT_API_URL", type: "plain_text", text: "https://api.example.com" },
  ];
  const secrets = REQUIRED_SECRETS.map((name) => ({ name, type: "secret_text" }));
  const version = (list: object[]) =>
    JSON.stringify({ id: VERSION_ID, annotations: { "workers/message": MESSAGE }, resources: { bindings: list } });
  const expected = { env, versionId: VERSION_ID, message: MESSAGE, secrets: true };
  verifyVersion(version([...bindings, ...secrets]), expected);
  verifyVersion(version(bindings), { ...expected, secrets: false });
  assert.throws(() => verifyVersion(version(bindings), expected), /secret names mismatch/);
  assert.throws(() => verifyVersion(version([...bindings, ...secrets]), { ...expected, secrets: false }), /secret names mismatch/);
  assert.throws(() => verifyVersion(version([...bindings, ...secrets, { name: "X", type: "plain_text", text: "" }]), expected), /binding set mismatch/);
  // No R2 binding, under any name: the Worker reads R2 with a read-only token.
  assert.throws(
    () => verifyVersion(version([...bindings, { name: "BLOBS", type: "r2_bucket", bucket_name: "objects-example" }, ...secrets]), expected),
    /binding set mismatch/,
  );
  assert.throws(
    () => verifyVersion(version([...bindings.filter((each) => each.name !== "R2_BUCKET"), { name: "R2_BUCKET", type: "r2_bucket", bucket_name: "objects-example" }, ...secrets]), expected),
    /expected one plain_text binding named R2_BUCKET/,
  );
  for (const name of ["R2_BUCKET", "R2_ENDPOINT"])
    assert.throws(
      () => verifyVersion(version([...bindings.map((each) => (each.name === name ? { ...each, text: "other" } : each)), ...secrets]), expected),
      new RegExp(`${name} readback mismatch`),
    );
  assert.throws(
    () => verifyVersion(version([{ ...bindings[0]!, id: VERSION_ID }, ...bindings.slice(1), ...secrets]), expected),
    /D1 database readback mismatch/,
  );
  assert.throws(() => verifyVersion(version([...bindings, ...secrets]), { ...expected, message: "other" }), /message readback mismatch/);
});
