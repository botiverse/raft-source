import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import api from "../src/api/client";
import {
  isSyncCoreMessagesFlagEnabled,
  refreshSyncCoreMessagesFlagForCurrentServer,
  resetSyncCoreMessagesFlagForTests,
} from "../src/store/messageSyncFeatureFlag";
import { SYNC_CORE_MESSAGES_FLAG_KEY } from "../src/store/messageSyncDomain";
import { REGISTERED_SERVER_FEATURE_FLAG_KEYS } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";

const originalPost = api.post.bind(api);

function setCurrentServer(serverId: string | null) {
  useServerStore.setState({
    current: serverId
      ? {
          id: serverId,
          name: "Server",
          slug: serverId,
          ownerId: "owner-1",
          onboardingAgentId: null,
          hideHumansFromMembers: false,
          plan: "free",
          planDowngradedAt: null,
          role: "member",
          createdAt: "2026-07-10T00:00:00.000Z",
        }
      : null,
  });
}

function stubEvaluation(
  handler: (url: string, body: unknown) => Promise<unknown>,
) {
  api.post = (async (url: string, body?: unknown) => ({
    data: await handler(url, body),
  })) as typeof api.post;
}

afterEach(() => {
  api.post = originalPost as typeof api.post;
  setCurrentServer(null);
  resetSyncCoreMessagesFlagForTests();
});

test("sync-core message flag defaults false without a current server", async () => {
  let postCalls = 0;
  api.post = (async () => {
    postCalls += 1;
    throw new Error("feature flag API should not be called without a server");
  }) as typeof api.post;

  setCurrentServer(null);

  assert.equal(isSyncCoreMessagesFlagEnabled(), false);
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), false);
  assert.equal(postCalls, 0);
});

test("sync-core message flag evaluates through the current server and reuses the cached result", async () => {
  let postCalls = 0;
  setCurrentServer("server-a");
  stubEvaluation(async (url, body) => {
    postCalls += 1;
    assert.equal(url, "/feature-flags/evaluate");
    assert.deepEqual(body, {
      serverId: "server-a",
      platform: "web",
      keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
    });
    return {
      evaluations: [{ key: SYNC_CORE_MESSAGES_FLAG_KEY, enabled: true }],
    };
  });

  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);
  assert.equal(isSyncCoreMessagesFlagEnabled(), true);
  assert.equal(postCalls, 1);
});

test("sync-core message flag returns false while an uncached evaluation is pending and coalesces requests", async () => {
  let resolveEvaluation: (value: unknown) => void = () => undefined;
  let postCalls = 0;
  const pending = new Promise<unknown>((resolve) => {
    resolveEvaluation = resolve;
  });
  setCurrentServer("server-a");
  stubEvaluation(async () => {
    postCalls += 1;
    return pending;
  });

  assert.equal(isSyncCoreMessagesFlagEnabled(), false);
  const first = refreshSyncCoreMessagesFlagForCurrentServer();
  const second = refreshSyncCoreMessagesFlagForCurrentServer();
  assert.equal(postCalls, 1);

  resolveEvaluation({
    evaluations: [{ key: SYNC_CORE_MESSAGES_FLAG_KEY, enabled: true }],
  });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(postCalls, 1);
  assert.equal(isSyncCoreMessagesFlagEnabled(), true);
});

test("sync-core message flag treats missing evaluations and request failures as disabled", async () => {
  setCurrentServer("server-a");
  stubEvaluation(async () => ({
    evaluations: [{ key: "other_flag_v0", enabled: true }],
  }));
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), false);
  assert.equal(isSyncCoreMessagesFlagEnabled(), false);

  resetSyncCoreMessagesFlagForTests();
  stubEvaluation(async () => {
    throw new Error("feature flag service unavailable");
  });
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), false);
  assert.equal(isSyncCoreMessagesFlagEnabled(), false);
});

test("sync-core message flag reset clears cached evaluations", async () => {
  let postCalls = 0;
  setCurrentServer("server-a");
  stubEvaluation(async () => {
    postCalls += 1;
    return {
      evaluations: [{ key: SYNC_CORE_MESSAGES_FLAG_KEY, enabled: true }],
    };
  });

  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);
  assert.equal(isSyncCoreMessagesFlagEnabled(), true);
  resetSyncCoreMessagesFlagForTests();
  assert.equal(isSyncCoreMessagesFlagEnabled(), false);
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);
  assert.equal(postCalls, 2);
});

test("sync-core message flag refresh reuses the session evaluation after it resolves", async () => {
  let enabled = true;
  let postCalls = 0;
  setCurrentServer("server-a");
  stubEvaluation(async () => {
    postCalls += 1;
    return {
      evaluations: [{ key: SYNC_CORE_MESSAGES_FLAG_KEY, enabled }],
    };
  });

  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);
  enabled = false;
  assert.equal(await refreshSyncCoreMessagesFlagForCurrentServer(), true);
  assert.equal(isSyncCoreMessagesFlagEnabled(), true);
  assert.equal(postCalls, 1);
});
