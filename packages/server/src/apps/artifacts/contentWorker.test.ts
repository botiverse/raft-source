// The `server.artifacts.frame.issue` span's status for each way a frame goes
// (trace.ts): ok for a frame signed, and for no content origin configured in
// local development; a deployment without one, or a signature that failed,
// is an error. The content origin a frame is signed for. And the startup
// check that the content domain stays apart from Raft's own app hosts.
import assert from "node:assert/strict";
import { asServerId } from "@botiverse/raft-shared";
import {
  anonymousContentSubject,
  assertContentDomainApartFromAppHosts,
  checkContentSubject,
  checkContentWorkerConfig,
  contentDomainAppHostOverlap,
  contentOriginOf,
  contentSubject,
  frameIssueStatus,
  isDeployedEnvironment,
  parseAnonymousContentSubject,
  parseCheckContentSubject,
  parseContentSubject,
  type IssuedFrame,
} from "./contentWorker";

type Outcome = IssuedFrame["outcome"];
const cases: Array<[outcome: Outcome, local: "ok" | "error", deployed: "ok" | "error"]> = [
  ["issued", "ok", "ok"],
  ["not_configured", "ok", "error"],
  // Signing threw: our bug.
  ["failed", "error", "error"],
];

test.each(cases)("frame.issue span status: %s is %s locally, %s deployed", (outcome, local, deployed) => {
  assert.equal(frameIssueStatus({ outcome }, false), local);
  assert.equal(frameIssueStatus({ outcome }, true), deployed);
});

test("every outcome is in the table", () => {
  const outcomes: Record<Outcome, true> = { issued: true, not_configured: true, failed: true };
  assert.deepEqual(cases.map(([outcome]) => outcome).sort(), Object.keys(outcomes).sort());
});

test("a frame's origin: the Artifact's own w-<uuid> label, https; http only on a localhost content domain", () => {
  const artifact = "pt_0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a";
  assert.equal(contentOriginOf(artifact, "w.raftusercontent.com"), "https://w-0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a.w.raftusercontent.com");
  assert.equal(contentOriginOf(artifact, "content.localhost:8791"), "http://w-0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a.content.localhost:8791");
  assert.equal(contentOriginOf(artifact, "localhost:8791"), "http://w-0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a.localhost:8791");
  assert.equal(contentOriginOf(artifact, "notlocalhost.example"), "https://w-0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a.notlocalhost.example");
  for (const bad of ["pt_not-a-uuid", "0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a", "PT_0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a"]) assert.equal(contentOriginOf(bad, "w.raftusercontent.com"), null, bad);
});

test("deployed: the deployments Terraform names in DEPLOYMENT_ENV; anything else is local development", () => {
  for (const name of ["production", "staging", "release-qa", " staging "]) assert.equal(isDeployedEnvironment({ DEPLOYMENT_ENV: name }), true, name);
  for (const name of [undefined, "", "slockdev", "ci", "Production"]) assert.equal(isDeployedEnvironment({ DEPLOYMENT_ENV: name }), false, String(name));
});

