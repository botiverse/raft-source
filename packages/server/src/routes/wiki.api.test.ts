import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import {
  hydrateRuntimeConfig,
  MIN_WIKI_DAEMON_VERSION,
  WIKI_AGENT_WORKSPACE_ENABLED,
  WIKI_AGENT_WORKSPACE_ENV,
  WIKI_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import {
  agents,
  channels,
  featureFlagRules, messages, reminders,
  users,
  wikiBindings
} from "../db/schema.js";
import { signAccessToken } from "../middleware/auth.js";
import { WIKI_AGENT_WORKSPACE_PACK } from "../generated/wikiAgentWorkspacePack.js";
import { createChannel, addHuman, isChannelAgent } from "../services/channelService.js";
import { createAgent, deleteAgent } from "../services/agentService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { createMessage } from "../services/messageService.js";
import { createServer, addMember } from "../services/serverService.js";
import {
  __setStorageForTests,
  getStorage,
  resetStorageForTests,
  type StorageBackend,
} from "../services/storageService.js";
import { publishWikiAgentManifest } from "../services/wikiService.js";
import {
  wikiManifestKey,
  wikiRevisionKey,
  type WikiManifest,
  type WikiManifestArtifact,
} from "../services/wikiManifestService.js";
import { openTestApp } from "../test/integration/app.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function createVerifiedUser(email: string, name: string) {
  const [user] = await getDb()
    .insert(users)
    .values({
      email,
      name,
      displayName: name,
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    })
    .returning();
  return user;
}

function authHeaders(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
    "Content-Type": "application/json",
  };
}

async function markWikiInitializing(serverId: string): Promise<void> {
  await getDb()
    .update(wikiBindings)
    .set({ status: "initializing", updatedAt: new Date() })
    .where(eq(wikiBindings.serverId, serverId));
}

function agentAuthHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

const WIKI_WORKSPACE_RECEIPT_FILES = WIKI_AGENT_WORKSPACE_PACK.files.map(
  ({ relativePath, sha256, size }) => ({ relativePath, sha256, size }),
);

function stubWikiWorkspaceSetup(
  app: Awaited<ReturnType<typeof openTestApp>>,
  options: {
    daemonVersion?: string | null;
    supportsPack?: boolean;
  } = {},
) {
  const daemonVersion = options.daemonVersion === undefined
    ? MIN_WIKI_DAEMON_VERSION
    : options.daemonVersion;
  const supportsPack = options.supportsPack ?? true;
  const orchestrator = app.app.get("agentOrchestrator") as {
    getAgentDaemonVersion(agentId: string): Promise<string | null>;
    agentSupportsWikiWorkspacePack(agentId: string): Promise<boolean>;
    ensureWikiAgentWorkspace(agentId: string): Promise<{
      agentId: string;
      packId: string;
      files: typeof WIKI_WORKSPACE_RECEIPT_FILES;
    }>;
    pushReminderUpsert(agentId: string, reminder: unknown): Promise<void>;
    pushReminderCancel(agentId: string, reminderId: string, version: number): Promise<void>;
  };
  orchestrator.getAgentDaemonVersion = async () => daemonVersion;
  orchestrator.agentSupportsWikiWorkspacePack = async () => supportsPack;
  orchestrator.ensureWikiAgentWorkspace = async (agentId) => ({
    agentId,
    packId: WIKI_AGENT_WORKSPACE_PACK.packId,
    files: WIKI_WORKSPACE_RECEIPT_FILES,
  });
  orchestrator.pushReminderUpsert = async () => {};
  orchestrator.pushReminderCancel = async () => {};
  return orchestrator;
}

async function createWikiFixture(options: { enableWiki?: boolean } = {}) {
  const owner = await createVerifiedUser(`wiki-owner-${randomUUID()}@slock.test`, "Wiki Owner");
  const member = await createVerifiedUser(`wiki-member-${randomUUID()}@slock.test`, "Wiki Member");
  const server = await createServer("Wiki Server", `wiki-server-${randomUUID()}`, owner.id);
  if (options.enableWiki !== false) {
    await getDb().insert(featureFlagRules).values({
      flagKey: WIKI_FEATURE_FLAG_KEY,
      stage: "server",
      decision: "allow",
      values: [server.id],
    });
  }
  await addMember(server.id, member.id, "member");
  const channel = await createChannel(server.id, "wiki", "Company Wiki");
  await addHuman(channel.id, owner.id);
  const agent = await createAgent(server.id, "WikiAgent", {
    description: "Maintains the server Wiki.",
    creatorType: "user",
    creatorId: owner.id,
  });
  return {
    owner,
    member,
    server,
    channel,
    agent,
    ownerToken: signAccessToken(owner.id),
    memberToken: signAccessToken(member.id),
  };
}

function sha256(markdown: string): string {
  return createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex");
}

function manifestArtifact(input: {
  serverId: string;
  type: WikiManifestArtifact["artifactType"];
  slug: string;
  markdown: string;
}): WikiManifestArtifact {
  const id = randomUUID();
  const revisionId = randomUUID();
  return {
    id,
    artifactType: input.type,
    slug: input.slug,
    title: input.slug === "index" ? "Wiki Index" : input.slug === "log" ? "Wiki Log" : "Architecture",
    summary: "Summary",
    currentUnderstanding: "Current understanding",
    status: "current",
    confidence: "high",
    sourcePolicy: "cached_summary",
    sourceRefs: [],
    revision: {
      id: revisionId,
      key: wikiRevisionKey(input.serverId, id, revisionId),
      sha256: sha256(input.markdown),
      bytes: Buffer.byteLength(input.markdown),
    },
    updatedAt: "2026-07-25T15:00:00.000Z",
  };
}

function buildManifest(input: {
  serverId: string;
  wikiSpaceId: string;
  agentId: string;
}) {
  const markdown = {
    index: "# Wiki Index\n",
    log: "# Wiki Log\n",
    page: "# Architecture\n",
  };
  const index = manifestArtifact({
    serverId: input.serverId,
    type: "index",
    slug: "index",
    markdown: markdown.index,
  });
  const log = manifestArtifact({
    serverId: input.serverId,
    type: "log",
    slug: "log",
    markdown: markdown.log,
  });
  const page = manifestArtifact({
    serverId: input.serverId,
    type: "page",
    slug: "architecture",
    markdown: markdown.page,
  });
  const manifest: WikiManifest = {
    schemaVersion: 1,
    serverId: input.serverId,
    wikiSpaceId: input.wikiSpaceId,
    revision: 1,
    coverage: {},
    publishedAt: "2026-07-25T15:00:00.000Z",
    publishedByAgentId: input.agentId,
    index,
    log,
    pages: [page],
    lastIngest: {
      receiptId: randomUUID(),
      added: [],
      outcome: "published",
      publishedAt: "2026-07-25T15:00:00.000Z",
    },
    lastLint: null,
  };
  return { manifest, markdown };
}

function revisionBodiesFor(
  built: ReturnType<typeof buildManifest>,
) {
  return [
    {
      artifactId: built.manifest.index.id,
      revisionId: built.manifest.index.revision.id,
      markdown: built.markdown.index,
    },
    {
      artifactId: built.manifest.log.id,
      revisionId: built.manifest.log.revision.id,
      markdown: built.markdown.log,
    },
    {
      artifactId: built.manifest.pages[0]!.id,
      revisionId: built.manifest.pages[0]!.revision.id,
      markdown: built.markdown.page,
    },
  ];
}

