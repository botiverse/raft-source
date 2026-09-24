import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  agents,
  serverAgreements,
  serverInvites,
  serverJoinLinks,
  serverMembers,
  serverMembershipAgreementAudit,
  servers as serversTable,
  users,
} from "../db/schema.js";
import { addMember, createServer as createServerService } from "../services/serverService.js";
import { createJoinLink } from "../services/inviteService.js";
import {
  AgreementRequiredError,
  PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH,
  requireSelfServeAgreement,
} from "../services/serverAgreementService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function createServer(name: string, slug: string, ownerId: string) {
  const server = await createServerService(name, slug, ownerId);
  await getDb().update(serversTable).set({ plan: "founder" }).where(eq(serversTable.id, server.id));
  return { ...server, plan: "founder" };
}

async function seedVerifiedUser(email: string, name = email.split("@")[0]) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}



function serverHeaders(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
    "Content-Type": "application/json",
  };
}

test("owners and admins can configure pre-join agreement; edits insert a new active version", async ({ app }) => {
  const owner = await seedVerifiedUser("agreement-owner@slock.test");
  const admin = await seedVerifiedUser("agreement-admin@slock.test");
  const member = await seedVerifiedUser("agreement-member@slock.test");
  const server = await createServer("Agreement Server", "agreement-server", owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);

  const ownerToken = await tokenForHuman(owner.email);
  const adminToken = await tokenForHuman(admin.email);
  const memberToken = await tokenForHuman(member.email);

  const denied = await fetch(`${app.baseUrl}/api/servers/${server.id}/agreement`, {
    method: "PUT",
    headers: serverHeaders(memberToken, server.id),
    body: JSON.stringify({ enabled: true, title: "Rules", bodyMarkdown: "Be kind." }),
  });
  assert.equal(denied.status, 403, "members cannot configure v0 agreement");
  const deniedBody = await denied.json() as { error: string };
  assert.equal(deniedBody.error, "Only server owners and admins can manage the pre-join agreement");

  const first = await fetch(`${app.baseUrl}/api/servers/${server.id}/agreement`, {
    method: "PUT",
    headers: serverHeaders(adminToken, server.id),
    body: JSON.stringify({ enabled: true, title: "Rules v1", bodyMarkdown: "Be kind." }),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { agreement: { id: string; version: number; title: string } };
  assert.equal(firstBody.agreement.version, 1);

  const adminRead = await fetch(`${app.baseUrl}/api/servers/${server.id}/agreement`, {
    headers: serverHeaders(adminToken, server.id),
  });
  assert.equal(adminRead.status, 200);
  const adminReadBody = await adminRead.json() as { agreement: { id: string; version: number; title: string } };
  assert.equal(adminReadBody.agreement.id, firstBody.agreement.id);

  const second = await fetch(`${app.baseUrl}/api/servers/${server.id}/agreement`, {
    method: "PUT",
    headers: serverHeaders(ownerToken, server.id),
    body: JSON.stringify({ enabled: true, title: "Rules v2", bodyMarkdown: "Be kind.\nNo spam." }),
  });
  assert.equal(second.status, 200);
  const secondBody = await second.json() as { agreement: { id: string; version: number; title: string } };
  assert.equal(secondBody.agreement.version, 2);
  assert.notEqual(secondBody.agreement.id, firstBody.agreement.id);

  const rows = await getDb()
    .select({ id: serverAgreements.id, version: serverAgreements.version, title: serverAgreements.title, enabled: serverAgreements.enabled })
    .from(serverAgreements)
    .where(eq(serverAgreements.serverId, server.id));
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.enabled).length, 1);
  assert.ok(rows.some((row) => row.version === 1 && row.title === "Rules v1" && !row.enabled));
  assert.ok(rows.some((row) => row.version === 2 && row.title === "Rules v2" && row.enabled));
});

