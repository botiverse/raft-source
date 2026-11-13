import assert from "node:assert/strict";
import { asServerId } from "@botiverse/raft-shared";
import { channelHumans, featureFlagRules, featureFlags } from "./schema";
import { acceptJointChannelInvite, canUserAccessChannel, createJointChannel, getChannelMembers } from "../services/channelService";
import { channelActorHasCapability, resolveChannelActorContext } from "../lib/channelActorPermissions";
import { jointHumanLifecycleScenario } from "../test/jointHumanLifecycleScenario";
import { jointHumanMultiConnectScenario } from "../test/jointHumanMultiConnectScenario";
import { jointMembershipDepartureScenario } from "../test/jointMembershipDepartureScenario";
import { dbTest } from "../test/integration/dbTest";
import { jointHumanAccessScenario } from "../test/jointHumanAccessScenario";
import { jointHumanAuthorityScenario } from "../test/jointHumanAuthorityScenario";

dbTest(
  "computed J access and global revocation never derive from audit sources",
  async ({ db, seed }) => {
    await jointHumanAccessScenario({ db, seed });
  },
);
dbTest(
  "joint management follows current entry and current-episode provenance",
  async ({ db, seed }) => {
    await jointHumanAuthorityScenario({ db, seed });
  },
);

dbTest(
  "disconnect fixes victims atomically and revokes in bounded resumable batches",
  async ({ db, seed }) => {
    await jointMembershipDepartureScenario({ db, seed });
  },
);

dbTest(
  "last current server identity auto-disconnects and fences actual task writes",
  async ({ db, seed }) => {
    await jointHumanLifecycleScenario({ db, seed });
  },
);
dbTest(
  "one multi-server acceptance fixes all new sources and leaves existing members unchanged",
  async ({ db, seed }) => {
    await jointHumanMultiConnectScenario({ db, seed });
  },
);

dbTest("ended sources never revive through identity rejoin, promotion or reconnection", async ({db,seed})=>{
  const {jointHumanEndedSourceScenario}=await import("../test/jointHumanEndedSourceScenario");
  await jointHumanEndedSourceScenario({db,seed});
});

dbTest("automatic departures kick after outer commit across every trigger and never escape rollback",async({db,seed})=>{
  const {jointHumanDepartureKickScenario}=await import("../test/jointHumanDepartureKickScenario");
  await jointHumanDepartureKickScenario({db,seed});
});

// joint_human_membership_v1 is retired: computed membership is the only mode.
// A row of it left behind (off, killed, with a deny rule for both servers)
// is never read and changes nothing.
dbTest("a leftover joint_human_membership_v1 flag row set off changes nothing: membership is still computed", async ({ db, seed }) => {
  const owner = await seed.human(), peer = await seed.human(), outsider = await seed.human();
  const a = await seed.server({ owner, members: [peer] });
  const b = await seed.server({ owner, members: [peer, outsider] });
  const created = await createJointChannel({ hostServerId: a.id, createdByUserId: owner.id, name: "retired-flag",
    targetServerSlug: b.slug, invitedPeople: [`@${owner.name}`], userIds: [peer.id] });
  const target = await acceptJointChannelInvite({ inviteId: created.invites[0]!.id, targetServerId: b.id, acceptedByUserId: owner.id });
  await db.insert(featureFlags).values({ key: "joint_human_membership_v1", enabled: false, killSwitch: true, defaultEnabled: false,
    randomizationUnit: "server", salt: "retired" });
  await db.insert(featureFlagRules).values({ flagKey: "joint_human_membership_v1", stage: "server", decision: "deny", values: [a.id, b.id] });

  // A J member enters through B with no CH row there (computed; legacy would refuse).
  assert.equal(await canUserAccessChannel(target.id, peer.id, asServerId(b.id)), true);
  assert.ok((await getChannelMembers(target.id)).humans.some((human) => human.id === peer.id));
  // A CH row alone admits nobody (legacy would admit).
  await db.insert(channelHumans).values({ channelId: target.id, userId: outsider.id });
  assert.equal(await canUserAccessChannel(target.id, outsider.id, asServerId(b.id)), false);
  // Only the host manages members: B's owner may not remove people through B's copy (legacy would allow).
  const bOwner = await resolveChannelActorContext(b.id, target.id, "user", owner.id, db);
  assert.ok(bOwner?.jointAuthority, "the joint authority decides");
  assert.equal(channelActorHasCapability(bOwner, "removeChannelMembers"), false);
  const hostOwner = await resolveChannelActorContext(a.id, created.channel.id, "user", owner.id, db);
  assert.equal(hostOwner && channelActorHasCapability(hostOwner, "removeChannelMembers"), true);
});