async function withWikiStorage(run: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-wiki-api-"));
  const previousUploadsLocal = process.env.UPLOADS_LOCAL;
  const previousUploadsDir = process.env.UPLOADS_DIR;
  try {
    process.env.UPLOADS_LOCAL = "true";
    process.env.UPLOADS_DIR = dir;
    resetStorageForTests();
    await run();
  } finally {
    resetStorageForTests();
    if (previousUploadsLocal === undefined) delete process.env.UPLOADS_LOCAL;
    else process.env.UPLOADS_LOCAL = previousUploadsLocal;
    if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = previousUploadsDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("Wiki API is hidden when the common feature flag has no server allow rule", async ({ app }) => {
  const fixture = await createWikiFixture({ enableWiki: false });
  const status = await fetch(`${app.baseUrl}/api/wiki/status`, {
    headers: authHeaders(fixture.ownerToken, fixture.server.id),
  });
  assert.equal(status.status, 404);
  assert.deepEqual(await status.json(), {
    error: "Wiki is not available on this server",
    code: "not_found",
  });
});

test("Wiki setup keeps the daemon/workspace/admin gates and persists only the slim space pointer", async () => {
  await withWikiStorage(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const fixture = await createWikiFixture();
      const headers = authHeaders(fixture.ownerToken, fixture.server.id);
      stubWikiWorkspaceSetup(app, { daemonVersion: "99.0.0", supportsPack: false });

      const memberSetup = await fetch(`${app.baseUrl}/api/wiki/setup`, {
        method: "POST",
        headers: authHeaders(fixture.memberToken, fixture.server.id),
        body: JSON.stringify({ agentId: fixture.agent.id, channelId: fixture.channel.id }),
      });
      assert.equal(memberSetup.status, 403);

      const outdatedSetup = await fetch(`${app.baseUrl}/api/wiki/setup`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId: fixture.agent.id, channelId: fixture.channel.id }),
      });
      assert.equal(outdatedSetup.status, 409);
      assert.equal((await outdatedSetup.json() as { code: string }).code, "daemon_upgrade_required");

      stubWikiWorkspaceSetup(app);
      const setup = await fetch(`${app.baseUrl}/api/wiki/setup`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId: fixture.agent.id, channelId: fixture.channel.id }),
      });
      assert.equal(setup.status, 200);
      const body = await setup.json() as {
        space: {
          status: string;
          dailyScanReminderId: string;
          weeklyLintReminderId: string;
        };
        reviewSummary: {
          workspace: { files: unknown[] };
          dailyScanReminder: { id: string };
          weeklyLintReminder: { id: string };
        };
      };
      assert.equal(body.space.status, "ready_uninitialized");
      // The global scanned-sequence field is gone. Coverage is per channel, so
      // one maximum spanning all of them belonged to none of them and could not
      // say how far the ingest had got; nothing rendered it either.
      assert.equal("lastScannedSeq" in body.space, false);
      assert.equal(body.reviewSummary.workspace.files.length, 8);
      assert.equal(await isChannelAgent(fixture.channel.id, fixture.agent.id), true);

      const [space] = await getDb()
        .select()
        .from(wikiBindings)
        .where(eq(wikiBindings.serverId, fixture.server.id));
      assert.ok(space);
      assert.deepEqual(
        Object.keys(space).sort(),
        [
          "createdAt",
          "createdByUserId",
          "id",
          "serverId",
          "status",
          "updatedAt",
          "wikiAgentId",
          "wikiChannelId",
        ].sort(),
      );

      const [savedAgent] = await getDb().select().from(agents).where(eq(agents.id, fixture.agent.id));
      const runtimeConfig = hydrateRuntimeConfig(savedAgent);
      assert.equal(runtimeConfig.envVars?.[WIKI_AGENT_WORKSPACE_ENV], WIKI_AGENT_WORKSPACE_ENABLED);
      const daily = await getDb().select().from(reminders).where(eq(reminders.id, space.id));
      assert.equal(daily.length, 1);
      assert.equal(body.space.dailyScanReminderId, daily[0]!.id);
      assert.equal(body.reviewSummary.dailyScanReminder.id, daily[0]!.id);
      const scheduled = await getDb()
        .select()
        .from(reminders)
        .where(eq(reminders.ownerAgentId, fixture.agent.id));
      assert.equal(scheduled.length, 2);
      const weeklyLint = scheduled.find((reminder) =>
        (reminder.payload as { kind?: string } | null)?.kind === "wiki.lint"
      );
      assert.ok(weeklyLint);
      assert.notEqual(weeklyLint.id, daily[0]!.id);
      assert.equal(body.space.weeklyLintReminderId, weeklyLint.id);
      assert.equal(body.reviewSummary.weeklyLintReminder.id, weeklyLint.id);
      assert.deepEqual(weeklyLint.recurrence, {
        version: 1,
        rule: {
          kind: "weekly",
          days: ["sun"],
          hour: 3,
          minute: 30,
          tz: "Asia/Shanghai",
        },
      });
    } finally {
      await app.close();
    }
  });
});

test("a deleted configured Wiki Agent can be replaced without changing the stable binding", async () => {
  await withWikiStorage(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const fixture = await createWikiFixture();
      const headers = authHeaders(fixture.ownerToken, fixture.server.id);
      stubWikiWorkspaceSetup(app);

      const initialSetup = await fetch(`${app.baseUrl}/api/wiki/setup`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId: fixture.agent.id, channelId: fixture.channel.id }),
      });
      assert.equal(initialSetup.status, 200);
      const [initialBinding] = await getDb()
        .select()
        .from(wikiBindings)
        .where(eq(wikiBindings.serverId, fixture.server.id));
      assert.ok(initialBinding);

      await deleteAgent(fixture.agent.id);
      const missingStatus = await fetch(`${app.baseUrl}/api/wiki/status`, { headers });
      assert.equal(missingStatus.status, 200);
      const missingBody = await missingStatus.json() as {
        space: { status: string; wikiAgentId: string; wikiAgentName: string | null };
      };
      assert.equal(missingBody.space.status, "setup_required");
      assert.equal(missingBody.space.wikiAgentId, fixture.agent.id);
      assert.equal(missingBody.space.wikiAgentName, null);

      const replacement = await createAgent(fixture.server.id, "ReplacementWikiAgent", {
        description: "Replaces a deleted configured Wiki Agent.",
        creatorType: "user",
        creatorId: fixture.owner.id,
      });
      const replacementSetup = await fetch(`${app.baseUrl}/api/wiki/setup`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId: replacement.id, channelId: fixture.channel.id }),
      });
      assert.equal(replacementSetup.status, 200);

      const bindings = await getDb()
        .select()
        .from(wikiBindings)
        .where(eq(wikiBindings.serverId, fixture.server.id));
      assert.equal(bindings.length, 1);
      assert.equal(bindings[0]?.id, initialBinding.id);
      assert.equal(bindings[0]?.wikiAgentId, replacement.id);

      const [daily] = await getDb()
        .select()
        .from(reminders)
        .where(eq(reminders.id, initialBinding.id));
      assert.ok(daily);
      assert.equal(daily.ownerAgentId, replacement.id);
      assert.equal(daily.status, "scheduled");
      const replacementReminders = await getDb()
        .select()
        .from(reminders)
        .where(eq(reminders.ownerAgentId, replacement.id));
      assert.equal(replacementReminders.length, 2);
      assert.deepEqual(
        replacementReminders
          .map((reminder) => (reminder.payload as { kind?: string } | null)?.kind)
          .sort(),
        ["wiki.incremental_discovery", "wiki.lint"],
      );
      const oldAgentReminders = await getDb()
        .select()
        .from(reminders)
        .where(eq(reminders.ownerAgentId, fixture.agent.id));
      assert.equal(oldAgentReminders.length, 1);
      assert.equal(oldAgentReminders[0]?.status, "canceled");
      assert.equal(
        (oldAgentReminders[0]?.payload as { kind?: string } | null)?.kind,
        "wiki.lint",
      );
      assert.ok(replacementReminders.every((reminder) => reminder.armState === "pending"));
    } finally {
      await app.close();
    }
  });
});