test("agreement body accepts long markdown", async ({ app }) => {
  const owner = await seedVerifiedUser("agreement-long-body-owner@slock.test");
  const server = await createServer("Agreement Long Body", "agreement-long-body", owner.id);
  const ownerToken = await tokenForHuman(owner.email);
  const prefix = "# Community Rules\n\n";
  const longBody = `${prefix}${"A".repeat(PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH - prefix.length)}`;

  const accepted = await fetch(`${app.baseUrl}/api/servers/${server.id}/agreement`, {
    method: "PUT",
    headers: serverHeaders(ownerToken, server.id),
    body: JSON.stringify({ enabled: true, title: "Rules", bodyMarkdown: longBody }),
  });
  assert.equal(accepted.status, 200);
  const acceptedBody = await accepted.json() as { agreement: { bodyMarkdown: string } };
  assert.equal(acceptedBody.agreement.bodyMarkdown, longBody);
});

test("agreement body rejects markdown over 5000 characters", async ({ app }) => {
  const owner = await seedVerifiedUser("agreement-too-long-body-owner@slock.test");
  const server = await createServer("Agreement Too Long Body", "agreement-too-long-body", owner.id);
  const ownerToken = await tokenForHuman(owner.email);
  const tooLongBody = "A".repeat(PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH + 1);

  const rejected = await fetch(`${app.baseUrl}/api/servers/${server.id}/agreement`, {
    method: "PUT",
    headers: serverHeaders(ownerToken, server.id),
    body: JSON.stringify({ enabled: true, title: "Rules", bodyMarkdown: tooLongBody }),
  });
  assert.equal(rejected.status, 400);
  const rejectedBody = await rejected.json() as { error: string };
  assert.equal(rejectedBody.error, "Agreement body must be 5000 characters or fewer");
});

test("invite acceptance requires current agreement and writes membership audit atomically", async ({ app }) => {
  const owner = await seedVerifiedUser("agreement-invite-owner@slock.test");
  const joiner = await seedVerifiedUser("agreement-invite-joiner@slock.test");
  const server = await createServer("Agreement Invite", "agreement-invite", owner.id);
  const { token: inviteToken } = await createJoinLink(server.id, owner.id);

  const ownerToken = await tokenForHuman(owner.email);
  const configure = await fetch(`${app.baseUrl}/api/servers/${server.id}/agreement`, {
    method: "PUT",
    headers: serverHeaders(ownerToken, server.id),
    body: JSON.stringify({ enabled: true, title: "Join Rules", bodyMarkdown: "Read this first." }),
  });
  assert.equal(configure.status, 200);
  const configured = await configure.json() as { agreement: { id: string; version: number } };

  const preview = await fetch(`${app.baseUrl}/api/auth/invite-info?token=${encodeURIComponent(inviteToken)}`);
  assert.equal(preview.status, 200);
  const previewBody = await preview.json() as { agreement: { id: string; title: string } | null };
  assert.equal(previewBody.agreement?.id, configured.agreement.id);
  assert.equal(previewBody.agreement?.title, "Join Rules");

  const joinerToken = await tokenForHuman(joiner.email);
  const missingAgreement = await fetch(`${app.baseUrl}/api/auth/accept-invite`, {
    method: "POST",
    headers: { Authorization: `Bearer ${joinerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token: inviteToken }),
  });
  assert.equal(missingAgreement.status, 409);
  const missingBody = await missingAgreement.json() as { error: string; agreement: { id: string } };
  assert.equal(missingBody.error, "agreement_required");
  assert.equal(missingBody.agreement.id, configured.agreement.id);

  const accepted = await fetch(`${app.baseUrl}/api/auth/accept-invite`, {
    method: "POST",
    headers: { Authorization: `Bearer ${joinerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token: inviteToken, agreementId: configured.agreement.id }),
  });
  assert.equal(accepted.status, 200);

  const [member] = await getDb()
    .select()
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, joiner.id)));
  assert.ok(member, "membership row must be created");

  const [audit] = await getDb()
    .select()
    .from(serverMembershipAgreementAudit)
    .where(and(
      eq(serverMembershipAgreementAudit.serverId, server.id),
      eq(serverMembershipAgreementAudit.subjectId, joiner.id),
    ));
  assert.equal(audit?.source, "invite");
  assert.equal(audit?.actorUserId, joiner.id);
  assert.equal(audit?.agreementId, configured.agreement.id);
  assert.equal(audit?.agreementVersion, configured.agreement.version);

  const [link] = await getDb()
    .select({ useCount: serverJoinLinks.useCount })
    .from(serverJoinLinks)
    .where(eq(serverJoinLinks.token, inviteToken));
  assert.equal(link?.useCount, 1);
});

