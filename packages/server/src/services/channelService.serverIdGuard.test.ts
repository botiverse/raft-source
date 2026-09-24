import { test } from "vitest";
import assert from "node:assert/strict";
import { asServerId } from "@botiverse/raft-shared";
import {
  MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET,
  acceptJointChannelInvite,
  canUserAccessChannel,
  createJointChannel,
  inviteServerToJointChannel,
  isJointChannelInviteId,
} from "./channelService.js";

// Regression guard for #945 (6b979b6f). canUserAccessChannel originally took
// (channelId, userId): the active server was implicit, so "in this server"
// silently meant "any server you belong to" — a cross-server access leak that
// was found and fixed only by an audit that made serverId a mandatory third
// argument. Branding that argument as `ServerId` raises the bar further: the
// unsafe call — passing an unproven / confusable string as the server scope —
// is now a COMPILE error, not something that can ship and be audited a year
// later. (Runtime behavior of the guard is covered in attachments.api.test.ts's
// cross-server cases.)
function _typeLevelGuard(): void {
  const channelId = "00000000-0000-0000-0000-000000000000";
  const userId = "11111111-1111-1111-1111-111111111111";

  // A server id proven at the boundary (in real code, minted by auth middleware
  // from the validated X-Server-Id header / authenticated row) is accepted:
  void canUserAccessChannel(channelId, userId, asServerId("22222222-2222-2222-2222-222222222222"));

  // @ts-expect-error — a raw string cannot stand in for the server scope. The
  // pre-#945 shape (an unvalidated/confusable serverId) no longer type-checks.
  void canUserAccessChannel(channelId, userId, "22222222-2222-2222-2222-222222222222");
}
void _typeLevelGuard;

test("acceptJointChannelInvite rejects malformed invite ids before DB work", async () => {
  assert.equal(isJointChannelInviteId("aaaaaaaa-1111-4111-8111-111111111111"), true);
  assert.equal(isJointChannelInviteId("x".repeat(12000)), false);

  await assert.rejects(
    () => acceptJointChannelInvite({
      inviteId: "x".repeat(12000),
      targetServerId: "22222222-2222-4222-8222-222222222222",
      acceptedByUserId: "33333333-3333-4333-8333-333333333333",
    }),
    /Joint channel invite not found/,
  );
});

test("joint channel invite services reject oversized invitee arrays before DB work", async () => {
  const invitedPeople = Array.from({ length: MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET + 1 }, (_, index) => `person-${index}@slock.test`);

  await assert.rejects(
    () => createJointChannel({
      hostServerId: "11111111-1111-4111-8111-111111111111",
      createdByUserId: "22222222-2222-4222-8222-222222222222",
      name: "oversized-joint",
      targetServerSlug: "target-server",
      invitedPeople,
    }),
    /maximum of 20 invited people/,
  );

  await assert.rejects(
    () => inviteServerToJointChannel({
      localChannelId: "33333333-3333-4333-8333-333333333333",
      fromServerId: "11111111-1111-4111-8111-111111111111",
      invitedByUserId: "22222222-2222-4222-8222-222222222222",
      targetServerSlug: "target-server",
      invitedPeople,
    }),
    /maximum of 20 invited people/,
  );
});