test("manual refresh schedules a Computer-owned reminder without Server due execution", async () => {
  await withWikiStorage(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const fixture = await createWikiFixture();
      stubWikiWorkspaceSetup(app);
      const headers = authHeaders(fixture.ownerToken, fixture.server.id);
      const setup = await fetch(`${app.baseUrl}/api/wiki/setup`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId: fixture.agent.id, channelId: fixture.channel.id }),
      });
      assert.equal(setup.status, 200);

      const refresh = await fetch(`${app.baseUrl}/api/wiki/refresh`, {
        method: "POST",
        headers,
      });
      assert.equal(refresh.status, 200);
      const refreshBody = await refresh.json() as {
        job: { id: string; phase: string };
      };
      assert.equal(refreshBody.job.phase, "computer_reminder_scheduled");
      const [manual] = await getDb()
        .select()
        .from(reminders)
        .where(eq(reminders.id, refreshBody.job.id));
      assert.ok(manual);
      assert.equal((manual.payload as { kind?: string }).kind, "wiki.ingest_request");
      assert.equal(manual.armState, "pending");
      assert.equal(manual.status, "scheduled");
    } finally {
      await app.close();
    }
  });
});

test("owner reset clears unreadable state and reminders without replacing resources or starting initialization", async () => {
  await withWikiStorage(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const fixture = await createWikiFixture();
      stubWikiWorkspaceSetup(app);
      const headers = authHeaders(fixture.ownerToken, fixture.server.id);
      const setup = await fetch(`${app.baseUrl}/api/wiki/setup`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId: fixture.agent.id, channelId: fixture.channel.id }),
      });
      assert.equal(setup.status, 200);
      await markWikiInitializing(fixture.server.id);
      const [space] = await getDb()
        .select()
        .from(wikiBindings)
        .where(eq(wikiBindings.serverId, fixture.server.id));
      assert.ok(space);

      const built = buildManifest({
        serverId: fixture.server.id,
        wikiSpaceId: space.id,
        agentId: fixture.agent.id,
      });
      const published = await publishWikiAgentManifest({
        serverId: fixture.server.id,
        agentId: fixture.agent.id,
        expectedEtag: null,
        manifest: built.manifest,
        revisionBodies: revisionBodiesFor(built),
      });
      const storage = getStorage();
      assert.ok(storage);
      const otherServerManifestKey = wikiManifestKey(randomUUID());
      await storage.put(otherServerManifestKey, Buffer.from("other-server"), "application/json");
      await storage.put(
        wikiManifestKey(fixture.server.id),
        Buffer.from('{"schemaVersion":0,"legacyCursor":999}'),
        "application/json",
      );
      const remindersBefore = await getDb()
        .select()
        .from(reminders)
        .where(eq(reminders.ownerAgentId, fixture.agent.id));

      const memberAttempt = await fetch(`${app.baseUrl}/api/wiki/reset`, {
        method: "POST",
        headers: authHeaders(fixture.memberToken, fixture.server.id),
      });
      assert.equal(memberAttempt.status, 403);
      assert.ok(await storage.head?.(wikiManifestKey(fixture.server.id)));

      const reset = await fetch(`${app.baseUrl}/api/wiki/reset`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          serverId: randomUUID(),
          key: otherServerManifestKey,
        }),
      });
      assert.equal(reset.status, 200);
      const resetBody = await reset.json() as {
        space: { status: string; wikiAgentId: string; wikiChannelId: string };
        lastJob: unknown;
      };
      assert.equal(resetBody.space.status, "ready_uninitialized");
      assert.equal(resetBody.space.wikiAgentId, fixture.agent.id);
      assert.equal(resetBody.space.wikiChannelId, fixture.channel.id);
      assert.equal(resetBody.lastJob, null);

      assert.equal(await storage.head?.(wikiManifestKey(fixture.server.id)), null);
      assert.ok(await storage.head?.(otherServerManifestKey));
      for (const artifact of [built.manifest.index, built.manifest.log, ...built.manifest.pages]) {
        assert.ok(await storage.head?.(artifact.revision.key), `revision was removed: ${artifact.revision.key}`);
      }
      const [resetBinding] = await getDb()
        .select()
        .from(wikiBindings)
        .where(eq(wikiBindings.serverId, fixture.server.id));
      assert.equal(resetBinding?.status, "ready_uninitialized");
      assert.equal(resetBinding?.wikiAgentId, fixture.agent.id);
      assert.equal(resetBinding?.wikiChannelId, fixture.channel.id);
      const remindersAfter = await getDb()
        .select()
        .from(reminders)
        .where(eq(reminders.ownerAgentId, fixture.agent.id));
      assert.equal(remindersAfter.length, remindersBefore.length);
      assert.ok(remindersAfter.every((reminder) => reminder.status === "canceled"));
      const auditMessages = await getDb()
        .select()
        .from(messages)
        .where(eq(messages.channelId, fixture.channel.id));
      assert.ok(auditMessages.some((message) =>
        message.senderId === fixture.owner.id
        && message.content.startsWith("Wiki reset requested.")
      ));

      const resetEraManifest = buildManifest({
        serverId: fixture.server.id,
        wikiSpaceId: space.id,
        agentId: fixture.agent.id,
      });
      await assert.rejects(
        publishWikiAgentManifest({
          serverId: fixture.server.id,
          agentId: fixture.agent.id,
          expectedEtag: null,
          manifest: resetEraManifest.manifest,
          revisionBodies: revisionBodiesFor(resetEraManifest),
        }),
        /Initialize Wiki before publishing/,
      );

      const initialize = await fetch(`${app.baseUrl}/api/wiki/refresh`, {
        method: "POST",
        headers,
      });
      assert.equal(initialize.status, 200);
      const initializeBody = await initialize.json() as {
        space: { status: string };
        job: { id: string; jobType: string };
      };
      assert.equal(initializeBody.space.status, "initializing");
      assert.equal(initializeBody.job.jobType, "init_discovery");
      const initializingStatus = await fetch(`${app.baseUrl}/api/wiki/status`, { headers });
      assert.equal(initializingStatus.status, 200);
      assert.ok((await initializingStatus.json() as {
        space: { lastIngestRequestedAt: string | null };
      }).space.lastIngestRequestedAt);
      const remindersAfterInitialize = await getDb()
        .select()
        .from(reminders)
        .where(eq(reminders.ownerAgentId, fixture.agent.id));
      const scheduledKinds = remindersAfterInitialize
        .filter((reminder) => reminder.status === "scheduled")
        .map((reminder) => (reminder.payload as { kind?: string }).kind)
        .sort();
      assert.deepEqual(scheduledKinds, [
        "wiki.incremental_discovery",
        "wiki.ingest_request",
        "wiki.lint",
      ]);

      await assert.rejects(
        publishWikiAgentManifest({
          serverId: fixture.server.id,
          agentId: fixture.agent.id,
          expectedEtag: published.etag,
          manifest: built.manifest,
          revisionBodies: revisionBodiesFor(built),
        }),
        /changed before it could be published/,
      );
      const regenerated = buildManifest({
        serverId: fixture.server.id,
        wikiSpaceId: space.id,
        agentId: fixture.agent.id,
      });
      const fresh = await publishWikiAgentManifest({
        serverId: fixture.server.id,
        agentId: fixture.agent.id,
        expectedEtag: null,
        manifest: regenerated.manifest,
        revisionBodies: revisionBodiesFor(regenerated),
      });
      assert.equal(fresh.manifest.revision, 1);
    } finally {
      await app.close();
    }
  });
});