test("invite preview hides human count when server hides humans from members", async ({ app }) => {
  const owner = await seedVerifiedUser("invite-preview-hide-owner@slock.test");
  const member = await seedVerifiedUser("invite-preview-hide-member@slock.test");
  const other = await seedVerifiedUser("invite-preview-hide-other@slock.test");
  const server = await createServer("Invite Preview Hide", "invite-preview-hide", owner.id);
  await getDb().update(serversTable).set({ hideHumansFromMembers: true }).where(eq(serversTable.id, server.id));
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: member.id, role: "member" },
    { serverId: server.id, userId: other.id, role: "member" },
  ]);
  await getDb().insert(agents).values({
    serverId: server.id,
    name: "preview-agent",
    displayName: "Preview Agent",
    runtime: "codex",
  });
  const { token: inviteToken } = await createJoinLink(server.id, owner.id);

  const preview = await fetch(`${app.baseUrl}/api/auth/invite-info?token=${encodeURIComponent(inviteToken)}`);
  assert.equal(preview.status, 200);
  const previewBody = await preview.json() as { memberCount: number; agentCount: number; insideCountsHidden: boolean };
  assert.equal(previewBody.memberCount, 0, "pre-join invite preview must not expose hidden human count");
  assert.equal(previewBody.agentCount, 0, "pre-join invite preview must not expose hidden agent count");
  assert.equal(previewBody.insideCountsHidden, true, "pre-join invite preview should render neutral inside copy");

  const emailInviteToken = "email-preview-hide-token";
  await getDb().insert(serverInvites).values({
    serverId: server.id,
    invitedEmail: "invite-preview-new-member@slock.test",
    invitedByUserId: owner.id,
    tokenHash: createHash("sha256").update(emailInviteToken).digest("hex"),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const emailPreview = await fetch(`${app.baseUrl}/api/auth/invite-info?token=${encodeURIComponent(emailInviteToken)}`);
  assert.equal(emailPreview.status, 200);
  const emailPreviewBody = await emailPreview.json() as { memberCount: number; agentCount: number; insideCountsHidden: boolean };
  assert.equal(emailPreviewBody.memberCount, 0, "email invite preview must not expose hidden human count");
  assert.equal(emailPreviewBody.agentCount, 0, "email invite preview must not expose hidden agent count");
  assert.equal(emailPreviewBody.insideCountsHidden, true, "email invite preview should render neutral inside copy");
});

