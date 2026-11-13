import assert from "node:assert/strict";
import {
  acceptServerTraceUploadUrl,
  DEFAULT_TRACE_UPLOAD_URL,
  defaultTraceUploadUrlForServer,
  resolveMachineTraceUploadUrl,
  resolveTraceUploadUrl,
  STAGING_TRACE_UPLOAD_URL,
} from "./traceUploadUrl";

// The table cases come from a local (raftdev) server, so loopback receivers are in play.
const LOCAL_SERVER = { serverUrl: "http://localhost:13055" };
const REMOTE_SERVER = { serverUrl: "https://api.raft.build" };

describe("acceptServerTraceUploadUrl", () => {
  test.each([
    ["https://slock-trace-upload.botiverse.dev", "https://slock-trace-upload.botiverse.dev"],
    ["https://slock-trace-upload.botiverse.dev/", "https://slock-trace-upload.botiverse.dev"],
    ["https://slock-trace-upload.botiverse.dev:443", "https://slock-trace-upload.botiverse.dev"],
    ["HTTPS://SLOCK-TRACE-UPLOAD.BOTIVERSE.DEV", "https://slock-trace-upload.botiverse.dev"],
    ["http://localhost:18787", "http://localhost:18787"],
    ["http://127.0.0.1:18841/", "http://127.0.0.1:18841"],
    ["http://[::1]:18841", "http://[::1]:18841"],
    ["https://localhost", "https://localhost"],
    // WHATWG normalizes these to 127.0.0.1: loopback by address, so accepted.
    ["http://127.1:18787", "http://127.0.0.1:18787"],
    ["http://0x7f.0.0.1:18787", "http://127.0.0.1:18787"],
    ["http://2130706433:18787", "http://127.0.0.1:18787"],
    ["http://0177.0.0.1:18787", "http://127.0.0.1:18787"],
    ["http://[0:0:0:0:0:0:0:1]:18787", "http://[::1]:18787"],
    ["https://slock-trace-upload.botiverse.dev/..", "https://slock-trace-upload.botiverse.dev"],
  ])("accepts %s", (raw, expected) => {
    assert.deepEqual(acceptServerTraceUploadUrl(raw, LOCAL_SERVER), { ok: true, url: expected });
  });

  test.each([
    ["http://slock-trace-upload.botiverse.dev", "scheme"],
    ["ftp://slock-trace-upload.botiverse.dev", "scheme"],
    ["https://evil.example.com", "host_not_allowed"],
    ["https://slock-trace-upload.botiverse.dev.evil.com", "host_not_allowed"],
    ["https://evil-slock-trace-upload.botiverse.dev", "host_not_allowed"],
    ["https://trace.botiverse.dev", "host_not_allowed"],
    ["https://slock-trace-upload.botiverse.dev.", "host_not_allowed"],
    ["http://localhost.:18787", "host_not_allowed"],
    ["http://a.localhost:18787", "host_not_allowed"],
    ["http://slock-trace-upload.botiverse.dev.localhost:18787", "host_not_allowed"],
    ["http://[::ffff:127.0.0.1]:18787", "host_not_allowed"],
    ["http://127.0.0.2:18787", "host_not_allowed"],
    ["http://0.0.0.0:18787", "host_not_allowed"],
    ["http://[::]:18787", "host_not_allowed"],
    ["https://slock-trace-upload.botiverse.dev:8443", "port"],
    ["https://user:pw@slock-trace-upload.botiverse.dev", "userinfo"],
    ["https://@slock-trace-upload.botiverse.dev", "userinfo"],
    ["https://slock-trace-upload.botiverse.dev@evil.com", "userinfo"],
    ["http://localhost@evil.com", "userinfo"],
    ["https://slock-trace-upload.botiverse.dev/api", "path"],
    ["https://slock-trace-upload.botiverse.dev/?x=1", "path"],
    ["https://slock-trace-upload.botiverse.dev/#x", "path"],
    // Cyrillic "о" lookalike: never reaches the parser (which would punycode it).
    ["https://slock-trace-uplоad.botiverse.dev", "malformed"],
    ["https://xn--slock-trace-uplad-edo.botiverse.dev", "host_not_allowed"],
    [" https://slock-trace-upload.botiverse.dev", "malformed"],
    ["https://slock-trace-upload.botiverse.dev\n", "malformed"],
    ["https:\\\\slock-trace-upload.botiverse.dev", "malformed"],
    ["slock-trace-upload.botiverse.dev", "malformed"],
    ["", "malformed"],
  ])("rejects %j (%s)", (raw, reason) => {
    assert.deepEqual(acceptServerTraceUploadUrl(raw, LOCAL_SERVER), { ok: false, reason });
  });

  test("a loopback receiver is accepted only from a server that is itself on loopback", () => {
    assert.deepEqual(
      acceptServerTraceUploadUrl("http://localhost:18841", REMOTE_SERVER),
      { ok: false, reason: "loopback_from_remote_server" },
    );
    for (const raw of ["http://127.0.0.1:18841", "http://[::1]:18841", "http://127.1:18841", "https://localhost"]) {
      assert.deepEqual(acceptServerTraceUploadUrl(raw, REMOTE_SERVER), { ok: false, reason: "loopback_from_remote_server" }, raw);
    }
    for (const serverUrl of [
      "http://localhost:13055", "http://127.0.0.1:13055", "http://[::1]:13055", "http://LOCALHOST:13055/", "http://127.1:13055",
    ]) {
      assert.deepEqual(acceptServerTraceUploadUrl("http://localhost:18841", { serverUrl }), { ok: true, url: "http://localhost:18841" }, serverUrl);
    }
    for (const serverUrl of [
      "https://localhost.evil.com", "https://a.localhost", "https://localhost.", "http://127.0.0.2:13055", "http://[::ffff:127.0.0.1]:13055", "not a url",
    ]) {
      assert.deepEqual(
        acceptServerTraceUploadUrl("http://localhost:18841", { serverUrl }),
        { ok: false, reason: "loopback_from_remote_server" },
        serverUrl,
      );
    }
  });

  test("the production receiver is accepted from a remote server", () => {
    assert.deepEqual(
      acceptServerTraceUploadUrl("https://slock-trace-upload.botiverse.dev", REMOTE_SERVER),
      { ok: true, url: "https://slock-trace-upload.botiverse.dev" },
    );
  });

  test("rejects non-strings", () => {
    assert.deepEqual(acceptServerTraceUploadUrl(42, LOCAL_SERVER), { ok: false, reason: "not_string" });
    assert.deepEqual(acceptServerTraceUploadUrl({ href: DEFAULT_TRACE_UPLOAD_URL }, LOCAL_SERVER), { ok: false, reason: "not_string" });
  });
});

