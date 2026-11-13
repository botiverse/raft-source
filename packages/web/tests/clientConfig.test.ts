import assert from "node:assert/strict";
import "./helpers/domSetup";

import api from "../src/api/client";
import { loadClientConfig, resetClientConfigForTests } from "../src/store/clientConfig";
import { raftPermalinkHostnames, readRaftAppHosts, resetRaftAppHostsForTests, subscribeRaftAppHosts } from "../src/store/raftAppHosts";

// The per-deploy client config (GET /api/public/client-config) is where the
// page learns Raft's app hosts (the server's appHosts()): read once per page
// load, signed in or not, kept in store/raftAppHosts.ts by its rules
// (hostnames only, deduped, the same list notifies nobody). A failed or odd
// answer keeps the fallback.

const originalGet = api.get.bind(api);

afterEach(() => {
  api.get = originalGet as typeof api.get;
  resetClientConfigForTests();
  resetRaftAppHostsForTests();
  localStorage.clear();
});

/** Answers the client config with `answer()` (a throw is a failed read); counts the reads. */
function stubClientConfig(answer: () => unknown) {
  const reads: string[] = [];
  api.get = (async (url: string) => {
    reads.push(url);
    if (url !== "/public/client-config") throw new Error(`unexpected GET ${url}`);
    return { data: answer() };
  }) as typeof api.get;
  return reads;
}

test("the page's Raft app hosts come from the client config: hostnames only, deduped, in the server's order; one read per page load, signed out too", async () => {
  let notified = 0;
  const stop = subscribeRaftAppHosts(() => { notified += 1; });
  const reads = stubClientConfig(() => ({ appHosts: ["app.raft.build", "raft-staging.pages.dev", "app.raft.build", "evil.example:8443", "https://scheme.example", "Upper.Example", "a.example/path", 7, ""] }));
  try {
    assert.equal(localStorage.getItem("slock_access_token"), null, "no session: the config is deploy-wide");
    assert.equal(readRaftAppHosts(), null, "nothing before the server answers");
    await Promise.all([loadClientConfig(), loadClientConfig()]);
    await loadClientConfig();
    assert.deepEqual(reads, ["/public/client-config"], "asked once for the page");
    assert.deepEqual(readRaftAppHosts(), ["app.raft.build", "raft-staging.pages.dev"], "hostnames as URL.hostname spells them, once each, in the server's order");
    assert.equal(notified, 1);

    // The same list again (another read, e.g. a later load in a test) notifies nobody.
    resetClientConfigForTests();
    await loadClientConfig();
    assert.equal(reads.length, 2);
    assert.equal(notified, 1, "the same list again: no change, no re-render of the rows reading it");
  } finally {
    stop();
  }
});

test("a failed or odd client config keeps the fallback (no list), and nothing asks again on its own", async () => {
  for (const answer of [
    () => { throw Object.assign(new Error("Network Error"), { isAxiosError: true }); },
    () => ({}),
    () => null,
    () => "<!doctype html><html></html>",
    () => ({ appHosts: "app.raft.build" }),
    () => ({ appHosts: [] }),
    () => ({ appHosts: ["Not A Host", "evil.example:8443"] }),
  ]) {
    resetClientConfigForTests();
    const reads = stubClientConfig(answer);
    await loadClientConfig();
    await loadClientConfig();
    assert.equal(reads.length, 1, String(answer));
    assert.equal(readRaftAppHosts(), null, `the fallback stays: ${String(answer)}`);
    assert.deepEqual(raftPermalinkHostnames(readRaftAppHosts(), "app.raft.build"), ["app.raft.build"], "permalinks: the page's own host (and shared's defaults)");
  }
});

test("a usable list stays when a later answer is unusable", async () => {
  stubClientConfig(() => ({ appHosts: ["app.raft.build", "raft-staging.pages.dev"] }));
  await loadClientConfig();
  resetClientConfigForTests();
  stubClientConfig(() => ({ appHosts: ["Not A Host"] }));
  await loadClientConfig();
  assert.deepEqual(readRaftAppHosts(), ["app.raft.build", "raft-staging.pages.dev"]);
});

test("permalink hostnames: the page's own host plus the server's list, deduped; the page's own until the list arrives", () => {
  const server = ["app.raft.build", "chat.example.test", "raft-staging.pages.dev"];
  assert.deepEqual(raftPermalinkHostnames(null, "preview-7.raft-web.pages.dev"), ["preview-7.raft-web.pages.dev"]);
  assert.deepEqual(raftPermalinkHostnames(server, "preview-7.raft-web.pages.dev"), ["preview-7.raft-web.pages.dev", ...server]);
  assert.deepEqual(raftPermalinkHostnames(server, "raft-staging.pages.dev"), ["raft-staging.pages.dev", "app.raft.build", "chat.example.test"]);
});
