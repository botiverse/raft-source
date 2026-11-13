// Member labels (#wg-rbac:#46): where someone is from and which role the
// hover card may write. Pure rules; every surface reads them the same way.
import assert from "node:assert/strict";
import {
  LOCAL_MEMBER_ORIGIN,
  hoverCardRoleLabelId,
  isViewerServerGuest,
  memberOrigin,
  originServerNames,
} from "../src/utils/memberOrigin";

const BOTIVERSE = "server-botiverse";
const ACME = { id: "server-acme", name: "Acme Corp", slug: "acme" };
const LUMEN = { id: "server-lumen", name: "Lumen Labs", slug: "lumen" };

test("a member of the viewed server is not external, with or without a server id", () => {
  assert.equal(memberOrigin({}, BOTIVERSE), LOCAL_MEMBER_ORIGIN);
  assert.equal(memberOrigin({ serverId: BOTIVERSE, serverName: "Botiverse" }, BOTIVERSE), LOCAL_MEMBER_ORIGIN);
  assert.equal(memberOrigin(null, BOTIVERSE), LOCAL_MEMBER_ORIGIN);
});

test("no viewed server: nobody is marked (nothing to compare with, and nothing is guessed)", () => {
  assert.equal(memberOrigin({ serverId: ACME.id, serverName: ACME.name }, null), LOCAL_MEMBER_ORIGIN);
});

test("another server's member is external and names that server", () => {
  const origin = memberOrigin({ serverId: ACME.id, serverName: ACME.name, serverSlug: ACME.slug }, BOTIVERSE);
  assert.equal(origin.external, true);
  assert.deepEqual(origin.servers, [{ id: ACME.id, name: ACME.name }]);
  assert.equal(originServerNames(origin), "Acme Corp");
});

test("a person in two other servers names both, the viewed server left out", () => {
  const origin = memberOrigin(
    { serverId: ACME.id, servers: [{ id: BOTIVERSE, name: "Botiverse", slug: "botiverse" }, ACME, LUMEN] },
    BOTIVERSE,
  );
  assert.equal(originServerNames(origin), "Acme Corp, Lumen Labs");
});

test("the roster's inViewerServer is the answer when it is sent, over the row's own server id", () => {
  // A member of the viewed server who is also in Acme: not external.
  assert.equal(memberOrigin({ serverId: ACME.id, servers: [ACME], inViewerServer: true }, BOTIVERSE), LOCAL_MEMBER_ORIGIN);
  // Sent as not the viewed server's, with no single server id.
  const origin = memberOrigin({ servers: [ACME, LUMEN], inViewerServer: false }, BOTIVERSE);
  assert.equal(origin.external, true);
  assert.equal(originServerNames(origin), "Acme Corp, Lumen Labs");
});

test("a member built from a roster row carries the same facts under `roster`", () => {
  const origin = memberOrigin({ roster: { servers: [ACME, LUMEN], inViewerServer: false } }, BOTIVERSE);
  assert.equal(origin.external, true);
  assert.equal(originServerNames(origin), "Acme Corp, Lumen Labs");
  assert.equal(memberOrigin({ roster: { servers: [ACME], inViewerServer: true } }, BOTIVERSE), LOCAL_MEMBER_ORIGIN);
});

test("an older roster row with only its own serverId, kept under `roster`, reads the same as on the row", () => {
  const origin = memberOrigin({ roster: { serverId: ACME.id, serverName: ACME.name } }, BOTIVERSE);
  assert.deepEqual(origin, { external: true, servers: [{ id: ACME.id, name: ACME.name }] });
  assert.equal(memberOrigin({ roster: { serverId: BOTIVERSE } }, BOTIVERSE), LOCAL_MEMBER_ORIGIN);
});

test("a bare server id is named from the conversation's connected servers, else stays unnamed", () => {
  const named = memberOrigin({ serverId: LUMEN.id }, BOTIVERSE, [{ serverId: LUMEN.id, serverName: LUMEN.name }]);
  assert.deepEqual(named.servers, [{ id: LUMEN.id, name: LUMEN.name }]);
  const unnamed = memberOrigin({ serverId: LUMEN.id }, BOTIVERSE);
  assert.equal(unnamed.external, true, "still external: no model, no role, no Guest");
  assert.deepEqual(unnamed.servers, []);
});

test("a server without a name falls back to its slug", () => {
  const origin = memberOrigin({ serverId: ACME.id, serverName: null, serverSlug: "acme" }, BOTIVERSE);
  assert.equal(originServerNames(origin), "acme");
});

test("hover card role: people write Owner, Admin and Guest; Member is not written", () => {
  assert.equal(hoverCardRoleLabelId("human", "owner", LOCAL_MEMBER_ORIGIN), "member.role.owner");
  assert.equal(hoverCardRoleLabelId("human", "admin", LOCAL_MEMBER_ORIGIN), "member.role.admin");
  assert.equal(hoverCardRoleLabelId("human", "guest", LOCAL_MEMBER_ORIGIN), "member.detail.roleGuest");
  assert.equal(hoverCardRoleLabelId("human", "member", LOCAL_MEMBER_ORIGIN), null);
});

test("hover card role: an agent's is written only when it is an Admin", () => {
  assert.equal(hoverCardRoleLabelId("agent", "admin", LOCAL_MEMBER_ORIGIN), "member.role.admin");
  assert.equal(hoverCardRoleLabelId("agent", "member", LOCAL_MEMBER_ORIGIN), null);
  assert.equal(hoverCardRoleLabelId("agent", "owner", LOCAL_MEMBER_ORIGIN), null);
});

test("hover card role: never for another server's, never for a role that was not sent", () => {
  const external = memberOrigin({ serverId: ACME.id, serverName: ACME.name }, BOTIVERSE);
  for (const role of ["owner", "admin", "guest", "member"] as const) {
    assert.equal(hoverCardRoleLabelId("human", role, external), null, role);
    assert.equal(hoverCardRoleLabelId("agent", role, external), null, role);
  }
  assert.equal(hoverCardRoleLabelId("human", null, LOCAL_MEMBER_ORIGIN), null);
  assert.equal(hoverCardRoleLabelId("human", undefined, LOCAL_MEMBER_ORIGIN), null);
});

test("Guest in a row is the viewed server's only", () => {
  const external = memberOrigin({ serverId: ACME.id, serverName: ACME.name }, BOTIVERSE);
  assert.equal(isViewerServerGuest("guest", LOCAL_MEMBER_ORIGIN), true);
  assert.equal(isViewerServerGuest("guest", external), false);
  assert.equal(isViewerServerGuest("member", LOCAL_MEMBER_ORIGIN), false);
  assert.equal(isViewerServerGuest(null, LOCAL_MEMBER_ORIGIN), false);
});
