import { expect } from "vitest";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { tasks, users, serverMembers } from "../db/schema";
import { createChannel, addHuman } from "../services/channelService";
import { createServer } from "../services/serverService";
const test = createApiTest();
test("period metrics aggregate beyond the page cap, preserve admin/channel ACL and reject invalid windows", async ({ app }) => {
  const db = getDb();
  const [owner] = await db.insert(users).values({ email: "period-owner@slock.test", name: "period-owner", passwordHash: await fixturePasswordHash("password123"), emailVerified: true }).returning();
  const [member] = await db.insert(users).values({ email: "period-member@slock.test", name: "period-member", passwordHash: await fixturePasswordHash("password123"), emailVerified: true }).returning();
  const server = await createServer("Period metrics", "period-metrics", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const a = await createChannel(server.id, "alpha"); await addHuman(a.id, owner.id);
  const b = await createChannel(server.id, "zulu"); await addHuman(b.id, owner.id);
  const hidden = await createChannel(server.id, "hidden", undefined, "private");
  await db.insert(tasks).values({ channelId: hidden.id, taskNumber: 1, title: "Hidden current task", createdByType: "user", createdById: owner.id, status: "done", createdAt: new Date("2026-10-10T00:00:00Z"), completedAt: new Date("2026-10-11T00:00:00Z") });
  await db.insert(tasks).values(Array.from({ length: 1001 }, (_, i) => ({ channelId: a.id, taskNumber: i + 1, title: `Old task ${i}`, createdByType: "user" as const, createdById: owner.id, status: "done" as const, createdAt: new Date("2026-09-01T00:00:00Z"), completedAt: new Date("2026-09-02T00:00:00Z") })));
  await db.insert(tasks).values([
    { channelId: b.id, taskNumber: 1, title: "Current", createdByType: "user", createdById: owner.id, status: "done", createdAt: new Date("2026-10-10T00:00:00Z"), completedAt: new Date("2026-10-11T00:00:00Z") },
    { channelId: b.id, taskNumber: 2, title: "Previous", createdByType: "user", createdById: owner.id, status: "done", createdAt: new Date("2026-10-08T00:00:00Z"), completedAt: new Date("2026-10-10T00:00:00Z") },
    { channelId: b.id, taskNumber: 3, title: "Today", createdByType: "user", createdById: owner.id, status: "done", createdAt: new Date("2026-10-10T00:00:00Z"), completedAt: new Date("2026-10-18T00:00:00Z") },
  ]);
  const header = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": server.id });
  const auth = header(await tokenForHuman(owner.email));
  const query = "from=2026-10-04T00:00:00Z&midpoint=2026-10-11T00:00:00Z&to=2026-10-18T00:00:00Z";
  const path = `${app.baseUrl}/api/tasks/server/period-metrics?${query}`;
  const res = await fetch(path, { headers: auth }); expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.current).toEqual({ completed: 1, durationSamples: 1, meanHours: 24, medianHours: 24 });
  expect(body.previous).toEqual({ completed: 1, durationSamples: 1, meanHours: 48, medianHours: 48 });
  const scoped = await fetch(`${path}&channelId=${a.id}`, { headers: auth }); expect((await scoped.json()).current.completed).toBe(0);
  expect((await fetch(path, { headers: header(await tokenForHuman(member.email)) })).status).toBe(403);
  expect((await fetch(`${path}&channelId=${hidden.id}`, { headers: auth })).status).toBe(404);
  expect((await fetch(`${path}&channelId=not-a-uuid`, { headers: auth })).status).toBe(400);
  expect((await fetch(path.replace("2026-10-04", "2026-10-05"), { headers: auth })).status).toBe(400);
});