test("reset delete failure restores coarse status and leaves reminders armed", async () => {
  await withWikiStorage(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const fixture = await createWikiFixture();
      stubWikiWorkspaceSetup(app);
      const headers = authHeaders(fixture.ownerToken, fixture.server.id);
      const setup = await fetch(`${app.baseUrl}/api/wiki/setup`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId: fixture.agent.id, channelId: fixture.channel.id }),
      });
      assert.equal(setup.status, 200);
      await markWikiInitializing(fixture.server.id);
      const [space] = await getDb()
        .select()
        .from(wikiBindings)
        .where(eq(wikiBindings.serverId, fixture.server.id));
      assert.ok(space);
      const built = buildManifest({
        serverId: fixture.server.id,
        wikiSpaceId: space.id,
        agentId: fixture.agent.id,
      });
      await publishWikiAgentManifest({
        serverId: fixture.server.id,
        agentId: fixture.agent.id,
        expectedEtag: null,
        manifest: built.manifest,
        revisionBodies: revisionBodiesFor(built),
      });
      const remindersBefore = await getDb()
        .select()
        .from(reminders)
        .where(eq(reminders.ownerAgentId, fixture.agent.id));
      const backing = getStorage();
      assert.ok(backing?.getVersioned && backing.putConditional);
      const failingStorage: StorageBackend = {
        put: (...args) => backing.put(...args),
        putConditional: (...args) => backing.putConditional!(...args),
        get: (...args) => backing.get(...args),
        getVersioned: (...args) => backing.getVersioned!(...args),
        delete: async () => {
          throw new Error("injected delete failure");
        },
        head: (...args) => backing.head!(...args),
      };
      __setStorageForTests(failingStorage);

      const reset = await fetch(`${app.baseUrl}/api/wiki/reset`, {
        method: "POST",
        headers,
      });
      assert.equal(reset.status, 503);
      assert.deepEqual(await reset.json(), {
        error: "Wiki could not be reset because its current manifest could not be deleted.",
        code: "storage_unavailable",
        phase: "delete",
        resetCompleted: false,
      });
      const [bindingAfter] = await getDb()
        .select()
        .from(wikiBindings)
        .where(eq(wikiBindings.serverId, fixture.server.id));
      assert.equal(bindingAfter?.status, "active");
      const remindersAfter = await getDb()
        .select()
        .from(reminders)
        .where(eq(reminders.ownerAgentId, fixture.agent.id));
      assert.equal(remindersAfter.length, remindersBefore.length);
      assert.ok(await backing.head?.(wikiManifestKey(fixture.server.id)));
    } finally {
      await app.close();
    }
  });
});

test("a Wiki Agent manifest publication drives status, directory, and verified markdown reads without DB artifact rows", async () => {
  await withWikiStorage(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const fixture = await createWikiFixture();
      stubWikiWorkspaceSetup(app);
      const headers = authHeaders(fixture.ownerToken, fixture.server.id);
      const setup = await fetch(`${app.baseUrl}/api/wiki/setup`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId: fixture.agent.id, channelId: fixture.channel.id }),
      });
      assert.equal(setup.status, 200);
      await markWikiInitializing(fixture.server.id);
      const [space] = await getDb()
        .select()
        .from(wikiBindings)
        .where(eq(wikiBindings.serverId, fixture.server.id));
      assert.ok(space);
      const built = buildManifest({
        serverId: fixture.server.id,
        wikiSpaceId: space.id,
        agentId: fixture.agent.id,
      });
      const archivedMarkdown = "# Retired architecture fragment\n\nMerged into Architecture.\n";
      const archivedPage = manifestArtifact({
        serverId: fixture.server.id,
        type: "page",
        slug: "retired-architecture-fragment",
        markdown: archivedMarkdown,
      });
      archivedPage.status = "archived";
      built.manifest.pages.push(archivedPage);
      const published = await publishWikiAgentManifest({
        serverId: fixture.server.id,
        agentId: fixture.agent.id,
        expectedEtag: null,
        manifest: built.manifest,
        revisionBodies: [
          ...revisionBodiesFor(built),
          {
            artifactId: archivedPage.id,
            revisionId: archivedPage.revision.id,
            markdown: archivedMarkdown,
          },
        ],
      });
      assert.ok(published.etag);
      const maintenanceReminders = await getDb()
        .select()
        .from(reminders)
        .where(eq(reminders.ownerAgentId, fixture.agent.id));
      const weeklyLint = maintenanceReminders.find((reminder) =>
        (reminder.payload as { kind?: string } | null)?.kind === "wiki.lint"
      );
      const dailyIngest = maintenanceReminders.find((reminder) =>
        (reminder.payload as { kind?: string } | null)?.kind === "wiki.incremental_discovery"
      );
      assert.ok(weeklyLint);
      assert.ok(dailyIngest);
      assert.ok([weeklyLint, dailyIngest].every((reminder) =>
        reminder.status === "scheduled" && reminder.armState === "pending"
      ));

      const upToDateRefresh = await fetch(`${app.baseUrl}/api/wiki/refresh`, {
        method: "POST",
        headers,
      });
      assert.equal(upToDateRefresh.status, 200);
      const upToDateBody = await upToDateRefresh.json() as {
        upToDate: boolean;
        sourceChangesDetected: boolean;
        job: { phase: string };
      };
      assert.equal(upToDateBody.upToDate, true);
      assert.equal(upToDateBody.sourceChangesDetected, false);
      assert.equal(upToDateBody.job.phase, "no_changes");
      assert.equal(
        (await getDb()
          .select()
          .from(reminders)
          .where(eq(reminders.ownerAgentId, fixture.agent.id))).length,
        2,
      );

      const status = await fetch(`${app.baseUrl}/api/wiki/status`, { headers });
      assert.equal(status.status, 200);
      const statusBody = await status.json() as {
        space: {
          status: string;
          lastIngestReceiptId: string;
          manifestRevision: number;
        };
        lastJob: { phase: string };
      };
      assert.equal(statusBody.space.status, "active");
      assert.equal("lastScannedSeq" in statusBody.space, false);
      assert.equal(statusBody.space.lastIngestReceiptId, built.manifest.lastIngest.receiptId);
      assert.equal(statusBody.space.manifestRevision, 1);
      assert.equal(statusBody.lastJob.phase, "manifest_published");

      const directory = await fetch(`${app.baseUrl}/api/wiki/directory`, { headers });
      assert.equal(directory.status, 200);
      const directoryBody = await directory.json() as {
        index: { slug: string };
        log: { slug: string };
        pages: Array<{ id: string; slug: string }>;
      };
      assert.equal(directoryBody.index.slug, "index");
      assert.equal(directoryBody.log.slug, "log");
      assert.deepEqual(directoryBody.pages.map((page) => page.slug), ["architecture"]);

      const artifact = await fetch(
        `${app.baseUrl}/api/wiki/artifacts/${directoryBody.pages[0]!.id}`,
        { headers },
      );
      assert.equal(artifact.status, 200);
      assert.equal((await artifact.json() as { markdown: string }).markdown, built.markdown.page);
    } finally {
      await app.close();
    }
  });
});