describe("resolveTraceUploadUrl", () => {
  const serverUrl = "http://localhost:18787";

  test("env > server > default", () => {
    assert.deepEqual(
      resolveTraceUploadUrl({ env: { SLOCK_DAEMON_TRACE_UPLOAD_URL: "https://mine.example" }, serverTraceUploadUrl: serverUrl }),
      { url: "https://mine.example", source: "env" },
    );
    assert.deepEqual(resolveTraceUploadUrl({ env: {}, serverTraceUploadUrl: serverUrl }), { url: serverUrl, source: "server" });
    assert.deepEqual(resolveTraceUploadUrl({ env: {}, serverTraceUploadUrl: null, serverUrl: "https://api.raft.build" }), { url: DEFAULT_TRACE_UPLOAD_URL, source: "default" });
    assert.deepEqual(
      resolveTraceUploadUrl({ env: { SLOCK_DAEMON_TRACE_UPLOAD_URL: "  " }, serverTraceUploadUrl: serverUrl }),
      { url: serverUrl, source: "server" },
      "a blank env value is unset",
    );
  });

  test("DISABLED=1 wins over everything", () => {
    assert.deepEqual(
      resolveTraceUploadUrl({
        env: { SLOCK_DAEMON_TRACE_UPLOAD_DISABLED: "1", SLOCK_DAEMON_TRACE_UPLOAD_URL: "https://mine.example" },
        serverTraceUploadUrl: serverUrl,
      }),
      { url: null, source: "disabled" },
    );
    assert.equal(resolveMachineTraceUploadUrl({ SLOCK_DAEMON_TRACE_UPLOAD_DISABLED: "1" }), null);
  });

  test("RAFT_PRIVACY_MODE wins over everything, the owner's own URL included", () => {
    assert.deepEqual(
      resolveTraceUploadUrl({
        env: { SLOCK_DAEMON_TRACE_UPLOAD_URL: "https://mine.example" },
        serverTraceUploadUrl: serverUrl,
        serverUrl: "https://api.raft.build",
        privacyMode: true,
      }),
      { url: null, source: "disabled" },
    );
    assert.equal(resolveMachineTraceUploadUrl({}, "https://api.raft.build", true), null);
    assert.equal(resolveMachineTraceUploadUrl({}, "https://api.raft.build", false), DEFAULT_TRACE_UPLOAD_URL, "off: unchanged");
  });

  test("machine-level URL never takes the server's value; its default follows this runner's server", () => {
    assert.equal(resolveMachineTraceUploadUrl({}, "https://api.raft.build"), DEFAULT_TRACE_UPLOAD_URL);
    assert.equal(resolveMachineTraceUploadUrl({}, "https://raft.example.org"), null, "a self-hosted server's runner has none");
    assert.equal(resolveMachineTraceUploadUrl({}), null);
    assert.equal(resolveMachineTraceUploadUrl({ SLOCK_DAEMON_TRACE_UPLOAD_URL: "https://mine.example" }, "https://raft.example.org"), "https://mine.example");
  });
});

