import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { serverMembers } from "../db/schema";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest();

const LAYOUT = { v: 1, columns: [{ sections: ["thread", "tasks"], width: 420 }, { sections: ["files"], width: 300 }] };

test("the channel side layout (task #165): unset at first, saved by PATCH, read back; null clears it; an invalid one is refused; a stored one that doesn't parse reads as unset", async ({ app }) => {
  const owner = await seedUser("side-layout-owner@slock.test", "side-layout-owner");
  const server = await createServer("Side Layout Server", "side-layout-server", owner.id);
  const token = await tokenForHuman(owner.email);
  const url = `${app.baseUrl}/api/servers/${server.id}/sidebar-order`;
  const get = async () => {
    const res = await fetch(url, { headers: headers(token, server.id) });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json() as { channelSideLayout: unknown }).channelSideLayout;
  };
  const patch = (body: unknown) => fetch(url, { method: "PATCH", headers: headers(token, server.id), body: JSON.stringify(body) });

  assert.equal(await get(), null);

  // The layout alone is a whole update.
  const saved = await patch({ channelSideLayout: LAYOUT });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.deepEqual((await saved.json() as { channelSideLayout: unknown }).channelSideLayout, LAYOUT);
  assert.deepEqual(await get(), LAYOUT);

  for (const invalid of [
    { v: 2, columns: LAYOUT.columns },
    { v: 1, columns: [{ sections: ["thread", "thread"], width: 400 }] },
    { v: 1, columns: [{ sections: ["chat"], width: 400 }] },
    { v: 1, columns: [{ sections: ["thread"], width: 10 }] },
    "thread",
  ]) {
    const res = await patch({ channelSideLayout: invalid });
    assert.equal(res.status, 400, JSON.stringify(invalid));
  }
  assert.deepEqual(await get(), LAYOUT, "a refused layout changes nothing");

  // Another field's update leaves it as it was.
  assert.equal((await patch({ channelPanelTabOrder: ["files", "chat", "tasks"] })).status, 200);
  assert.deepEqual(await get(), LAYOUT);

  assert.equal((await patch({ channelSideLayout: null })).status, 200);
  assert.equal(await get(), null);

  await getDb().update(serverMembers)
    .set({ channelSideLayout: { v: 1, columns: "nope" } as never })
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));
  assert.equal(await get(), null, "lenient read");
});

test("the context view (View Context) is a section of the layout: PATCH accepts a layout with it, stacked or in a column of its own, and reads it back; the retired execution record (\"record\") is dropped", async ({ app }) => {
  const owner = await seedUser("side-layout-context@slock.test", "side-layout-context");
  const server = await createServer("Side Layout Context Server", "side-layout-context-server", owner.id);
  const token = await tokenForHuman(owner.email);
  const url = `${app.baseUrl}/api/servers/${server.id}/sidebar-order`;
  const patch = (body: unknown) => fetch(url, { method: "PATCH", headers: headers(token, server.id), body: JSON.stringify(body) });
  const read = async () => (await (await fetch(url, { headers: headers(token, server.id) })).json() as { channelSideLayout: unknown }).channelSideLayout;
  for (const layout of [
    { v: 1, columns: [{ sections: ["thread"], width: 400 }, { sections: ["tasks", "files"], width: 360 }, { sections: ["artifact"], width: 480 }, { sections: ["profile", "context"], width: 400 }] },
    { v: 1, columns: [{ sections: ["thread"], width: 400 }, { sections: ["context"], width: 480 }] },
  ]) {
    const res = await patch({ channelSideLayout: layout });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await read(), layout);
  }
  const contextTwice = await patch({ channelSideLayout: { v: 1, columns: [{ sections: ["context"], width: 360 }, { sections: ["profile", "context"], width: 400 }] } });
  assert.equal(contextTwice.status, 400, "the context view twice");
  // An older tab still saving the execution record's section: saved without it.
  const withRecord = await patch({ channelSideLayout: { v: 1, columns: [{ sections: ["thread"], width: 400 }, { sections: ["profile", "record", "context"], width: 400 }, { sections: ["record"], width: 360 }] } });
  assert.equal(withRecord.status, 200, await withRecord.clone().text());
  assert.deepEqual(await read(), { v: 1, columns: [{ sections: ["thread"], width: 400 }, { sections: ["profile", "context"], width: 400 }] });
});