test("authenticated Wiki Agent manifest routes enforce ownership and stale-writer CAS", async () => {
  await withWikiStorage(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const fixture = await createWikiFixture();
      stubWikiWorkspaceSetup(app);
      const humanHeaders = authHeaders(fixture.ownerToken, fixture.server.id);
      const setup = await fetch(`${app.baseUrl}/api/wiki/setup`, {
        method: "POST",
        headers: humanHeaders,
        body: JSON.stringify({ agentId: fixture.agent.id, channelId: fixture.channel.id }),
      });
      assert.equal(setup.status, 200);
      await markWikiInitializing(fixture.server.id);
      const sourceChannel = await createChannel(fixture.server.id, "engineering");
      const sourceMessage = await createMessage(
        sourceChannel.id,
        "user",
        fixture.owner.id,
        "Use a canonical S3 manifest for Wiki publication.",
      );
      const privateChannel = await createChannel(
        fixture.server.id,
        "wiki-private-source",
        "Private source must stay out of Wiki",
        "private",
      );
      const privateMessage = await createMessage(
        privateChannel.id,
        "user",
        fixture.owner.id,
        "This private message must not advance the Wiki cursor.",
      );
      // Eligible source published after the private message, so the private
      // sequence sits below the global upper bound. Without this the private
      // case would trip the range bound first and never reach the eligibility
      // check that is the actual protection.
      const laterEligibleMessage = await createMessage(
        sourceChannel.id,
        "user",
        fixture.owner.id,
        "A later eligible message.",
      );

      const otherAgent = await createAgent(fixture.server.id, "NotWikiAgent", {
        creatorType: "user",
        creatorId: fixture.owner.id,
      });
      const wikiCredential = await mintAgentCredential({
        agentId: fixture.agent.id,
        scopes: ["knowledge"],
        name: "wiki-manifest-test",
        createdByUserId: fixture.owner.id,
      });
      const otherCredential = await mintAgentCredential({
        agentId: otherAgent.id,
        scopes: ["knowledge"],
        name: "not-wiki-manifest-test",
        createdByUserId: fixture.owner.id,
      });

      const initialRead = await fetch(`${app.baseUrl}/internal/agent-api/wiki/manifest`, {
        headers: agentAuthHeaders(wikiCredential.apiKey),
      });
      assert.equal(initialRead.status, 200);
      assert.equal((await initialRead.json() as { manifest: unknown }).manifest, null);

      const unauthorizedRead = await fetch(`${app.baseUrl}/internal/agent-api/wiki/manifest`, {
        headers: agentAuthHeaders(otherCredential.apiKey),
      });
      assert.equal(unauthorizedRead.status, 403);

      const [space] = await getDb()
        .select()
        .from(wikiBindings)
        .where(eq(wikiBindings.serverId, fixture.server.id));
      assert.ok(space);
      const built = buildManifest({
        serverId: fixture.server.id,
        wikiSpaceId: space.id,
        agentId: fixture.agent.id,
      });
      built.markdown.page = `# Architecture\n\n${"durable knowledge ".repeat(9_000)}`;
      built.manifest.pages[0]!.revision.sha256 = sha256(built.markdown.page);
      built.manifest.pages[0]!.revision.bytes = Buffer.byteLength(built.markdown.page);
      built.manifest.pages[0]!.sourceRefs = [{
        channelId: sourceChannel.id,
        messageId: sourceMessage.id,
        seq: sourceMessage.seq,
        slockRef: `#${sourceChannel.name}:${sourceMessage.id.slice(0, 8)}`,
      }];
      built.manifest.coverage = {
        [sourceChannel.id]: [{ from: 0, to: sourceMessage.seq }],
      };
      built.manifest.lastIngest.added = [{
        channelId: sourceChannel.id,
        from: 0,
        to: sourceMessage.seq,
        observedCount: 1,
      }];
      const publicationBody = {
        expectedEtag: null as string | null,
        manifest: built.manifest,
        revisionBodies: revisionBodiesFor(built),
      };

      const assertNoCanonicalWrite = async () => {
        const storage = getStorage();
        assert.ok(storage?.head);
        assert.equal(await storage.head(wikiManifestKey(fixture.server.id)), null);
        for (const body of publicationBody.revisionBodies) {
          assert.equal(
            await storage.head(wikiRevisionKey(fixture.server.id, body.artifactId, body.revisionId)),
            null,
          );
        }
      };

      const unauthorizedPublish = await fetch(`${app.baseUrl}/internal/agent-api/wiki/publish`, {
        method: "POST",
        headers: agentAuthHeaders(otherCredential.apiKey),
        body: JSON.stringify(publicationBody),
      });
      assert.equal(unauthorizedPublish.status, 403);

      const wrongCountBody = structuredClone(publicationBody);
      wrongCountBody.manifest.lastIngest.added[0]!.observedCount = 2;
      const wrongCount = await fetch(`${app.baseUrl}/internal/agent-api/wiki/publish`, {
        method: "POST",
        headers: agentAuthHeaders(wikiCredential.apiKey),
        body: JSON.stringify(wrongCountBody),
      });
      assert.equal(wrongCount.status, 400);
      assert.match(
        (await wrongCount.json() as { error: string }).error,
        /reported 2 messages.*server counted 1/,
      );
      await assertNoCanonicalWrite();

      const wrongRefBody = structuredClone(publicationBody);
      wrongRefBody.manifest.coverage = {
        [sourceChannel.id]: [{ from: 0, to: laterEligibleMessage.seq }],
      };
      wrongRefBody.manifest.lastIngest.added = [{
        channelId: sourceChannel.id,
        from: 0,
        to: laterEligibleMessage.seq,
        observedCount: 3,
      }];
      wrongRefBody.manifest.pages[0]!.sourceRefs[0]!.channelId = fixture.channel.id;
      wrongRefBody.manifest.index.sourceRefs = [{
        channelId: sourceChannel.id,
        messageId: laterEligibleMessage.id,
        seq: laterEligibleMessage.seq,
        slockRef: "#engineering:wrong",
      }];
      const wrongRef = await fetch(`${app.baseUrl}/internal/agent-api/wiki/publish`, {
        method: "POST",
        headers: agentAuthHeaders(wikiCredential.apiKey),
        body: JSON.stringify(wrongRefBody),
      });
      assert.equal(wrongRef.status, 400);
      const wrongRefError = (await wrongRef.json() as { error: string }).error;
      assert.match(wrongRefError, /has 3 source validation errors/);
      assert.match(wrongRefError, /reported 3 messages.*server counted 2/);
      assert.match(wrongRefError, new RegExp(`source ref ${sourceMessage.id} does not match`));
      assert.match(wrongRefError, new RegExp(`source ref ${laterEligibleMessage.id} must use`));
      await assertNoCanonicalWrite();

      const wrongLastBody = structuredClone(publicationBody);
      wrongLastBody.revisionBodies.at(-1)!.markdown += "tampered";
      const wrongBody = await fetch(`${app.baseUrl}/internal/agent-api/wiki/publish`, {
        method: "POST",
        headers: agentAuthHeaders(wikiCredential.apiKey),
        body: JSON.stringify(wrongLastBody),
      });
      assert.equal(wrongBody.status, 400);
      assert.match(
        (await wrongBody.json() as { error: string }).error,
        /revision receipt.*does not match its bytes/,
      );
      await assertNoCanonicalWrite();

      const cursorOvershootBody = structuredClone(publicationBody);
      cursorOvershootBody.manifest.coverage = {
        [sourceChannel.id]: [{ from: 0, to: laterEligibleMessage.seq + 1 }],
      };
      cursorOvershootBody.manifest.lastIngest.added = [{
        channelId: sourceChannel.id,
        from: 0,
        to: laterEligibleMessage.seq + 1,
        observedCount: 1,
      }];
      const cursorOvershoot = await fetch(`${app.baseUrl}/internal/agent-api/wiki/publish`, {
        method: "POST",
        headers: agentAuthHeaders(wikiCredential.apiKey),
        body: JSON.stringify(cursorOvershootBody),
      });
      assert.equal(cursorOvershoot.status, 400);
      assert.match(
        (await cursorOvershoot.json() as { error: string }).error,
        /beyond the latest eligible sequence/,
      );

      const privateCursorBody = structuredClone(publicationBody);
      privateCursorBody.manifest.pages[0]!.sourceRefs = [{
        channelId: privateChannel.id,
        messageId: privateMessage.id,
        seq: privateMessage.seq,
        slockRef: `#${privateChannel.name}:${privateMessage.id.slice(0, 8)}`,
      }];
      privateCursorBody.manifest.coverage = {
        [privateChannel.id]: [{ from: 0, to: privateMessage.seq }],
      };
      privateCursorBody.manifest.lastIngest.added = [{
        channelId: privateChannel.id,
        from: 0,
        to: privateMessage.seq,
        observedCount: 1,
      }];
      const privateCursor = await fetch(`${app.baseUrl}/internal/agent-api/wiki/publish`, {
        method: "POST",
        headers: agentAuthHeaders(wikiCredential.apiKey),
        body: JSON.stringify(privateCursorBody),
      });
      assert.equal(privateCursor.status, 400);
      // Rejected for what is actually wrong with it. Reporting a private
      // channel as "beyond the latest eligible sequence" was an artifact of
      // its latest resolving to zero, which read as a counting problem rather
      // than an eligibility one.
      assert.match(
        (await privateCursor.json() as { error: string }).error,
        /not an eligible Wiki source channel/,
      );

      const publish = await fetch(`${app.baseUrl}/internal/agent-api/wiki/publish`, {
        method: "POST",
        headers: agentAuthHeaders(wikiCredential.apiKey),
        body: JSON.stringify(publicationBody),
      });
      assert.equal(publish.status, 200);
      const published = await publish.json() as { etag: string | null };
      assert.ok(published.etag);

      const noDurableKnowledgeMessage = await createMessage(
        sourceChannel.id,
        "user",
        fixture.owner.id,
        "thanks",
      );
      const noChangesBody = structuredClone(publicationBody);
      noChangesBody.expectedEtag = published.etag;
      noChangesBody.manifest.revision = 2;
      // Reading further and finding nothing durable still extends coverage:
      // "checked and found nothing" is a real result, not a gap.
      noChangesBody.manifest.coverage = {
        [sourceChannel.id]: [{ from: 0, to: noDurableKnowledgeMessage.seq }],
      };
      noChangesBody.manifest.publishedAt = "2026-07-25T15:05:00.000Z";
      noChangesBody.manifest.lastIngest = {
        receiptId: randomUUID(),
        added: [{
          channelId: sourceChannel.id,
          from: 0,
          to: noDurableKnowledgeMessage.seq,
          observedCount: 3,
        }],
        outcome: "no_changes",
        publishedAt: noChangesBody.manifest.publishedAt,
      };
      noChangesBody.revisionBodies = [];
      const noChangesPublish = await fetch(`${app.baseUrl}/internal/agent-api/wiki/publish`, {
        method: "POST",
        headers: agentAuthHeaders(wikiCredential.apiKey),
        body: JSON.stringify(noChangesBody),
      });
      assert.equal(noChangesPublish.status, 200);
      const noChangesPublished = await noChangesPublish.json() as {
        etag: string;
        manifest: WikiManifest;
      };
      assert.notEqual(noChangesPublished.etag, published.etag);
      assert.equal(noChangesPublished.manifest.lastIngest.outcome, "no_changes");
      assert.equal(
        noChangesPublished.manifest.lastIngest.receiptId,
        noChangesBody.manifest.lastIngest.receiptId,
      );

      const agentArtifactRead = await fetch(
        `${app.baseUrl}/internal/agent-api/wiki/artifacts/${built.manifest.pages[0]!.id}`,
        { headers: agentAuthHeaders(wikiCredential.apiKey) },
      );
      assert.equal(agentArtifactRead.status, 200);
      const agentArtifact = await agentArtifactRead.json() as {
        etag: string;
        artifact: WikiManifestArtifact;
        markdown: string;
      };
      assert.equal(agentArtifact.etag, noChangesPublished.etag);
      assert.equal(agentArtifact.artifact.id, built.manifest.pages[0]!.id);
      assert.deepEqual(agentArtifact.artifact.revision, built.manifest.pages[0]!.revision);
      assert.equal(agentArtifact.markdown, built.markdown.page);

      const unauthorizedArtifactRead = await fetch(
        `${app.baseUrl}/internal/agent-api/wiki/artifacts/${built.manifest.pages[0]!.id}`,
        { headers: agentAuthHeaders(otherCredential.apiKey) },
      );
      assert.equal(unauthorizedArtifactRead.status, 403);

      const missingArtifactRead = await fetch(
        `${app.baseUrl}/internal/agent-api/wiki/artifacts/${randomUUID()}`,
        { headers: agentAuthHeaders(wikiCredential.apiKey) },
      );
      assert.equal(missingArtifactRead.status, 404);

      const stalePublish = await fetch(`${app.baseUrl}/internal/agent-api/wiki/publish`, {
        method: "POST",
        headers: agentAuthHeaders(wikiCredential.apiKey),
        body: JSON.stringify(publicationBody),
      });
      assert.equal(stalePublish.status, 409);

      const directory = await fetch(`${app.baseUrl}/api/wiki/directory`, {
        headers: humanHeaders,
      });
      assert.equal(directory.status, 200);
      const pageId = (await directory.json() as {
        pages: Array<{ id: string }>;
      }).pages[0]!.id;
      const artifact = await fetch(`${app.baseUrl}/api/wiki/artifacts/${pageId}`, {
        headers: humanHeaders,
      });
      assert.equal(artifact.status, 200);
      assert.equal((await artifact.json() as { markdown: string }).markdown, built.markdown.page);
    } finally {
      await app.close();
    }
  });
});

