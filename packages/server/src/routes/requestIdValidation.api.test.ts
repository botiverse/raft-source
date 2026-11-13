// Ids taken from a request are checked for shape before they reach a query or
// a storage key: a server id that is no UUID is answered as a server the
// caller isn't in (not a 500 from the membership query), and an avatar
// namespace outside the ones avatars are written under names no avatar.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { createServer, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("a server id that is no UUID is answered as a server the caller isn't in", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const user = await seedUser(`riv-${suffix}@slock.test`, `riv-${suffix}`);
  await createServer("Request Id Validation", `riv-${suffix}`, user.id);
  const token = await tokenForHuman(user.email);
  const ask = (path: string, serverId: string) => fetch(`${app.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverId },
  }).then(async (res) => ({ status: res.status, body: await res.text() }));
  for (const path of ["/api/channels", "/api/agents", "/api/tasks/server"]) {
    const unknown = await ask(path, randomUUID());
    assert.equal(unknown.status, 403, `${path}: an unknown server`);
    for (const bad of ["not-a-uuid", "1' or '1'='1", "../x", `${randomUUID()}x`]) {
      assert.deepEqual(await ask(path, bad), unknown, `${path} with X-Server-Id ${JSON.stringify(bad)}`);
    }
  }
});

test("an avatar namespace outside the written ones names no avatar", async ({ app }) => {
  for (const namespace of ["..%2F..%2Fsecrets", "%2E%2E", "thumbs", "users%2F..%2F.."]) {
    const res = await fetch(`${app.baseUrl}/api/avatars/${namespace}/abcdef.webp`);
    assert.equal(res.status, 404, namespace);
  }
});
