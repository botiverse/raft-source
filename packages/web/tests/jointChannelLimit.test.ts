import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { channelLimitLockedMessageId, externalFreezeUpcomingAt, isExternalFreezeActive, isJointChannelReadOnly, jointChannelGraceEndsAt, jointConversionGuestRefusalMessage, jointDisconnectGuestRefusalMessage, jointFreeHostLimitMessage, jointInviteAcceptErrorMessage } from "../src/utils/jointChannelLimit";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

const deadline = "2027-01-04T00:00:00.000Z";
const deadlineMs = Date.parse(deadline);

test("contract v0.3 §18.8: a joint is read-only when locked, or once the local clock reaches the deadline", () => {
  const grace = { type: "joint", jointBillingLocked: false, jointOverLimitGraceEndsAt: deadline };
  assert.equal(isJointChannelReadOnly(grace, deadlineMs - 1), false);
  assert.equal(jointChannelGraceEndsAt(grace, deadlineMs - 1), deadline);
  // Stale metadata fetched during grace still says unlocked after the deadline.
  assert.equal(isJointChannelReadOnly(grace, deadlineMs), true);
  assert.equal(jointChannelGraceEndsAt(grace, deadlineMs), null);
  assert.equal(isJointChannelReadOnly({ type: "joint", jointBillingLocked: true, jointOverLimitGraceEndsAt: null }, 0), true);
});

test("within the limit, or not a joint channel, is never read-only", () => {
  assert.equal(isJointChannelReadOnly({ type: "joint", jointBillingLocked: false, jointOverLimitGraceEndsAt: null }), false);
  assert.equal(isJointChannelReadOnly({ type: "joint", jointOverLimitGraceEndsAt: "" }), false);
  assert.equal(isJointChannelReadOnly({ type: "channel", jointBillingLocked: true }), false);
  assert.equal(jointChannelGraceEndsAt({ type: "joint", jointOverLimitGraceEndsAt: null }), null);
});

test("external channel freeze: any channel this server is frozen out of is read-only from externalFreezeAt", () => {
  const ordinary = { type: "private", externalFreezeAt: deadline };
  assert.equal(isJointChannelReadOnly(ordinary, deadlineMs - 1), false);
  assert.equal(externalFreezeUpcomingAt(ordinary, deadlineMs - 1), deadline, "the notice before it");
  assert.equal(isJointChannelReadOnly(ordinary, deadlineMs), true, "an ordinary channel too, not only a joint");
  assert.equal(isExternalFreezeActive(ordinary, deadlineMs), true);
  assert.equal(externalFreezeUpcomingAt(ordinary, deadlineMs), null);
  assert.equal(channelLimitLockedMessageId(ordinary, deadlineMs), "message.chatPanel.externalLimitFrozen");
  assert.equal(isJointChannelReadOnly({ type: "joint", externalFreezeAt: deadline, jointBillingLocked: false }, deadlineMs), true);
  // Flag off or not over: the server sends no time, and nothing changes.
  assert.equal(isJointChannelReadOnly({ type: "private", externalFreezeAt: null }, deadlineMs), false);
  assert.equal(externalFreezeUpcomingAt({ type: "private" }, deadlineMs), null);
  assert.equal(channelLimitLockedMessageId({ type: "joint", jointBillingLocked: true }, deadlineMs), "message.chatPanel.jointLocked");
});

test("joint grace and the external freeze together: one notice, the freeze's", () => {
  const graceEnds = "2027-01-02T00:00:00.000Z";
  const both = { type: "joint", jointBillingLocked: false, jointOverLimitGraceEndsAt: graceEnds, externalFreezeAt: deadline };
  // Both ahead: no joint grace notice, the freeze notice instead.
  assert.equal(jointChannelGraceEndsAt(both, Date.parse(graceEnds) - 1), null);
  assert.equal(externalFreezeUpcomingAt(both, Date.parse(graceEnds) - 1), deadline);
  // Joint grace over, freeze still ahead: read-only by the joint rule, its own message, no grace notice.
  assert.equal(isJointChannelReadOnly(both, Date.parse(graceEnds)), true);
  assert.equal(channelLimitLockedMessageId(both, Date.parse(graceEnds)), "message.chatPanel.jointLocked");
  assert.equal(jointChannelGraceEndsAt(both, Date.parse(graceEnds)), null);
  // Both past: the freeze's message.
  assert.equal(channelLimitLockedMessageId(both, deadlineMs), "message.chatPanel.externalLimitFrozen");
  // Without a freeze the joint grace notice is unchanged.
  assert.equal(jointChannelGraceEndsAt({ ...both, externalFreezeAt: null }, Date.parse(graceEnds) - 1), graceEnds);
});

