/** store/localTables/storeWriters: lists reach the tables only for the person they were loaded for. */
import assert from "node:assert/strict";
import { channelsTable, serversTable } from "../src/store/localTables";
import { localTableSession, writeChannelList, writeServerList } from "../src/store/localTables/storeWriters";
import type { Server } from "../src/store/serverStore";
import type { Channel } from "../src/store/channelStore";

function token(sub: string) {
  const payload = Buffer.from(JSON.stringify({ type: "access", sub })).toString("base64url");
  return `h.${payload}.s`;
}

const stored = new Map<string, string>();
beforeAll(() => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
  };
});
afterAll(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

test("a list loaded for one person is not written once another has signed in", () => {
  stored.set("slock_access_token", token("u1"));
  const session = localTableSession();
  assert.equal(session, "u1");
  stored.set("slock_access_token", token("u2"));
  writeServerList(session, [{ id: "s1" } as Server]);
  writeChannelList(session, "s1", [{ id: "c1" } as Channel]);
  assert.equal(serversTable.freshness({ userId: "u1" }), "empty");
  assert.equal(serversTable.freshness({ userId: "u2" }), "empty");
  assert.equal(channelsTable.get({ userId: "u2", serverId: "s1" }, "c1"), undefined);
});

test("the same person's list is written as a full list", () => {
  stored.set("slock_access_token", token("u3"));
  const session = localTableSession();
  writeServerList(session, [{ id: "s1" } as Server]);
  writeChannelList(session, "s1", [{ id: "c1" } as Channel]);
  assert.equal(serversTable.freshness({ userId: "u3" }), "fresh");
  assert.equal(channelsTable.get({ userId: "u3", serverId: "s1" }, "c1")?.id, "c1");
});

test("no stored session writes nothing", () => {
  stored.delete("slock_access_token");
  assert.equal(localTableSession(), null);
  writeServerList(null, [{ id: "s1" } as Server]);
  assert.deepEqual(serversTable.scopesOf("null"), []);
});