test("a channel's coverage stands for its threads across latest, count, and wake", async () => {
  await withWikiStorage(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const fixture = await createWikiFixture();
      stubWikiWorkspaceSetup(app);
      const setup = await fetch(`${app.baseUrl}/api/wiki/setup`, {
        method: "POST",
        headers: authHeaders(fixture.ownerToken, fixture.server.id),
        body: JSON.stringify({ agentId: fixture.agent.id, channelId: fixture.channel.id }),
      });
      assert.equal(setup.status, 200);
      await markWikiInitializing(fixture.server.id);

      // A parent channel with a thread hanging off it. `messages.seq` is
      // server-global and a thread reply is stored under the thread's own
      // channel id, so the parent's range necessarily spans thread sequences.
      const sourceChannel = await createChannel(fixture.server.id, "engineering");
      const parentMessage = await createMessage(
        sourceChannel.id,
        "user",
        fixture.owner.id,
        "Should the manifest own coverage?",
      );
      const [threadChannel] = await getDb().insert(channels).values({
        serverId: fixture.server.id,
        name: `thread-${parentMessage.id.slice(0, 8)}`,
        type: "thread",
        parentMessageId: parentMessage.id,
      }).returning();
      assert.ok(threadChannel);
      const threadReply = await createMessage(
        threadChannel.id,
        "user",
        fixture.owner.id,
        "Yes — S3 stays canonical.",
      );
      assert.ok(threadReply.seq > parentMessage.seq);

      const [space] = await getDb()
        .select()
        .from(wikiBindings)
        .where(eq(wikiBindings.serverId, fixture.server.id));
      assert.ok(space);
      const built = buildManifest({
        serverId: fixture.server.id,
        wikiSpaceId: space.id,
        agentId: fixture.agent.id,
      });
      // The Agent read the parent channel and its thread, and records that work
      // under the parent — the key the doctrine tells it to use.
      built.manifest.pages[0]!.sourceRefs = [{
        channelId: threadChannel.id,
        messageId: threadReply.id,
        seq: threadReply.seq,
        slockRef: `#${sourceChannel.name}:${parentMessage.id.slice(0, 8)}`,
      }];
      built.manifest.coverage = {
        [sourceChannel.id]: [{ from: 1, to: threadReply.seq }],
      };
      built.manifest.lastIngest.added = [{
        channelId: sourceChannel.id,
        from: 1,
        to: threadReply.seq,
        observedCount: 2,
      }];

      const published = await publishWikiAgentManifest({
        serverId: fixture.server.id,
        agentId: fixture.agent.id,
        expectedEtag: null,
        manifest: built.manifest,
        revisionBodies: revisionBodiesFor(built),
      });
      assert.ok(published.etag);

      // Having read the parent and its thread in full, coverage is complete.
      // The daily lifecycle row remains Computer-owned; the Server no longer
      // decides whether its due-time attention should be emitted.
      const maintenanceReminders = await getDb()
        .select()
        .from(reminders)
        .where(eq(reminders.ownerAgentId, fixture.agent.id));
      const dailyIngest = maintenanceReminders.find((reminder) =>
        (reminder.payload as { kind?: string } | null)?.kind === "wiki.incremental_discovery"
      );
      assert.ok(dailyIngest);
      assert.equal(dailyIngest.status, "scheduled");
      assert.equal(dailyIngest.armState, "pending");
    } finally {
      await app.close();
    }
  });
});

