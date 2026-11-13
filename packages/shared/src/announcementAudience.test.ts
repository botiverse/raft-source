import assert from "node:assert/strict";
import { asServerId } from "./brandedIds";
import { asAnnouncementRecipientUserId, matchesAnnouncementAudience, validateAnnouncementAudience } from "../announcement-audience";

const serverA = asServerId("00000000-0000-0000-0000-000000000001");
const serverB = asServerId("00000000-0000-0000-0000-000000000002");
const alice = asAnnouncementRecipientUserId("00000000-0000-0000-0000-000000000003");
const bob = asAnnouncementRecipientUserId("00000000-0000-0000-0000-000000000004");

test("server audiences require the matching current workspace and current membership", () => {
  const members = validateAnnouncementAudience({ type: "server_members", serverIds: [serverA] });
  const selected = validateAnnouncementAudience({ type: "server_users", targets: [{ serverId: serverA, userIds: [alice] }] });
  assert.equal(matchesAnnouncementAudience(members, bob, serverA, true), true);
  assert.equal(matchesAnnouncementAudience(selected, alice, serverA, true), true);
  assert.equal(matchesAnnouncementAudience(selected, bob, serverA, true), false);
  for (const audience of [members, selected]) {
    assert.equal(matchesAnnouncementAudience(audience, alice, serverB, true), false);
    assert.equal(matchesAnnouncementAudience(audience, alice, serverA, false), false);
    assert.equal(matchesAnnouncementAudience(audience, alice, null, false), false);
  }
});

test("user targeting is account-wide; legacy announcements retain all-user eligibility", () => {
  const audience = validateAnnouncementAudience({ type: "users", userIds: [alice] });
  assert.equal(matchesAnnouncementAudience(audience, alice, serverB, false), true);
  assert.equal(matchesAnnouncementAudience(audience, alice, null, false), true);
  assert.equal(matchesAnnouncementAudience(audience, bob, serverA, true), false);
  assert.equal(matchesAnnouncementAudience(validateAnnouncementAudience(undefined), bob, null, false), true);
});

test("ID normalization deduplicates without widening the requested server/user pairs", () => {
  assert.deepEqual(validateAnnouncementAudience({ type: "server_users", targets: [
    { serverId: serverA, userIds: [alice, alice] },
    { serverId: serverA, userIds: [bob] },
    { serverId: serverB, userIds: [bob] },
  ] }), { type: "server_users", targets: [
    { serverId: serverA, userIds: [alice, bob] }, { serverId: serverB, userIds: [bob] },
  ] });
});

test("malformed or ambiguous targeting fails closed rather than becoming all-user delivery", () => {
  for (const input of [null, {}, { type: "other" }, { type: "all", userIds: [alice] },
    { type: "users", userIds: [] }, { type: "users", userIds: ["alice@example.com"] },
    { type: "server_members", serverIds: [alice], extra: true },
    { type: "server_users", targets: [{ serverId: serverA, userIds: [] }] },
  ]) assert.throws(() => validateAnnouncementAudience(input));
});

test("client targets are optional on every audience type and normalize deterministically", () => {
  assert.equal("clients" in validateAnnouncementAudience({ type: "users", userIds: [alice] }), false, "omitted clients stay omitted");
  assert.deepEqual(validateAnnouncementAudience({ type: "all", clients: [
    { maxBuild: 11400009, buildTypes: ["play", "play", "alpha"], platform: "android" },
    { platform: "ios" },
    { platform: "android", buildTypes: ["alpha", "play"], maxBuild: 11400009 },
  ] }), { type: "all", clients: [
    { platform: "android", buildTypes: ["alpha", "play"], maxBuild: 11400009 },
    { platform: "ios" },
  ] });
  assert.deepEqual(validateAnnouncementAudience({ type: "server_members", serverIds: [serverA], clients: [{ platform: "harmonyos", minBuild: 0, maxBuild: 0 }] }),
    { type: "server_members", serverIds: [serverA], clients: [{ platform: "harmonyos", minBuild: 0, maxBuild: 0 }] });
  assert.deepEqual(validateAnnouncementAudience({ type: "server_users", targets: [{ serverId: serverA, userIds: [alice] }], clients: [{ platform: "ios" }] }).clients, [{ platform: "ios" }]);
});