// #botiverse-raft-deployment:#211: a runner attached to AWS staging used to
// upload to the production receiver and got 401 (different signing secrets).
describe("default receiver follows the attached server", () => {
  test("the AWS staging server defaults to the staging receiver", () => {
    assert.equal(STAGING_TRACE_UPLOAD_URL, "https://api-aws-staging.botiverse.dev/__trace");
    for (const serverUrl of [
      "https://api-aws-staging.botiverse.dev",
      "https://api-aws-staging.botiverse.dev/",
      "HTTPS://API-AWS-STAGING.BOTIVERSE.DEV:443",
    ]) {
      assert.equal(defaultTraceUploadUrlForServer(serverUrl), STAGING_TRACE_UPLOAD_URL, serverUrl);
    }
    assert.deepEqual(
      resolveTraceUploadUrl({ env: {}, serverTraceUploadUrl: null, serverUrl: "https://api-aws-staging.botiverse.dev" }),
      { url: STAGING_TRACE_UPLOAD_URL, source: "default" },
    );
  });

  test("Raft's production server (and its legacy host) defaults to the production receiver", () => {
    for (const serverUrl of ["https://api.raft.build", "https://api.raft.build/", "HTTPS://API.RAFT.BUILD:443", "https://api.slock.ai"]) {
      assert.equal(defaultTraceUploadUrlForServer(serverUrl), DEFAULT_TRACE_UPLOAD_URL, serverUrl);
    }
  });

  // #proj-raft-computer:#54 (tygg #proj-o11y:880945a7): a self-hosted
  // server's Computer sent its traces to Raft's receiver, which only rejected
  // them. Any server that is not Raft's has no default: nothing is uploaded.
  test("any other server has no default receiver: nothing is uploaded", () => {
    for (const serverUrl of [
      undefined,
      "",
      "not a url",
      "https://raft.example.org",
      "http://localhost:13055",
      "http://api.raft.build",
      "https://api.raft.build:8443",
      "https://user@api.raft.build",
      "https://api.raft.build.evil.example",
      "https://x.api.raft.build",
      "http://api-aws-staging.botiverse.dev",
      "https://api-aws-staging.botiverse.dev:8443",
      "https://user@api-aws-staging.botiverse.dev",
      "https://api-aws-staging.botiverse.dev.evil.example",
      "https://x.api-aws-staging.botiverse.dev",
    ]) {
      assert.equal(defaultTraceUploadUrlForServer(serverUrl), null, String(serverUrl));
    }
    assert.deepEqual(
      resolveTraceUploadUrl({ env: {}, serverTraceUploadUrl: null, serverUrl: "https://raft.example.org" }),
      { url: null, source: "none" },
    );
    // The owner's own receiver, or one the server names from the allowlist, still applies.
    assert.deepEqual(
      resolveTraceUploadUrl({ env: { SLOCK_DAEMON_TRACE_UPLOAD_URL: "https://traces.example.org" }, serverUrl: "https://raft.example.org" }),
      { url: "https://traces.example.org", source: "env" },
    );
    assert.deepEqual(
      resolveTraceUploadUrl({ env: {}, serverTraceUploadUrl: "http://localhost:18787", serverUrl: "http://localhost:13055" }),
      { url: "http://localhost:18787", source: "server" },
    );
  });

  test("env and an allowlisted server value still win over the server default", () => {
    const staging = "https://api-aws-staging.botiverse.dev";
    assert.deepEqual(
      resolveTraceUploadUrl({ env: { SLOCK_DAEMON_TRACE_UPLOAD_URL: "https://mine.example" }, serverUrl: staging }),
      { url: "https://mine.example", source: "env" },
    );
    assert.deepEqual(
      resolveTraceUploadUrl({ env: {}, serverTraceUploadUrl: DEFAULT_TRACE_UPLOAD_URL, serverUrl: staging }),
      { url: DEFAULT_TRACE_UPLOAD_URL, source: "server" },
    );
    assert.deepEqual(
      resolveTraceUploadUrl({ env: { SLOCK_DAEMON_TRACE_UPLOAD_DISABLED: "1" }, serverUrl: staging }),
      { url: null, source: "disabled" },
    );
  });

  test("a server cannot name the staging receiver (the allowlist is unchanged)", () => {
    const check = acceptServerTraceUploadUrl("https://api-aws-staging.botiverse.dev", REMOTE_SERVER);
    assert.equal(check.ok, false);
  });
});