test("a first publication cannot claim coverage wider than it declares", async () => {
  await withWikiStorage(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const fixture = await createWikiFixture();
      stubWikiWorkspaceSetup(app);
      const setup = await fetch(`${app.baseUrl}/api/wiki/setup`, {
        method: "POST",
        headers: authHeaders(fixture.ownerToken, fixture.server.id),
        body: JSON.stringify({ agentId: fixture.agent.id, channelId: fixture.channel.id }),
      });
      assert.equal(setup.status, 200);
      await markWikiInitializing(fixture.server.id);
      const sourceChannel = await createChannel(fixture.server.id, "engineering");
      const first = await createMessage(
        sourceChannel.id,
        "user",
        fixture.owner.id,
        "First durable decision.",
      );
      const second = await createMessage(
        sourceChannel.id,
        "user",
        fixture.owner.id,
        "Second durable decision.",
      );

      const [space] = await getDb()
        .select()
        .from(wikiBindings)
        .where(eq(wikiBindings.serverId, fixture.server.id));
      assert.ok(space);
      const built = buildManifest({
        serverId: fixture.server.id,
        wikiSpaceId: space.id,
        agentId: fixture.agent.id,
      });
      built.manifest.pages[0]!.sourceRefs = [{
        channelId: sourceChannel.id,
        messageId: first.id,
        seq: first.seq,
        slockRef: `#${sourceChannel.name}:${first.id.slice(0, 8)}`,
      }];
      // Coverage claims both messages; only the first is declared and counted.
      // Accepting this is exactly the silent skip-ahead the coverage model
      // exists to prevent, and the cold start is where it does the most damage.
      built.manifest.coverage = {
        [sourceChannel.id]: [{ from: 1, to: second.seq }],
      };
      built.manifest.lastIngest.added = [{
        channelId: sourceChannel.id,
        from: 1,
        to: first.seq,
        observedCount: 1,
      }];

      const wikiCredential = await mintAgentCredential({
        agentId: fixture.agent.id,
        scopes: ["knowledge"],
        name: "wiki-first-publication-test",
        createdByUserId: fixture.owner.id,
      });
      const response = await fetch(`${app.baseUrl}/internal/agent-api/wiki/publish`, {
        method: "POST",
        headers: agentAuthHeaders(wikiCredential.apiKey),
        body: JSON.stringify({
          expectedEtag: null,
          manifest: built.manifest,
          revisionBodies: revisionBodiesFor(built),
        }),
      });
      assert.equal(response.status, 400);
      assert.match(
        (await response.json() as { error: string }).error,
        /without a matching lastIngest.added entry/,
      );
    } finally {
      await app.close();
    }
  });
});

test("coverage left behind by an archived channel keeps publishing alive but cannot grow", async () => {
  await withWikiStorage(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const fixture = await createWikiFixture();
      stubWikiWorkspaceSetup(app);
      const setup = await fetch(`${app.baseUrl}/api/wiki/setup`, {
        method: "POST",
        headers: authHeaders(fixture.ownerToken, fixture.server.id),
        body: JSON.stringify({ agentId: fixture.agent.id, channelId: fixture.channel.id }),
      });
      assert.equal(setup.status, 200);
      await markWikiInitializing(fixture.server.id);
      const sourceChannel = await createChannel(fixture.server.id, "engineering");
      const readMessage = await createMessage(
        sourceChannel.id,
        "user",
        fixture.owner.id,
        "A decision recorded while the channel was live.",
      );
      const laterMessage = await createMessage(
        sourceChannel.id,
        "user",
        fixture.owner.id,
        "A later message in the same channel.",
      );
      // The Page cites a channel that stays eligible, so this test isolates the
      // stale *coverage key* from the separate question of what happens to a
      // citation whose channel is later archived.
      const citedChannel = await createChannel(fixture.server.id, "product");
      const citedMessage = await createMessage(
        citedChannel.id,
        "user",
        fixture.owner.id,
        "A decision that stays citable.",
      );

      const [space] = await getDb()
        .select()
        .from(wikiBindings)
        .where(eq(wikiBindings.serverId, fixture.server.id));
      assert.ok(space);
      const built = buildManifest({
        serverId: fixture.server.id,
        wikiSpaceId: space.id,
        agentId: fixture.agent.id,
      });
      built.manifest.pages[0]!.sourceRefs = [{
        channelId: citedChannel.id,
        messageId: citedMessage.id,
        seq: citedMessage.seq,
        slockRef: `#${citedChannel.name}:${citedMessage.id.slice(0, 8)}`,
      }];
      built.manifest.coverage = {
        [sourceChannel.id]: [{ from: 1, to: readMessage.seq }],
        [citedChannel.id]: [{ from: 1, to: citedMessage.seq }],
      };
      built.manifest.lastIngest.added = [
        { channelId: sourceChannel.id, from: 1, to: readMessage.seq, observedCount: 1 },
        { channelId: citedChannel.id, from: 1, to: citedMessage.seq, observedCount: 1 },
      ];
      const first = await publishWikiAgentManifest({
        serverId: fixture.server.id,
        agentId: fixture.agent.id,
        expectedEtag: null,
        manifest: built.manifest,
        revisionBodies: revisionBodiesFor(built),
      });
      assert.ok(first.etag);

      // The channel is archived after it was read. Coverage is append-only, so
      // its key stays in the manifest forever.
      await getDb()
        .update(channels)
        .set({ archivedAt: new Date() })
        .where(eq(channels.id, sourceChannel.id));

      // Publishing still works: a key that has left the eligible set is not
      // measured against it. Otherwise one archived channel would fail every
      // future publication permanently.
      const carried = structuredClone(built.manifest);
      carried.revision = 2;
      carried.publishedAt = "2026-07-25T16:00:00.000Z";
      carried.lastIngest = {
        receiptId: randomUUID(),
        added: [],
        outcome: "no_changes",
        publishedAt: "2026-07-25T16:00:00.000Z",
      };
      const carriedPublish = await publishWikiAgentManifest({
        serverId: fixture.server.id,
        agentId: fixture.agent.id,
        expectedEtag: first.etag,
        manifest: carried,
        revisionBodies: [],
      });
      assert.ok(carriedPublish.etag);

      // But it cannot grow. Declared growth on a channel that is no longer
      // eligible is rejected, so tolerating the stale key does not open a path
      // for ineligible source to enter coverage.
      const grown = structuredClone(carried);
      grown.revision = 3;
      grown.publishedAt = "2026-07-25T17:00:00.000Z";
      grown.coverage = {
        ...carried.coverage,
        [sourceChannel.id]: [{ from: 1, to: laterMessage.seq }],
      };
      grown.lastIngest = {
        receiptId: randomUUID(),
        added: [{
          channelId: sourceChannel.id,
          from: 1,
          to: laterMessage.seq,
          observedCount: 2,
        }],
        outcome: "published",
        publishedAt: "2026-07-25T17:00:00.000Z",
      };
      await assert.rejects(
        publishWikiAgentManifest({
          serverId: fixture.server.id,
          agentId: fixture.agent.id,
          expectedEtag: carriedPublish.etag,
          manifest: grown,
          revisionBodies: [],
        }),
        /not an eligible Wiki source channel/,
      );

      // And it cannot grow silently either: dropping the declaration to dodge
      // the eligibility check trips the undeclared-growth invariant instead.
      const undeclared = structuredClone(grown);
      undeclared.lastIngest = {
        receiptId: randomUUID(),
        added: [],
        outcome: "published",
        publishedAt: "2026-07-25T17:00:00.000Z",
      };
      await assert.rejects(
        publishWikiAgentManifest({
          serverId: fixture.server.id,
          agentId: fixture.agent.id,
          expectedEtag: carriedPublish.etag,
          manifest: undeclared,
          revisionBodies: [],
        }),
        /without a matching lastIngest.added entry/,
      );
    } finally {
      await app.close();
    }
  });
});

