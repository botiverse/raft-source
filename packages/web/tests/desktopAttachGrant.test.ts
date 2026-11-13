// Raft Desktop's one-time approval of its own machine (device-auth design v2
// §3.3), against a scripted server: what is asked for, that only the explicit
// server is approved, that only a dvat_ answer for that server is taken, and
// the older-server fallback (nothing approved).
import assert from "node:assert/strict";
import { obtainDesktopAttachToken } from "../src/components/machine/localComputer/desktopAttachGrant";
import type { AttachGrantPost } from "../src/components/machine/localComputer/desktopAttachGrant";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "dvat_secretAttachToken0123456789";
const MACHINE = { machineName: "studio-mac", hostname: "studio-mac.local", os: "macOS" };

type Reply = { status: number; data: unknown };

function script(replies: Partial<Record<string, Reply | Reply[]>>) {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const seen: Record<string, number> = {};
  const post: AttachGrantPost = async (url, body) => {
    posts.push({ url, body });
    const r = replies[url];
    if (!r) throw new Error(`unexpected ${url}`);
    const list = Array.isArray(r) ? r : [r];
    const i = seen[url] ?? 0;
    seen[url] = i + 1;
    return list[Math.min(i, list.length - 1)]!;
  };
  return { post, posts };
}

const AUTHORIZE: Reply = { status: 201, data: { deviceCode: "dvc_1", userCode: "ABCD-1234", interval: 1 } };
const DESCRIBE: Reply = {
  status: 200,
  data: {
    userCode: "ABCD-1234",
    approvalTicket: "ticket-1",
    grant: { kind: "computer_attach", ...MACHINE, servers: [{ id: OTHER_ID, slug: "beta", name: "Beta" }, { id: SERVER_ID, slug: "acme", name: "Acme" }] },
  },
};
const APPROVE: Reply = { status: 200, data: { ok: true } };
const TOKEN_REPLY: Reply = { status: 200, data: { kind: "computer_attach", attachToken: TOKEN, serverId: SERVER_ID, serverSlug: "acme", serverName: "Acme" } };
const noSleep = { sleep: async () => {} };

async function rejectsWith(run: () => Promise<unknown>, message: RegExp): Promise<Error> {
  let thrown: unknown;
  try { await run(); } catch (err) { thrown = err; }
  assert.ok(thrown instanceof Error, "expected a rejection");
  assert.match(thrown.message, message);
  assert.doesNotMatch(thrown.message, /dvat_|dvc_|ticket-1/, "an error never carries a secret");
  return thrown;
}

test("asks for a computer_attach grant, approves the explicit server id with the ticket, returns the dvat_ token", async () => {
  const { post, posts } = script({
    "/auth/device/authorize": AUTHORIZE, "/auth/device/describe": DESCRIBE, "/auth/device/approve": APPROVE,
    "/auth/device/token": [{ status: 400, data: { code: "authorization_pending" } }, TOKEN_REPLY],
  });
  const result = await obtainDesktopAttachToken(post, { serverSlug: "/acme", ...MACHINE }, noSleep);
  assert.deepEqual(result, { kind: "token", attachToken: TOKEN, serverId: SERVER_ID, serverSlug: "acme" });
  assert.deepEqual(posts.map((p) => p.url), ["/auth/device/authorize", "/auth/device/describe", "/auth/device/approve", "/auth/device/token", "/auth/device/token"]);
  assert.deepEqual(posts[0]!.body, { clientName: "Raft Desktop", grant: { kind: "computer_attach", ...MACHINE } });
  assert.deepEqual(posts[1]!.body, { userCode: "ABCD-1234" });
  assert.deepEqual(posts[2]!.body, { userCode: "ABCD-1234", approve: true, approvalTicket: "ticket-1", serverId: SERVER_ID });
  assert.deepEqual(posts[3]!.body, { deviceCode: "dvc_1" });
});

