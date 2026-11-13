// checkJointAdmission's `newFreeServer` (#wg-rbac:#16, P2a-5): a server an
// external invitee is about to create counts as one free server from the
// parameter alone, never from a billing lookup (Tenny).
import { afterEach, expect, vi } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import { getDb } from "../db/index";
import { servers, users } from "../db/schema";
import { createServer } from "./serverService";
import { acceptJointChannelInvite, createJointChannel } from "./channelService";
import { checkJointAdmission, JointChannelLimitError } from "./jointChannelLimitService";
import * as planService from "./planService";

vi.mock("./planService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./planService")>();
  return { ...actual, getServerBillingEntitlements: vi.fn(actual.getServerBillingEntitlements) };
});

afterEach(async () => {
  // Back to the real lookup (the implementation vi.fn was created with).
  vi.mocked(planService.getServerBillingEntitlements).mockReset();
  await closeTestDatabase();
});

async function seedServer(label: string, plan: "free" | "pro") {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`, name: `${label}-${suffix}`, displayName: label, passwordHash: "hash", emailVerified: true,
  }).returning();
  const server = await createServer(`${label} ${suffix}`, `${label}-${suffix}`, owner!.id);
  await getDb().update(servers).set({ plan }).where(eq(servers.id, server.id));
  return { owner: owner!, server };
}

/** A joint of `host` that `participant` has joined. */
async function jointOf(host: Awaited<ReturnType<typeof seedServer>>, participant: Awaited<ReturnType<typeof seedServer>>) {
  const created = await createJointChannel({
    hostServerId: host.server.id,
    createdByUserId: host.owner.id,
    name: `joint-${randomUUID().slice(0, 8)}`,
    jointInvites: [{ targetServerSlug: participant.server.slug, invitedPeople: [participant.owner.email] }],
  });
  const invite = created.invites.find((row) => row.toServerId === participant.server.id)!;
  await acceptJointChannelInvite({ inviteId: invite.id, targetServerId: participant.server.id, acceptedByUserId: participant.owner.id });
  return created.jointChannel.id;
}

/**
 * The billing lookup records every id it is asked for, and says paid for any
 * id without a server row: a check that looked the new server up by a stand-in
 * id would read it as paid here.
 */
async function recordLookupsAndCallUnknownIdsPaid(paidServerId: string): Promise<string[]> {
  const actual = await vi.importActual<typeof import("./planService")>("./planService");
  const paid = (await actual.getServerBillingEntitlements(getDb(), [paidServerId])).get(paidServerId)!;
  assert.ok(paid.plan !== "free");
  const looked: string[] = [];
  vi.mocked(planService.getServerBillingEntitlements).mockImplementation(async (executor, serverIds, now) => {
    looked.push(...serverIds);
    const result = await actual.getServerBillingEntitlements(executor, serverIds, now);
    const existing = new Set((await getDb().select({ id: servers.id }).from(servers)).map((row) => row.id));
    for (const id of serverIds) if (!existing.has(id)) result.set(id, paid);
    return result;
  });
  return looked;
}

test("a joint with two free servers refuses one more new free server, counted from the parameter without any lookup of it", async ({ db: _db }) => {
  const host = await seedServer("ns-host", "free");
  const participant = await seedServer("ns-participant", "free");
  const reference = await seedServer("ns-paid-reference", "pro");
  const jointId = await jointOf(host, participant);
  const looked = await recordLookupsAndCallUnknownIdsPaid(reference.server.id);

  await expect(checkJointAdmission(getDb(), jointId, { kind: "accept" }, new Date(), { newFreeServer: true }))
    .rejects.toSatisfy((error: unknown) => error instanceof JointChannelLimitError && error.code === "joint_free_server_limit");
  // Only the joint's own servers were looked up.
  assert.deepEqual([...new Set(looked)].sort(), [host.server.id, participant.server.id].sort());
  // Without the parameter nothing joins: nothing to refuse.
  await checkJointAdmission(getDb(), jointId, { kind: "accept" }, new Date());
});

test("a paid host and one free participant take the new free server (two free servers)", async ({ db: _db }) => {
  const host = await seedServer("ns-paid-host", "pro");
  const participant = await seedServer("ns-free-participant", "free");
  const jointId = await jointOf(host, participant);
  const looked = await recordLookupsAndCallUnknownIdsPaid(host.server.id);
  await checkJointAdmission(getDb(), jointId, { kind: "accept" }, new Date(), { newFreeServer: true });
  assert.deepEqual([...new Set(looked)].sort(), [host.server.id, participant.server.id].sort());
  // A private channel's conversion: the host and the new free server only.
  await checkJointAdmission(getDb(), null, { kind: "convert", hostServerId: participant.server.id }, new Date(), { newFreeServer: true });
});
