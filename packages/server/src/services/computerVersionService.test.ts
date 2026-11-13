import assert from "node:assert/strict";
import {
  getLatestComputerReleaseNotes,
  getLatestComputerVersion,
  resolveComputerUpgradeAvailable,
  __resetLatestComputerVersionForTest,
} from "./computerVersionService";
import { setPrivacyModeForTest } from "../config/privacyMode";

const LATEST_BUILD_URL = "https://hands.build/public/v2/apps/raft-computer-cli/latest?channel=main";

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** The release-notes read is a separate Hands URL; these version tests answer it with 404. */
function isLatestBuildRequest(input: RequestInfo | URL): boolean {
  return requestUrl(input) === LATEST_BUILD_URL;
}

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("RAFT_PRIVACY_MODE: getLatestComputerVersion makes no request and is unknown", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return notFound();
  }) as typeof fetch;
  setPrivacyModeForTest(true);
  try {
    assert.equal(await getLatestComputerVersion(), null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    assert.equal(getLatestComputerReleaseNotes(), null);
  } finally {
    setPrivacyModeForTest(false);
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("getLatestComputerVersion returns stale cache immediately and refreshes in background", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  const firstFetch = deferred<Response>();
  const secondFetch = deferred<Response>();
  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (isLatestBuildRequest(input)) return notFound();
    fetchCalls.push(requestUrl(input));
    return fetchCalls.length === 1 ? firstFetch.promise : secondFetch.promise;
  }) as typeof fetch;

  try {
    assert.equal(await getLatestComputerVersion(), null);
    assert.deepEqual(fetchCalls, ["https://hands.build/public/v2/apps/raft-computer-cli/updates/check?product_type=cli-binary&current_version=0.0.0&platform=linux&arch=x64&channel=main"]);

    firstFetch.resolve(new Response(JSON.stringify({ update_available: true, release: { id: "r1", version: "0.0.62" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await getLatestComputerVersion(), "0.0.62");
    assert.equal(fetchCalls.length, 1);

    __resetLatestComputerVersionForTest();
    assert.equal(await getLatestComputerVersion(), null);
    assert.equal(fetchCalls.length, 2);
    secondFetch.resolve(new Response(JSON.stringify({ update_available: true, release: { id: "r2", version: "0.0.63" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await getLatestComputerVersion(), "0.0.63");
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("getLatestComputerVersion coalesces concurrent cold refreshes", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  const firstFetch = deferred<Response>();
  let fetchCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (isLatestBuildRequest(input)) return notFound();
    fetchCount += 1;
    return firstFetch.promise;
  }) as typeof fetch;

  try {
    assert.equal(await getLatestComputerVersion(), null);
    assert.equal(await getLatestComputerVersion(), null);
    assert.equal(fetchCount, 1);

    firstFetch.resolve(new Response(JSON.stringify({ update_available: true, release: { id: "r1", version: "0.0.62" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await getLatestComputerVersion(), "0.0.62");
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("getLatestComputerVersion swallows provider/network errors and keeps the last cached value", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;

  // Seed a cached value via a successful fetch.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ update_available: true, release: { id: "r1", version: "0.0.62" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  await getLatestComputerVersion();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await getLatestComputerVersion(), "0.0.62");

  // Force expiry, then make subsequent fetches throw — cached value must
  // survive (best-effort registry, not a critical path).
  __resetLatestComputerVersionForTest();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ update_available: true, release: { id: "r2", version: "0.0.63" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  await getLatestComputerVersion();
  await new Promise((resolve) => setImmediate(resolve));

  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  // Inside the cache window, getLatestComputerVersion does not refetch, so
  // the broken fetch is irrelevant — value is still 0.0.63.
  assert.equal(await getLatestComputerVersion(), "0.0.63");

  globalThis.fetch = originalFetch;
  __resetLatestComputerVersionForTest();
});

test("getLatestComputerVersion ignores a Hands response without a release version", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ update_available: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    await getLatestComputerVersion();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await getLatestComputerVersion(), null);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Hands stub: update-check answers `version`; `/latest` answers `latest()`. */
function stubHands(version: string, latest: () => Response | Promise<Response>): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    calls.push(url);
    if (url === LATEST_BUILD_URL) return latest();
    return jsonResponse({ update_available: true, release: { id: `r-${version}`, version } });
  }) as typeof fetch;
  return calls;
}

async function refreshAndSettle(): Promise<void> {
  await getLatestComputerVersion();
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const NOTES_1040 = {
  "zh-CN": "- macOS 上自动重新注册开机启动项\n- 修复代理压缩响应",
  en: "- Re-register the macOS login item automatically\n- Fix compressed proxy responses",
};

test("release notes are cached for the latest version when Hands' latest build matches it", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  try {
    const calls = stubHands("1.0.40", () => jsonResponse({ build: { version: "1.0.40", release_notes: NOTES_1040 } }));
    await refreshAndSettle();
    assert.ok(calls.includes(LATEST_BUILD_URL));
    assert.equal(await getLatestComputerVersion(), "1.0.40");
    assert.deepEqual(getLatestComputerReleaseNotes(), { version: "1.0.40", ...NOTES_1040 });
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("release notes for a different build version are dropped and never replace matching notes", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  const nowSpy = vi.spyOn(Date, "now");
  let now = 1_000_000;
  nowSpy.mockImplementation(() => now);
  try {
    stubHands("1.0.40", () => jsonResponse({ build: { version: "1.0.41", release_notes: NOTES_1040 } }));
    await refreshAndSettle();
    assert.equal(await getLatestComputerVersion(), "1.0.40");
    assert.equal(getLatestComputerReleaseNotes(), null);

    now += 2 * 60 * 60 * 1000;
    stubHands("1.0.40", () => jsonResponse({ build: { version: "1.0.40", release_notes: NOTES_1040 } }));
    await refreshAndSettle();
    assert.deepEqual(getLatestComputerReleaseNotes(), { version: "1.0.40", ...NOTES_1040 });

    // Rollout skew: `/latest` already serves 1.0.41 while update-check still
    // says 1.0.40. The 1.0.40 notes stay.
    now += 2 * 60 * 60 * 1000;
    stubHands("1.0.40", () => jsonResponse({ build: { version: "1.0.41", release_notes: { en: "- other" } } }));
    await refreshAndSettle();
    assert.deepEqual(getLatestComputerReleaseNotes(), { version: "1.0.40", ...NOTES_1040 });
  } finally {
    nowSpy.mockRestore();
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("malformed release notes values are rejected", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const releaseNotes of [null, "- a string", ["- a"], { en: 7, "zh-CN": { text: "- x" } }, { en: "x".repeat(16_001) }]) {
      __resetLatestComputerVersionForTest();
      stubHands("1.0.40", () => jsonResponse({ build: { version: "1.0.40", release_notes: releaseNotes } }));
      await refreshAndSettle();
      assert.equal(await getLatestComputerVersion(), "1.0.40");
      assert.equal(getLatestComputerReleaseNotes(), null, JSON.stringify(releaseNotes).slice(0, 80));
    }

    __resetLatestComputerVersionForTest();
    stubHands("1.0.40", () => jsonResponse({ build: { version: "1.0.40", release_notes: { en: 7, "zh-CN": "- 修复", fr: "- corrigé" } } }));
    await refreshAndSettle();
    assert.deepEqual(getLatestComputerReleaseNotes(), { version: "1.0.40", "zh-CN": "- 修复" });
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("a failed release notes refresh keeps the last cached notes; a new version hides them", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  const nowSpy = vi.spyOn(Date, "now");
  let now = 1_000_000;
  nowSpy.mockImplementation(() => now);
  try {
    stubHands("1.0.40", () => jsonResponse({ build: { version: "1.0.40", release_notes: NOTES_1040 } }));
    await refreshAndSettle();
    assert.deepEqual(getLatestComputerReleaseNotes(), { version: "1.0.40", ...NOTES_1040 });

    // Cache expires; the notes read now throws, then returns 500.
    for (const failure of [() => { throw new Error("network down"); }, () => new Response("boom", { status: 500 })]) {
      now += 2 * 60 * 60 * 1000;
      const calls = stubHands("1.0.40", failure);
      await refreshAndSettle();
      assert.ok(calls.includes(LATEST_BUILD_URL), "expired cache must re-read the notes");
      assert.deepEqual(getLatestComputerReleaseNotes(), { version: "1.0.40", ...NOTES_1040 });
    }

    // A newer version whose notes cannot be read must not inherit 1.0.40's notes.
    now += 2 * 60 * 60 * 1000;
    stubHands("1.0.41", () => new Response("boom", { status: 500 }));
    await refreshAndSettle();
    assert.equal(await getLatestComputerVersion(), "1.0.41");
    assert.equal(getLatestComputerReleaseNotes(), null);
  } finally {
    nowSpy.mockRestore();
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("resolveComputerUpgradeAvailable: server asserts available/up-to-date/unknown states", () => {
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.61", "0.0.62"), true);
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.62", "0.0.62"), false);
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.63", "0.0.62"), false);

  assert.equal(resolveComputerUpgradeAvailable(false, "0.0.61", "0.0.62"), null);
  assert.equal(resolveComputerUpgradeAvailable(true, null, "0.0.62"), null);
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.61", null), null);
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.62-rc1", "0.0.62"), null);
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.62", "latest"), null);
});
