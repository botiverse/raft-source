import { expect } from "vitest";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { tasks, users, serverMembers } from "../db/schema";
import { createChannel, addHuman } from "../services/channelService";
import { createServer } from "../services/serverService";

const test = createApiTest();
test("historical task snapshot reads visible DB facts without AI runs or task paging", async ({ app }) => {
  const db = getDb();
  const [owner] = await db.insert(users).values({ email: "snapshot-owner@slock.test", name: "snapshot-owner", passwordHash: await fixturePasswordHash("password123"), emailVerified: true }).returning();
  const [member] = await db.insert(users).values({ email: "snapshot-member@slock.test", name: "snapshot-member", passwordHash: await fixturePasswordHash("password123"), emailVerified: true }).returning();
  const server = await createServer("Snapshot metrics", "snapshot-metrics", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const visible = await createChannel(server.id, "visible"); await addHuman(visible.id, owner.id);
  const hidden = await createChannel(server.id, "hidden", undefined, "private");
  const base = { createdByType: "user" as const, createdById: owner.id };
  await db.insert(tasks).values(Array.from({ length: 501 }, (_, i) => ({ ...base, channelId: visible.id, taskNumber: i + 1, title: `Review ${i}`, status: "in_review" as const,
    createdAt: new Date("2026-07-01T00:00:00Z"), updatedAt: new Date("2026-08-09T00:00:00Z") })));
  await db.insert(tasks).values([
    { ...base, channelId: visible.id, taskNumber: 502, title: "Done", status: "done", createdAt: new Date("2026-07-02T00:00:00Z"), updatedAt: new Date("2026-07-03T00:00:00Z"), completedAt: new Date("2026-07-03T00:00:00Z") },
    { ...base, channelId: hidden.id, taskNumber: 1, title: "Hidden", status: "done", createdAt: new Date("2026-07-01T00:00:00Z"), completedAt: new Date("2026-07-02T00:00:00Z") },
  ]);
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": server.id });
  const path = `${app.baseUrl}/api/tasks/server/snapshot-metrics`;
  const auth = headers(await tokenForHuman(owner.email));
  const response = await fetch(path, { headers: auth }); expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ total: 502, inReview: 501, done: 1, durationSamples: 1, medianHours: 24, p90Hours: 24,
    firstCreatedAt: "2026-07-01T00:00:00.000Z", latestUpdatedAt: "2026-08-09T00:00:00.000Z" });
  expect((await (await fetch(`${path}?channelId=${visible.id}`, { headers: auth })).json()).total).toBe(502);
  expect((await fetch(`${path}?channelId=${hidden.id}`, { headers: auth })).status).toBe(404);
  expect((await fetch(path, { headers: headers(await tokenForHuman(member.email)) })).status).toBe(403);
});