test("a failed joint invite accept explains the limit instead of failing silently", () => {
  const en = createIntl({ locale: "en", messages: enMessages as Record<string, string> });
  const zh = createIntl({ locale: "zh-cn", messages: zhMessages as Record<string, string> });
  const failure = (data: Record<string, unknown>) => ({ response: { data } });

  const freeLimit = failure({ error: "server text", code: "joint_free_server_limit" });
  assert.equal(
    jointInviteAcceptErrorMessage(freeLimit, en.formatMessage),
    "This Joint Channel already has 2 free servers. Upgrade either side to Pro, or have a free server leave, to continue (30 servers max).",
  );
  assert.equal(
    jointInviteAcceptErrorMessage(freeLimit, zh.formatMessage),
    "这个联合频道已满 2 个免费服务器。把任一方升级到 Pro，或有免费服务器退出后，可以继续加入（总服务器上限 30 个）",
  );
  assert.match(jointInviteAcceptErrorMessage(failure({ code: "joint_server_limit" }), en.formatMessage), /limited to 30 servers/);
  // The invitee belongs to another organisation: the host's plan is never disclosed.
  const hostConnectLimit = failure({ error: "server text", code: "joint_channel_free_limit_reached" });
  const enHostConnect = jointInviteAcceptErrorMessage(hostConnectLimit, en.formatMessage);
  assert.equal(enHostConnect, enMessages["channel.joint.inviteHostFreeLimit"]);
  assert.equal(jointInviteAcceptErrorMessage(hostConnectLimit, zh.formatMessage), zhMessages["channel.joint.inviteHostFreeLimit"]);
  assert.doesNotMatch(enHostConnect, /free|pro|plan/i);
  assert.doesNotMatch(zhMessages["channel.joint.inviteHostFreeLimit"], /免费|付费|Pro/);
  // A free accepting server already in an external channel (host with external
  // channels on): its own limit, named, localized; without a name, the server's text.
  const externalLimit = failure({ error: "server text", code: "free_external_limit" });
  assert.equal(
    jointInviteAcceptErrorMessage(externalLimit, en.formatMessage, "Acme"),
    "Acme is already in a channel with external members. Upgrade to Pro to connect another.",
  );
  assert.equal(
    jointInviteAcceptErrorMessage(externalLimit, zh.formatMessage, "Acme"),
    zh.formatMessage({ id: "externalInvite.error.targetFreeLimit" }, { target: "Acme" }),
  );
  assert.equal(jointInviteAcceptErrorMessage(externalLimit, en.formatMessage), "server text");
  // Other failures keep the server's reason (expired, already taken, not an admin).
  assert.equal(jointInviteAcceptErrorMessage(failure({ error: "Joint channel invite has expired" }), en.formatMessage), "Joint channel invite has expired");
  assert.equal(jointInviteAcceptErrorMessage(new Error("network"), en.formatMessage), "Couldn't accept the Joint Channel invite.");
});