test("malformed client targets fail closed", () => {
  for (const clients of [null, [], {}, "android", [{}], [{ platform: "web" }], [{ platform: "android", extra: 1 }],
    [{ platform: "android", buildTypes: [] }], [{ platform: "android", buildTypes: ["Play"] }], [{ platform: "android", buildTypes: ["x".repeat(33)] }],
    [{ platform: "android", buildTypes: "play" }], [{ platform: "android", minBuild: -1 }], [{ platform: "android", maxBuild: 1.5 }],
    [{ platform: "android", maxBuild: "11400009" }], [{ platform: "android", minBuild: Number.MAX_SAFE_INTEGER + 1 }],
    [{ platform: "android", minBuild: 2, maxBuild: 1 }], Array.from({ length: 21 }, () => ({ platform: "ios" })),
  ]) assert.throws(() => validateAnnouncementAudience({ type: "all", clients }), Error, JSON.stringify(clients));
});

test("client targets narrow the audience; an unstated constrained value never matches", () => {
  const stuck = validateAnnouncementAudience({ type: "all", clients: [{ platform: "android", buildTypes: ["play"], maxBuild: 11400009 }] });
  assert.equal(matchesAnnouncementAudience(stuck, bob, null, false, { platform: "android", buildNumber: 11400009, buildType: "play" }), true);
  assert.equal(matchesAnnouncementAudience(stuck, bob, null, false, { platform: "android", buildNumber: 11400010, buildType: "play" }), false);
  assert.equal(matchesAnnouncementAudience(stuck, bob, null, false, { platform: "android", buildNumber: 11400009, buildType: "release" }), false);
  assert.equal(matchesAnnouncementAudience(stuck, bob, null, false, { platform: "android", buildType: "play" }), false);
  assert.equal(matchesAnnouncementAudience(stuck, bob, null, false, { platform: "android", buildNumber: 1 }), false);
  assert.equal(matchesAnnouncementAudience(stuck, bob, null, false, { platform: "ios", buildNumber: 1, buildType: "play" }), false);
  assert.equal(matchesAnnouncementAudience(stuck, bob, null, false), false, "no native client");
  const ios = validateAnnouncementAudience({ type: "users", userIds: [alice], clients: [{ platform: "ios", minBuild: 5 }] });
  assert.equal(matchesAnnouncementAudience(ios, alice, null, false, { platform: "ios", buildNumber: 5 }), true);
  assert.equal(matchesAnnouncementAudience(ios, bob, null, false, { platform: "ios", buildNumber: 5 }), false, "clients never widen the audience");
  assert.equal(matchesAnnouncementAudience(validateAnnouncementAudience({ type: "all" }), bob, null, false), true);
});

test("devices: desktop = web + desktop app, mobile = native Apps + phone/tablet browsers; absent = both", async () => {
  const { matchesAnnouncementDevices, announcementDeviceOf } = await import("../announcement-audience");
  assert.deepEqual(validateAnnouncementAudience({ type: "all", devices: ["mobile", "desktop", "mobile"] }), { type: "all", devices: ["desktop", "mobile"] });
  assert.equal("devices" in validateAnnouncementAudience({ type: "all" }), false, "legacy rows keep their exact JSON");
  for (const bad of [[], ["tablet"], "desktop"]) assert.throws(() => validateAnnouncementAudience({ type: "all", devices: bad }), /devices/);
  assert.deepEqual((["web", "desktop", "mobile_web", "ios", "android", "harmonyos"] as const).map(announcementDeviceOf), ["desktop", "desktop", "mobile", "mobile", "mobile", "mobile"]);
  assert.equal(matchesAnnouncementDevices(["desktop"], "web"), true);
  assert.equal(matchesAnnouncementDevices(["desktop"], "desktop"), true);
  assert.equal(matchesAnnouncementDevices(["desktop"], "mobile_web"), false);
  assert.equal(matchesAnnouncementDevices(["desktop"], "ios"), false);
  assert.equal(matchesAnnouncementDevices(["mobile"], "mobile_web"), true);
  assert.equal(matchesAnnouncementDevices(["mobile"], "android"), true);
  assert.equal(matchesAnnouncementDevices(["mobile"], "web"), false);
  assert.equal(matchesAnnouncementDevices(["mobile"], "desktop"), false);
  assert.equal(matchesAnnouncementDevices(undefined, "ios"), true, "absent = both");
  assert.equal(matchesAnnouncementDevices(["mobile"], null), true, "unknown platform is not hidden");
});
