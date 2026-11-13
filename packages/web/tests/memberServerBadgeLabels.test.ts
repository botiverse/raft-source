import assert from "node:assert/strict";
import { memberServerBadgeLabels } from "../src/utils/channelLocalMembership";

// RFC 075 phase 1: a joint roster member is badged with every server they
// take part through, viewed server first, unless they are purely local.
const home = { id: "home", name: "Home", slug: "home" };
const peer = { id: "peer", name: "Peer", slug: "peer-slug" };

test("a person on both sides of a joint channel shows both servers", () => {
  assert.deepEqual(
    memberServerBadgeLabels({ serverId: "home", serverName: "Home", servers: [home, peer] }, "home"),
    ["Home", "Peer"],
  );
});

test("a purely local member shows no badge", () => {
  assert.deepEqual(memberServerBadgeLabels({ serverId: "home", servers: [home] }, "home"), []);
  assert.deepEqual(memberServerBadgeLabels({ serverId: "home", serverName: "Home" }, "home"), []);
});

test("a peer-only member shows the peer, falling back to the legacy single fields", () => {
  assert.deepEqual(memberServerBadgeLabels({ serverId: "peer", servers: [peer] }, "home"), ["Peer"]);
  assert.deepEqual(memberServerBadgeLabels({ serverId: "peer", serverName: null, serverSlug: "peer-slug" }, "home"), ["peer-slug"]);
});

test("no viewer server or no server facts means no badge", () => {
  assert.deepEqual(memberServerBadgeLabels({ servers: [peer] }, null), []);
  assert.deepEqual(memberServerBadgeLabels({}, "home"), []);
});

test("an empty servers list is the server's answer: no badge, not the single fields", () => {
  // #wg-rbac:#58: a profile opened from a channel that lists the person
  // through no server.
  assert.deepEqual(memberServerBadgeLabels({ serverId: "peer", serverName: "Peer", servers: [] }, "home"), []);
});