test("an older server (describe has no grant): the code is denied, nothing approved, legacy_server", async () => {
  const { post, posts } = script({
    "/auth/device/authorize": AUTHORIZE,
    "/auth/device/describe": { status: 200, data: { userCode: "ABCD-1234" } },
    "/auth/device/approve": APPROVE,
  });
  assert.deepEqual(await obtainDesktopAttachToken(post, { serverSlug: "acme", ...MACHINE }, noSleep), { kind: "legacy_server" });
  assert.deepEqual(posts.map((p) => p.url), ["/auth/device/authorize", "/auth/device/describe", "/auth/device/approve"]);
  assert.deepEqual(posts[2]!.body, { userCode: "ABCD-1234", approve: false });
});

test("device login turned off on a current server (the kill switch): fails closed, never the session copy", async () => {
  const { post, posts } = script({ "/auth/device/authorize": { status: 404, data: { code: "device_login_disabled" } } });
  await rejectsWith(() => obtainDesktopAttachToken(post, { serverSlug: "acme", ...MACHINE }, noSleep), /device_login_disabled/);
  assert.equal(posts.length, 1);
});

test("a server without the device flow (404 at authorize): legacy_server, nothing else asked", async () => {
  const { post, posts } = script({ "/auth/device/authorize": { status: 404, data: {} } });
  assert.deepEqual(await obtainDesktopAttachToken(post, { serverSlug: "acme", ...MACHINE }, noSleep), { kind: "legacy_server" });
  assert.equal(posts.length, 1);
});

test("a server this person may not add computers to: denied, never approved, reads as admin required", async () => {
  const { post, posts } = script({ "/auth/device/authorize": AUTHORIZE, "/auth/device/describe": DESCRIBE, "/auth/device/approve": APPROVE });
  await rejectsWith(() => obtainDesktopAttachToken(post, { serverSlug: "gamma", ...MACHINE }, noSleep), /requires_admin/);
  assert.deepEqual(posts.filter((p) => p.url === "/auth/device/approve").map((p) => p.body), [{ userCode: "ABCD-1234", approve: false }]);
});

test("a token answer that is a session, for another server, or not a dvat_ token is never taken", async () => {
  for (const bad of [
    { status: 200, data: { accessToken: "a", refreshToken: "r", userId: "u" } },
    { status: 200, data: { ...(TOKEN_REPLY.data as object), serverId: OTHER_ID } },
    { status: 200, data: { ...(TOKEN_REPLY.data as object), serverSlug: "beta" } },
    { status: 200, data: { ...(TOKEN_REPLY.data as object), attachToken: "eyJ.session" } },
  ]) {
    const { post } = script({ "/auth/device/authorize": AUTHORIZE, "/auth/device/describe": DESCRIBE, "/auth/device/approve": APPROVE, "/auth/device/token": bad });
    await rejectsWith(() => obtainDesktopAttachToken(post, { serverSlug: "acme", ...MACHINE }, noSleep), /attach_grant_failed:unexpected_response/);
  }
});

test("approve refused (the person lost the role meanwhile): admin required; token never polled", async () => {
  const { post, posts } = script({
    "/auth/device/authorize": AUTHORIZE, "/auth/device/describe": DESCRIBE,
    "/auth/device/approve": { status: 403, data: { code: "grant_selection_not_allowed" } },
  });
  await rejectsWith(() => obtainDesktopAttachToken(post, { serverSlug: "acme", ...MACHINE }, noSleep), /requires_admin/);
  assert.ok(!posts.some((p) => p.url === "/auth/device/token"));
});

test("a token poll that never completes stops after a few tries", async () => {
  const { post, posts } = script({
    "/auth/device/authorize": AUTHORIZE, "/auth/device/describe": DESCRIBE, "/auth/device/approve": APPROVE,
    "/auth/device/token": { status: 400, data: { code: "authorization_pending" } },
  });
  await rejectsWith(() => obtainDesktopAttachToken(post, { serverSlug: "acme", ...MACHINE }, noSleep), /token_timeout/);
  assert.equal(posts.filter((p) => p.url === "/auth/device/token").length, 5);
});