test("stale agreement id is rejected before membership creation", async ({ app }) => {
  const owner = await seedVerifiedUser("agreement-stale-owner@slock.test");
  const joiner = await seedVerifiedUser("agreement-stale-joiner@slock.test");
  const server = await createServer("Agreement Stale", "agreement-stale", owner.id);
  const { token: inviteToken } = await createJoinLink(server.id, owner.id);
  const ownerToken = await tokenForHuman(owner.email);

  const first = await fetch(`${app.baseUrl}/api/servers/${server.id}/agreement`, {
    method: "PUT",
    headers: serverHeaders(ownerToken, server.id),
    body: JSON.stringify({ enabled: true, title: "Rules v1", bodyMarkdown: "First." }),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { agreement: { id: string } };

  const second = await fetch(`${app.baseUrl}/api/servers/${server.id}/agreement`, {
    method: "PUT",
    headers: serverHeaders(ownerToken, server.id),
    body: JSON.stringify({ enabled: true, title: "Rules v2", bodyMarkdown: "Second." }),
  });
  assert.equal(second.status, 200);

  const joinerToken = await tokenForHuman(joiner.email);
  const stale = await fetch(`${app.baseUrl}/api/auth/accept-invite`, {
    method: "POST",
    headers: { Authorization: `Bearer ${joinerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token: inviteToken, agreementId: firstBody.agreement.id }),
  });
  assert.equal(stale.status, 409);
  const staleBody = await stale.json() as { error: string; agreement: { title: string } };
  assert.equal(staleBody.error, "agreement_changed");
  assert.equal(staleBody.agreement.title, "Rules v2");

  const [member] = await getDb()
    .select()
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, joiner.id)));
  assert.equal(member, undefined);
});

test("self-serve join rejects no-active to active race before membership creation", async ({ app }) => {
  const owner = await seedVerifiedUser("agreement-race-owner@slock.test");
  const joiner = await seedVerifiedUser("agreement-race-joiner@slock.test");
  const server = await createServer("Agreement Race", "agreement-race", owner.id);

  await assert.rejects(
    getDb().transaction(async (tx) => {
      const agreement = await requireSelfServeAgreement(tx, server.id, undefined);
      assert.equal(agreement, null, "initial self-serve check should see no active agreement");

      await tx.insert(serverAgreements).values({
        serverId: server.id,
        version: 1,
        title: "Rules enabled mid-join",
        bodyMarkdown: "Accept before joining.",
        createdByUserId: owner.id,
        enabled: true,
      });

      await addMember(server.id, joiner.id, "member", {
        executor: tx,
        agreementAudit: {
          actorUserId: joiner.id,
          source: "invite",
          agreementId: null,
        },
      });
    }),
    AgreementRequiredError,
  );

  const [member] = await getDb()
    .select()
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, joiner.id)));
  assert.equal(member, undefined);

  const [audit] = await getDb()
    .select()
    .from(serverMembershipAgreementAudit)
    .where(and(
      eq(serverMembershipAgreementAudit.serverId, server.id),
      eq(serverMembershipAgreementAudit.subjectId, joiner.id),
    ));
  assert.equal(audit, undefined);
});

test("admin-add bypass records admin-authority audit with current agreement", async ({ app }) => {
  const owner = await seedVerifiedUser("agreement-adminadd-owner@slock.test");
  const target = await seedVerifiedUser("agreement-adminadd-target@slock.test");
  const server = await createServer("Agreement Admin Add", "agreement-admin-add", owner.id);
  const ownerToken = await tokenForHuman(owner.email);

  const configure = await fetch(`${app.baseUrl}/api/servers/${server.id}/agreement`, {
    method: "PUT",
    headers: serverHeaders(ownerToken, server.id),
    body: JSON.stringify({ enabled: true, title: "Rules", bodyMarkdown: "Current rules." }),
  });
  assert.equal(configure.status, 200);
  const configured = await configure.json() as { agreement: { id: string; version: number } };

  const add = await fetch(`${app.baseUrl}/api/servers/${server.id}/members`, {
    method: "POST",
    headers: serverHeaders(ownerToken, server.id),
    body: JSON.stringify({ userId: target.id }),
  });
  assert.equal(add.status, 200);

  const [audit] = await getDb()
    .select()
    .from(serverMembershipAgreementAudit)
    .where(and(
      eq(serverMembershipAgreementAudit.serverId, server.id),
      eq(serverMembershipAgreementAudit.subjectId, target.id),
    ));
  assert.equal(audit?.source, "admin-add");
  assert.equal(audit?.actorUserId, owner.id);
  assert.equal(audit?.agreementId, configured.agreement.id);
  assert.equal(audit?.agreementVersion, configured.agreement.version);
});