test("a channel can be read to the run's frozen boundary even when it ends earlier", async () => {
  await withWikiStorage(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const fixture = await createWikiFixture();
      stubWikiWorkspaceSetup(app);
      const setup = await fetch(`${app.baseUrl}/api/wiki/setup`, {
        method: "POST",
        headers: authHeaders(fixture.ownerToken, fixture.server.id),
        body: JSON.stringify({ agentId: fixture.agent.id, channelId: fixture.channel.id }),
      });
      assert.equal(setup.status, 200);
      await markWikiInitializing(fixture.server.id);
      // Channel A stops early; channel B carries the run's boundary. Sequences
      // are server-wide, so reading A "to the boundary" means claiming a range
      // whose tail lies past A's own last message and is legitimately empty.
      const channelA = await createChannel(fixture.server.id, "engineering");
      const messageA = await createMessage(
        channelA.id,
        "user",
        fixture.owner.id,
        "The only message in A.",
      );
      const channelB = await createChannel(fixture.server.id, "product");
      const messageB = await createMessage(
        channelB.id,
        "user",
        fixture.owner.id,
        "A later message in B, which sets the boundary.",
      );
      assert.ok(messageB.seq > messageA.seq);

      const [space] = await getDb()
        .select()
        .from(wikiBindings)
        .where(eq(wikiBindings.serverId, fixture.server.id));
      assert.ok(space);
      const built = buildManifest({
        serverId: fixture.server.id,
        wikiSpaceId: space.id,
        agentId: fixture.agent.id,
      });
      built.manifest.pages[0]!.sourceRefs = [{
        channelId: channelA.id,
        messageId: messageA.id,
        seq: messageA.seq,
        slockRef: `#${channelA.name}:${messageA.id.slice(0, 8)}`,
      }];
      built.manifest.coverage = {
        [channelA.id]: [{ from: 1, to: messageB.seq }],
      };
      built.manifest.lastIngest.added = [{
        channelId: channelA.id,
        from: 1,
        to: messageB.seq,
        observedCount: 1,
      }];

      const published = await publishWikiAgentManifest({
        serverId: fixture.server.id,
        agentId: fixture.agent.id,
        expectedEtag: null,
        manifest: built.manifest,
        revisionBodies: revisionBodiesFor(built),
      });
      assert.ok(published.etag);
    } finally {
      await app.close();
    }
  });
});

test("lint keeps publishing after a channel named by the carried ingest receipt is archived", async () => {
  await withWikiStorage(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const fixture = await createWikiFixture();
      stubWikiWorkspaceSetup(app);
      const setup = await fetch(`${app.baseUrl}/api/wiki/setup`, {
        method: "POST",
        headers: authHeaders(fixture.ownerToken, fixture.server.id),
        body: JSON.stringify({ agentId: fixture.agent.id, channelId: fixture.channel.id }),
      });
      assert.equal(setup.status, 200);
      await markWikiInitializing(fixture.server.id);
      // Order matters: the channel that will be archived holds the HIGHEST
      // sequence. Archiving it lowers the global upper bound, so any check that
      // re-measures historical coverage against the live eligible set fails
      // from then on. The reverse order hides the defect.
      const citedChannel = await createChannel(fixture.server.id, "product");
      const citedMessage = await createMessage(
        citedChannel.id,
        "user",
        fixture.owner.id,
        "A decision that stays citable.",
      );
      const sourceChannel = await createChannel(fixture.server.id, "engineering");
      const sourceMessage = await createMessage(
        sourceChannel.id,
        "user",
        fixture.owner.id,
        "A decision recorded while the channel was live.",
      );
      const uncitedMessage = await createMessage(
        sourceChannel.id,
        "user",
        fixture.owner.id,
        "Read at the same time but never cited.",
      );
      assert.ok(uncitedMessage.seq > citedMessage.seq);

      const [space] = await getDb()
        .select()
        .from(wikiBindings)
        .where(eq(wikiBindings.serverId, fixture.server.id));
      assert.ok(space);
      const built = buildManifest({
        serverId: fixture.server.id,
        wikiSpaceId: space.id,
        agentId: fixture.agent.id,
      });
      // The Page cites the channel that will be archived, so the lint below
      // carries a reference into an archived channel.
      built.manifest.pages[0]!.sourceRefs = [{
        channelId: sourceChannel.id,
        messageId: sourceMessage.id,
        seq: sourceMessage.seq,
        slockRef: `#${sourceChannel.name}:${sourceMessage.id.slice(0, 8)}`,
      }];
      built.manifest.coverage = {
        [sourceChannel.id]: [{ from: 1, to: uncitedMessage.seq }],
        [citedChannel.id]: [{ from: 1, to: citedMessage.seq }],
      };
      built.manifest.lastIngest.added = [
        { channelId: sourceChannel.id, from: 1, to: uncitedMessage.seq, observedCount: 2 },
        { channelId: citedChannel.id, from: 1, to: citedMessage.seq, observedCount: 1 },
      ];
      const ingest = await publishWikiAgentManifest({
        serverId: fixture.server.id,
        agentId: fixture.agent.id,
        expectedEtag: null,
        manifest: built.manifest,
        revisionBodies: revisionBodiesFor(built),
      });
      assert.ok(ingest.etag);

      await getDb()
        .update(channels)
        .set({ archivedAt: new Date() })
        .where(eq(channels.id, sourceChannel.id));

      // A lint publication preserves the ingest receipt verbatim, so it still
      // names the now-archived channel. Re-auditing that carried history would
      // block lint forever.
      const lint = structuredClone(built.manifest);
      lint.revision = 2;
      lint.publishedAt = "2026-07-25T16:00:00.000Z";
      const repairedMarkdown = "# Architecture\n\nRepaired by lint.\n";
      const repairedRevisionId = randomUUID();
      lint.pages[0]!.updatedAt = "2026-07-25T16:00:00.000Z";
      lint.pages[0]!.revision = {
        id: repairedRevisionId,
        key: wikiRevisionKey(fixture.server.id, lint.pages[0]!.id, repairedRevisionId),
        sha256: sha256(repairedMarkdown),
        bytes: Buffer.byteLength(repairedMarkdown),
      };
      lint.lastLint = {
        receiptId: randomUUID(),
        outcome: "repaired",
        repairedArtifactIds: [lint.pages[0]!.id],
        publishedAt: "2026-07-25T16:00:00.000Z",
      };
      const linted = await publishWikiAgentManifest({
        serverId: fixture.server.id,
        agentId: fixture.agent.id,
        expectedEtag: ingest.etag,
        manifest: lint,
        revisionBodies: [{
          artifactId: lint.pages[0]!.id,
          revisionId: repairedRevisionId,
          markdown: repairedMarkdown,
        }],
      });
      assert.ok(linted.etag);

      // A citation is grandfathered, not the channel. A message inside the same
      // archived channel and already inside committed coverage, but never
      // referenced before, cannot be cited now.
      const newlyCited = structuredClone(lint);
      newlyCited.revision = 3;
      newlyCited.publishedAt = "2026-07-25T17:00:00.000Z";
      newlyCited.pages[0]!.sourceRefs = [{
        channelId: sourceChannel.id,
        messageId: uncitedMessage.id,
        seq: uncitedMessage.seq,
        slockRef: `#${sourceChannel.name}:${uncitedMessage.id.slice(0, 8)}`,
      }];
      newlyCited.lastIngest = {
        receiptId: randomUUID(),
        added: [],
        outcome: "no_changes",
        publishedAt: "2026-07-25T17:00:00.000Z",
      };
      await assert.rejects(
        publishWikiAgentManifest({
          serverId: fixture.server.id,
          agentId: fixture.agent.id,
          expectedEtag: linted.etag,
          manifest: newlyCited,
          revisionBodies: [],
        }),
        /is not in an active server channel/,
      );

      // That the archived channel cannot take new coverage is asserted by
      // "coverage left behind by an archived channel keeps publishing alive but
      // cannot grow"; it is not repeated here.
    } finally {
      await app.close();
    }
  });
});
