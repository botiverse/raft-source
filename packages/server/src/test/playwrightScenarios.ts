import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { eq, inArray } from "drizzle-orm";
import { Router } from "express";
import type { Router as RouterType } from "express";
import { getDb } from "../db/index.js";
import { announcements, channels, servers, serverMembers, users, userAnnouncementDismissals } from "../db/schema.js";
import { addMember, createServer } from "../services/serverService.js";
import { getOrCreateThread } from "../services/channelService.js";
import { createMessage } from "../services/messageService.js";

/** Per-attempt tenants in the disposable Playwright database. No production mount. */
export function playwrightScenarios(capability: string): RouterType {
  const router = Router();
  const owned = new Map<string, string[]>();
  const password = randomUUID();
  const passwordHash = argon2.hash(password);

  async function remove(serverId: string, userIds: string[]) {
    const db = getDb();
    // Hard deletion is confined to this ephemeral database and a server created
    // by this registry. Never accept an arbitrary server/user id from a test.
    await db.delete(servers).where(eq(servers.id, serverId));
    await db.delete(users).where(inArray(users.id, userIds));
    owned.delete(serverId);
  }

  router.use("/__playwright/scenarios", (req, res, next) => {
    if (req.get("Authorization") !== `Bearer ${capability}`) {
      res.sendStatus(403);
      return;
    }
    next();
  });
  router.post("/__playwright/scenarios", async (_req, res) => {
    const db = getDb();
    const name = `e2e-${randomUUID().slice(0, 12)}`;
    const email = `${name}@slock.test`;
    let userIds: string[] = [];
    let serverId: string | undefined;
    try {
      const hash = await passwordHash;
      const [owner, peer] = await db.insert(users).values([name, `${name}-peer`].map((userName) => ({
        name: userName, email: `${userName}@slock.test`, displayName: userName, passwordHash: hash,
        emailVerified: true,
        profileSetupCompletedAt: new Date(),
        signupSurveyCompletedAt: new Date(),
        firstOnboardingCompletedAt: new Date(),
        referralSourceSkippedAt: new Date(),
      }))).returning();
      userIds = [owner.id, peer.id];
      const server = await createServer(name, name, owner.id);
      serverId = server.id;
      owned.set(server.id, userIds);
      await addMember(server.id, peer.id, "member");
      // Match the established legacy owner fixture. Onboarding has its own
      // tests; scenario consumers exercise messaging and sidebar behavior.
      await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
      await db.update(serverMembers).set({
        setupStatus: "complete", setupCompletionReason: "grandfathered",
        setupModalReminderOptOut: true,
        dismissedAddComputerStepAt: new Date(), dismissedCreateAgentStepAt: new Date(),
        dismissedCommunityStepAt: new Date(), dismissedNotificationStepAt: new Date(),
      }).where(inArray(serverMembers.userId, userIds));
      const active = await db.select({ id: announcements.id }).from(announcements);
      if (active.length) {
        await db.insert(userAnnouncementDismissals).values(userIds.flatMap((userId) => active.map(({ id }) => ({
          userId, announcementId: id,
        }))));
      }
      const [channel] = await db.select({ id: channels.id, name: channels.name })
        .from(channels).where(eq(channels.serverId, server.id));
      if (!channel) throw new Error("Scenario has no default channel");
      res.json({ user: { name, email, password }, server: {
        id: server.id, name: server.name, slug: server.slug,
      }, channel, peer: { id: peer.id, name: peer.name, email: peer.email, password } });
    } catch (error) {
      if (serverId && userIds.length) await remove(serverId, userIds);
      else if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
      console.error("[playwright-scenario] create failed", error);
      res.sendStatus(500);
    }
  });
  router.delete("/__playwright/scenarios/:id", async (req, res) => {
    const userIds = owned.get(req.params.id);
    if (!userIds) { res.sendStatus(404); return; }
    try {
      await remove(req.params.id, userIds);
      res.sendStatus(204);
    } catch (error) {
      console.error("[playwright-scenario] cleanup failed", error);
      res.sendStatus(500);
    }
  });
  router.post("/__playwright/scenarios/:id/thread-window", async (req, res) => {
    const userIds = owned.get(req.params.id);
    if (!userIds) { res.sendStatus(404); return; }
    try {
      const [channel] = await getDb().select({ id: channels.id }).from(channels)
        .where(eq(channels.serverId, req.params.id));
      const olderNeedle = `lazy-hydration-older-only-${randomUUID()}`;
      // Search tests need history, not 128 repetitions of the HTTP send path.
      // Keep real message/thread services (searchText, seq, parent linkage).
      const parent = await createMessage(channel.id, "user", userIds[0], "thread search lazy parent");
      const thread = await getOrCreateThread(parent.id, userIds[0], "user");
      let newerReplyId = "";
      const replyCount = 128;
      for (let i = 0; i < replyCount; i += 1) {
        const reply = await createMessage(thread.id, "user", userIds[0], i === 0
          ? `older hidden match \`${olderNeedle}\``
          : `thread search lazy filler ${i}`);
        newerReplyId = reply.id;
      }
      res.json({ parentId: parent.id, threadChannelId: thread.id, olderNeedle,
        newerReplyId, totalMessageRows: replyCount + 1 });
    } catch (error) {
      console.error("[playwright-scenario] thread seed failed", error);
      res.sendStatus(500);
    }
  });
  return router;
}