test("the free-host cap on create and convert maps to localized copy; other failures are left to the caller", () => {
  const en = createIntl({ locale: "en", messages: enMessages as Record<string, string> });
  const zh = createIntl({ locale: "zh-cn", messages: zhMessages as Record<string, string> });
  const hostLimit = { response: { status: 403, data: { error: "server text", code: "joint_channel_free_limit_reached" } } };
  assert.equal(jointFreeHostLimitMessage(hostLimit, en.formatMessage), enMessages["channel.joint.freeHostLimitUnnamed"]);
  assert.equal(jointFreeHostLimitMessage(hostLimit, zh.formatMessage), zhMessages["channel.joint.freeHostLimitUnnamed"]);
  const named = { response: { status: 403, data: { error: "server text", code: "joint_channel_free_limit_reached", blockingChannel: { name: "partner-sync" } } } };
  assert.equal(
    jointFreeHostLimitMessage(named, en.formatMessage),
    "Your free server already hosts #partner-sync, a Joint Channel another server has joined. Upgrade to Pro to host more, or wait until all other servers leave #partner-sync.",
  );
  assert.equal(
    jointFreeHostLimitMessage(named, zh.formatMessage),
    "你的免费服务器已经发起了 #partner-sync，并且已有其他服务器加入。升级到 Pro 可以发起更多，或者等 #partner-sync 里的其他服务器全部退出。",
  );
  assert.equal(jointFreeHostLimitMessage({ response: { data: { code: "joint_free_server_limit" } } }, en.formatMessage), null);
  assert.equal(jointFreeHostLimitMessage(new Error("network"), en.formatMessage), null);
});


test("finite paid Joint limits are localized for host creation/conversion and invite acceptance", () => {
  const zh = createIntl({ locale: "zh-cn", messages: zhMessages as Record<string, string> });
  const err = { response: { data: { code: "joint_channel_plan_limit_reached", error: "English server fallback" } } };
  assert.equal(jointFreeHostLimitMessage(err, zh.formatMessage), zhMessages["channel.joint.hostPlanLimit"]);
  assert.equal(jointInviteAcceptErrorMessage(err, zh.formatMessage), zhMessages["channel.joint.inviteHostFreeLimit"]);
  assert.doesNotMatch(jointFreeHostLimitMessage(err, zh.formatMessage)!, /Free|Pro|English/);
});

// Guests in joint channels (P3, #wg-rbac:#25): the two refusals the host meets.
function refusal(code: string) {
  return { response: { status: 409, data: { code, error: "server-side English" } } };
}

test("converting with guests: guests_present and joint_party_limit read as sentences with the next step, en and zh-cn", () => {
  const enIntl = createIntl({ locale: "en", messages: enMessages });
  const zhIntl = createIntl({ locale: "zh-CN", messages: zhMessages });
  assert.equal(
    jointConversionGuestRefusalMessage(refusal("joint_party_limit"), "launch", enIntl.formatMessage),
    "#launch has too many guests for another server to connect. An external channel holds up to 30 servers and guests together. Remove some guests, then try again.",
  );
  assert.equal(
    jointConversionGuestRefusalMessage(refusal("joint_party_limit"), "launch", zhIntl.formatMessage),
    "#launch 的访客太多，无法再连接其他服务器。外部频道的服务器和访客加起来最多 30 个。请先移除部分访客，再重试。",
  );
  assert.equal(
    jointConversionGuestRefusalMessage(refusal("guests_present"), "launch", enIntl.formatMessage),
    "#launch has guests, so another server can't connect to it yet.",
  );
  assert.equal(jointConversionGuestRefusalMessage(refusal("joint_server_limit"), "launch", enIntl.formatMessage), null, "others are the caller's");
  assert.equal(jointConversionGuestRefusalMessage(new Error("offline"), "launch", enIntl.formatMessage), null);
});

test("disconnecting with guests bound: guests_present names the two ways forward, en and zh-cn", () => {
  const enIntl = createIntl({ locale: "en", messages: enMessages });
  const zhIntl = createIntl({ locale: "zh-CN", messages: zhMessages });
  assert.equal(
    jointDisconnectGuestRefusalMessage(refusal("guests_present"), "launch", enIntl.formatMessage),
    "#launch has guests, so this server can't disconnect from it. Remove the guests first, or archive the channel.",
  );
  assert.equal(
    jointDisconnectGuestRefusalMessage(refusal("guests_present"), "launch", zhIntl.formatMessage),
    "#launch 里有访客，这个服务器不能断开与它的连接。请先移除访客，或归档这个频道。",
  );
  assert.equal(jointDisconnectGuestRefusalMessage(refusal("host_cannot_disconnect"), "launch", enIntl.formatMessage), null);
  assert.equal(jointDisconnectGuestRefusalMessage(refusal("joint_party_limit"), "launch", enIntl.formatMessage), null);
});