describe("the content domain is not on the same site as Raft's app hosts (startup)", () => {
  const hosts = ["app.raft.build", "localhost", "app.slock.ai", "staging.example.dev"];
  const refuses = (domain: string, appHost: string, why: string) => {
    assert.deepEqual(contentDomainAppHostOverlap(domain, hosts), { contentDomain: domain.toLowerCase().replace(/:[0-9]+$/, "").replace(/\.+$/, ""), appHost }, why);
    assert.throws(
      () => assertContentDomainApartFromAppHosts({ ARTIFACTS_CONTENT_DOMAIN: domain }, hosts),
      (error: Error) => error.message.includes(`ARTIFACTS_CONTENT_DOMAIN ${domain.toLowerCase().replace(/:[0-9]+$/, "").replace(/\.+$/, "")} `) && error.message.includes(`app host ${appHost} `),
      why,
    );
  };

  test("the same host as an app host is refused", () => {
    refuses("app.raft.build", "app.raft.build", "exact");
    refuses("APP.Raft.Build", "app.raft.build", "case-insensitive");
    refuses("app.raft.build.", "app.raft.build", "trailing dot on the content domain");
    refuses("app.raft.build:8443", "app.raft.build", "a port is not part of the hostname");
  });

  test("a content domain under an app host is refused", () => {
    refuses("content.app.raft.build", "app.raft.build", "subdomain of the canonical host");
    refuses("usercontent.staging.example.dev", "staging.example.dev", "subdomain of an APP_PERMALINK_HOSTS host");
  });

  test("a content domain above an app host is refused", () => {
    refuses("raft.build", "app.raft.build", "parent of the canonical host");
    refuses("slock.ai", "app.slock.ai", "parent of an earlier host");
    refuses("example.dev", "staging.example.dev", "parent of an APP_PERMALINK_HOSTS host");
  });

  test("a sibling of an app host (same registered domain) is refused", () => {
    refuses("w.raft.build", "app.raft.build", "sibling of the canonical host");
    refuses("usercontent.slock.ai", "app.slock.ai", "sibling of an earlier host");
  });

  test("an app host written with a trailing dot or in capitals still counts", () => {
    assert.deepEqual(contentDomainAppHostOverlap("raftusercontent.app.example", ["App.Example."]), { contentDomain: "raftusercontent.app.example", appHost: "app.example" });
  });

  test("unrelated hosts pass", () => {
    for (const domain of ["raftusercontent.com", "w.raftusercontent.com", "w-staging.raftusercontent.com", "content.localhost:8791", "raftusercontent-preview.example", "content.example.test", "notraft.build", "app.raft.builder", "raft.build.evil.test", "w-app.raft.build-content.test"]) {
      assert.equal(contentDomainAppHostOverlap(domain, hosts), null, domain);
      assert.doesNotThrow(() => assertContentDomainApartFromAppHosts({ ARTIFACTS_CONTENT_DOMAIN: domain }, hosts), domain);
    }
  });

  test("no content domain passes", () => {
    for (const domain of [undefined, "", "   "]) {
      assert.equal(contentDomainAppHostOverlap(domain, hosts), null, String(domain));
      assert.doesNotThrow(() => assertContentDomainApartFromAppHosts({ ARTIFACTS_CONTENT_DOMAIN: domain }, hosts));
    }
  });

  test("the startup check refuses with Raft's own app hosts (the canonical host, APP_URL's, APP_PERMALINK_HOSTS)", () => {
    vi.stubEnv("APP_URL", "https://raft.example.test");
    vi.stubEnv("APP_PERMALINK_HOSTS", "https://Links.Example.Dev");
    try {
      assert.throws(() => checkContentWorkerConfig({ ARTIFACTS_CONTENT_DOMAIN: "content.app.raft.build" }), /app host app\.raft\.build /);
      assert.throws(() => checkContentWorkerConfig({ ARTIFACTS_CONTENT_DOMAIN: "w.raft.example.test" }), /app host raft\.example\.test /);
      assert.throws(() => checkContentWorkerConfig({ ARTIFACTS_CONTENT_DOMAIN: "example.dev" }), /app host links\.example\.dev /);
      assert.doesNotThrow(() => checkContentWorkerConfig({ ARTIFACTS_CONTENT_DOMAIN: "raftusercontent.example" }));
      assert.doesNotThrow(() => checkContentWorkerConfig({}));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("a publish check's subject and its host origin (task #130)", () => {
  const artifact = "pt_0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a";
  const version = "v_1a2b3c4d-0000-4000-8000-000000000001";
  const server = "22222222-2222-4222-8222-222222222222";
  const user = "11111111-1111-4111-8111-111111111111";

  test("the check subject: written and read back exactly, and never another kind of subject", () => {
    const subject = checkContentSubject({ artifact, version });
    assert.equal(subject, `v1:check:${artifact}:${version}`);
    assert.deepEqual(parseCheckContentSubject(subject), { artifact, version });
    // Each kind of subject is read by its own parser only.
    const anonymous = anonymousContentSubject({ artifact, version });
    const reader = contentSubject({ serverId: asServerId(server), userId: user, sessionFamilyId: null });
    assert.equal(parseCheckContentSubject(anonymous), null);
    assert.equal(parseCheckContentSubject(reader), null);
    assert.equal(parseAnonymousContentSubject(subject), null);
    assert.equal(parseContentSubject(subject), null);
    for (const bad of [
      "",
      `v2:check:${artifact}:${version}`,
      `v1:check:${artifact}`,
      `v1:check:${artifact}:${version}:extra`,
      `v1:check:${artifact.toUpperCase()}:${version}`,
      `v1:check:${artifact}:${version.replace("v_", "")}`,
      `v1:check:${version}:${artifact}`,
      `v1:CHECK:${artifact}:${version}`,
      ` ${subject}`,
      `${subject}\n`,
    ]) assert.equal(parseCheckContentSubject(bad), null, JSON.stringify(bad));
  });
});

