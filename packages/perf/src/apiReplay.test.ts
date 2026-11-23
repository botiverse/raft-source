import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApiReplayStore, REPLAY_STALE_MS, canonicalApiRequestKey, evaluateReplayMisses, hashAccountHint, redactedApiRouteShape } from "./apiReplay";

describe("ApiReplayStore, canonicalApiRequestKey, and snapshot validation", () => {
  it("normalizes query param order, scopes by x-server-id, ignores non-GET or non-/api routes, and round-trips to disk", () => {
    const k1 = canonicalApiRequestKey("GET", "https://api.example.com/api/messages/channel/c1?limit=50&before=abc", { "X-Server-Id": "s1" });
    const k2 = canonicalApiRequestKey("get", "https://api.example.com/api/messages/channel/c1?before=abc&limit=50", { "x-server-id": "s1" });
    const kOtherServer = canonicalApiRequestKey("GET", "https://api.example.com/api/messages/channel/c1?before=abc&limit=50", { "x-server-id": "s2" });

    expect(k1).toBe("GET /api/messages/channel/c1?before=abc&limit=50 [server:s1]");
    expect(k2).toBe(k1);
    expect(kOtherServer).not.toBe(k1);
    expect(canonicalApiRequestKey("POST", "https://api.example.com/api/auth/login")).toBeNull();
    expect(canonicalApiRequestKey("GET", "https://app.example.com/assets/index.js")).toBeNull();

    const store = new ApiReplayStore({
      apiOrigin: "https://api.example.com",
      serverSlug: "qa-perf-bench",
      channelName: "bench-v1",
      fixtureTag: "bench-v1@5395d2b0",
      accountHint: hashAccountHint("WM@example.com"),
    });
    store.record(
      k1!,
      200,
      { "Content-Type": "application/json", "Content-Encoding": "gzip", "Set-Cookie": "secret=1" },
      Buffer.from('{"messages":[{"id":"m1"}]}', "utf8"),
    );
    expect(store.size).toBe(1);

    // Non-critical optional route 404s are cached deterministically, whereas core boot 404s and 401/429/500 are refused
    const kOpt404 = canonicalApiRequestKey("GET", "https://api.example.com/api/channels/c1/announcement", { "x-server-id": "s1" })!;
    const kBoot404 = canonicalApiRequestKey("GET", "https://api.example.com/api/messages/channel/c999", { "x-server-id": "s1" })!;
    const kRateLimited = canonicalApiRequestKey("GET", "https://api.example.com/api/channels/c1/members", { "x-server-id": "s1" })!;
    store.record(kOpt404, 404, { "Content-Type": "application/json" }, Buffer.from('{"error":"not_found"}', "utf8"));
    store.record(kBoot404, 404, { "Content-Type": "application/json" }, Buffer.from('{"error":"not_found"}', "utf8"));
    store.record(kRateLimited, 429, { "Content-Type": "application/json" }, Buffer.from('{"error":"slow_down"}', "utf8"));
    expect(store.lookup(kOpt404)?.status).toBe(404);
    expect(store.lookup(kBoot404)).toBeNull();
    expect(store.lookup(kRateLimited)).toBeNull();

    const tmp = mkdtempSync(path.join(tmpdir(), "raft-perf-replay-"));
    try {
      const file = path.join(tmp, "replay.json");
      store.saveToFile(file);
      const reloaded = ApiReplayStore.loadFromFile(file);
      const hit = reloaded.lookup(k2!)!;
      expect(hit.status).toBe(200);
      expect(hit.headers["content-encoding"]).toBeUndefined();
      expect(hit.headers["set-cookie"]).toBeUndefined();
      expect(hit.headers["timing-allow-origin"]).toBe("*");
      expect(hit.body.toString("utf8")).toBe('{"messages":[{"id":"m1"}]}');

      // Matching run context passes cleanly
      expect(
        reloaded.validateAgainst({
          apiOrigin: "https://api.example.com",
          serverSlug: "qa-perf-bench",
          channelName: "bench-v1",
          fixtureTag: "bench-v1@5395d2b0",
          accountEmail: "wm@example.com",
        }),
      ).toEqual({ errors: [], warnings: [] });

      // Wrong origin, account, or drifted fixture is rejected; stale snapshot warns
      const bad = reloaded.validateAgainst(
        {
          apiOrigin: "https://other.example.com",
          serverSlug: "qa-perf-bench",
          channelName: "bench-v1",
          fixtureTag: "bench-v1@deadbeef",
          accountEmail: "other@example.com",
        },
        Date.parse(reloaded.capturedAt) + REPLAY_STALE_MS + 3_600_000,
      );
      expect(bad.errors).toHaveLength(3);
      expect(bad.warnings[0]).toMatch(/old/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("redactedApiRouteShape and evaluateReplayMisses", () => {
  it("strips query values from missed route shapes and distinguishes symmetric non-critical misses (exit 0 note) from asymmetric or critical misses (exit 2 warning)", () => {
    expect(redactedApiRouteShape("https://api.example.com/api/sync/delta?since_seq=999123&limit=50")).toBe("/api/sync/delta?limit&since_seq");
    expect(canonicalApiRequestKey("GET", "https://api.example.com/api/ping?_t=1700001")).toBe(
      canonicalApiRequestKey("GET", "https://api.example.com/api/ping?_t=1700999"),
    );

    // Symmetric 18 vs 16 across 6 pairs, 0 critical misses -> fatal: false (note only, exit 0)
    expect(evaluateReplayMisses({ baseMisses: 18, prMisses: 16, criticalMisses: 0, pairs: 6 })).toMatchObject({ fatal: false });
    // Asymmetric 18 vs 2 across 6 pairs -> fatal: true (warning, exit 2)
    expect(evaluateReplayMisses({ baseMisses: 18, prMisses: 2, criticalMisses: 0, pairs: 6 })).toMatchObject({ fatal: true });
    // Critical first-page messages miss -> fatal: true even if symmetric
    expect(evaluateReplayMisses({ baseMisses: 1, prMisses: 1, criticalMisses: 2, pairs: 6 })).toMatchObject({ fatal: true });
  });
});
