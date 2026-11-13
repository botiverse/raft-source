import assert from "node:assert/strict";
import "./helpers/domSetup";

import { useChannelStore } from "../src/store/channelStore";
import {
  channelKeepsPrivateForExternal,
  externalInviteDaysLeft,
  externalInviteErrorMessageId,
  isExternallyInvitableChannel,
  parseEmailEntries,
} from "../src/components/channel/externalInvites";

// External channel invites, host side (#wg-rbac:#16, P2b-1): the pure parts
// of the client: splitting pasted text, which channels take invites, the
// days-left line and the friendly message for each server error.

test("pasted text splits on commas, semicolons, spaces and new lines, keeping entries as typed", () => {
  assert.deepEqual(
    parseEmailEntries(" lena@contoso.com, Sam@Acme.com\nraj@fabrikam.com;mia@globex.com  not-an-email,,\n"),
    ["lena@contoso.com", "Sam@Acme.com", "raj@fabrikam.com", "mia@globex.com", "not-an-email"],
  );
  assert.deepEqual(parseEmailEntries("  \n , ; "), []);
  // Duplicates stay: the server counts every raw entry against the 20 and
  // reports the copies in the preview.
  assert.deepEqual(parseEmailEntries("a@x.com a@x.com"), ["a@x.com", "a@x.com"]);
});

test("only a live ordinary channel of the current server, or a joint channel it hosts, takes external invites", () => {
  const base = { type: "channel" as const, name: "launch-plan", archivedAt: null, serverId: "s1" };
  assert.equal(isExternallyInvitableChannel(base, "s1"), true);
  assert.equal(isExternallyInvitableChannel({ ...base, type: "private" }, "s1"), true);
  assert.equal(isExternallyInvitableChannel({ ...base, type: "joint", jointRole: "host" }, "s1"), true, "a joint channel this server hosts");
  assert.equal(isExternallyInvitableChannel({ ...base, type: "joint", jointRole: "participant" }, "s1"), false, "another server's joint is the host's to share");
  assert.equal(isExternallyInvitableChannel({ ...base, type: "joint" }, "s1"), false, "a joint row without its role");
  assert.equal(isExternallyInvitableChannel({ ...base, type: "joint", jointRole: "host", archivedAt: "2026-10-01T00:00:00Z" }, "s1"), false);
  assert.equal(isExternallyInvitableChannel({ ...base, type: "dm" }, "s1"), false);
  assert.equal(isExternallyInvitableChannel({ ...base, name: "all" }, "s1"), false, "#all");
  assert.equal(isExternallyInvitableChannel({ ...base, archivedAt: "2026-10-01T00:00:00Z" }, "s1"), false);
  assert.equal(isExternallyInvitableChannel({ ...base, serverId: "s2" }, "s1"), false, "another server's channel");
  assert.equal(isExternallyInvitableChannel(base, null), false);
  assert.equal(isExternallyInvitableChannel(null, "s1"), false);
});

test("days left round up and never read 0 while the invite is open", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");
  assert.equal(externalInviteDaysLeft("2026-11-14T12:00:00Z", now), 14);
  assert.equal(externalInviteDaysLeft("2026-11-01T11:00:00Z", now), 1);
  assert.equal(externalInviteDaysLeft("2026-10-31T12:30:00Z", now), 1);
  assert.equal(externalInviteDaysLeft("2026-11-12T13:00:00Z", now), 13);
});

function apiError(status: number, code?: string) {
  return { response: { status, data: code ? { error: "server text", code } : { error: "server text" } } };
}

test("server errors map to friendly messages by code, then by status", () => {
  assert.equal(externalInviteErrorMessageId(apiError(429, "daily_cap")), "channel.externalInvite.error.dailyCap");
  assert.equal(externalInviteErrorMessageId(apiError(429)), "channel.externalInvite.error.dailyCap");
  assert.equal(externalInviteErrorMessageId(apiError(409, "free_external_limit")), "channel.externalInvite.error.freeLimit");
  assert.equal(externalInviteErrorMessageId(apiError(409, "channel_full")), "channel.externalInvite.error.channelFull");
  assert.equal(externalInviteErrorMessageId(apiError(409, "external_members_keep_private")), "channel.externalInvite.error.keepPrivate");
  assert.equal(externalInviteErrorMessageId(apiError(403, "channel_membership_required")), "channel.externalInvite.error.membershipRequired");
  assert.equal(externalInviteErrorMessageId(apiError(400, "make_private_required")), "channel.externalInvite.error.makePrivateRequired");
  assert.equal(externalInviteErrorMessageId(apiError(409, "connecting")), "channel.externalInvite.error.connecting");
  assert.equal(externalInviteErrorMessageId(apiError(409, "invite_not_pending")), "channel.externalInvite.error.notPending");
  assert.equal(externalInviteErrorMessageId(apiError(403, "forbidden")), "channel.externalInvite.error.forbidden");
  // The flag-off 404 carries no code.
  assert.equal(externalInviteErrorMessageId(apiError(404)), "channel.externalInvite.error.notFound");
  assert.equal(externalInviteErrorMessageId(apiError(500, "internal_server_error")), "channel.externalInvite.error.generic");
  assert.equal(externalInviteErrorMessageId(new Error("network")), "channel.externalInvite.error.generic");
});

// #12190: `hasExternalRelation` reaches only the channel's own non-guest
// members; a broadcast row or a joint projection update leaves it out. A patch
// without the key keeps the row's value; one that carries it overwrites it.
test("a channel patch without hasExternalRelation keeps it; one with it overwrites", () => {
  const row = { id: "c1", serverId: "s1", name: "launch-plan", description: null, type: "private", createdAt: "2026-10-01T00:00:00Z" };
  useChannelStore.setState({ channels: [{ ...row, hasExternalRelation: true }], dmChannels: [], channelActivity: {} } as never);
  const read = () => useChannelStore.getState().channels.find((channel) => channel.id === "c1")?.hasExternalRelation;

  useChannelStore.getState().applyChannelPatch({ ...row, description: "renamed elsewhere" } as never);
  assert.equal(read(), true, "a broadcast row without the key keeps it");
  assert.equal(useChannelStore.getState().channels[0]?.description, "renamed elsewhere", "the rest of the patch applies");

  useChannelStore.getState().applyChannelPatch({ ...row, hasExternalRelation: false } as never);
  assert.equal(read(), false, "the viewer's own row overwrites it");

  useChannelStore.getState().applyChannelPatch({ ...row, hasExternalRelation: true } as never);
  assert.equal(read(), true);
  useChannelStore.setState({ channels: [] } as never);
});

test("Make Public is blocked by hasExternalRelation when the row has it, else by what the viewer sees", () => {
  const priv = { type: "private" as const, serverId: "s1" };
  const guest = { role: "guest", serverId: "s1" };
  assert.equal(channelKeepsPrivateForExternal({ ...priv, hasExternalRelation: true }, [], []), true, "a channel admin without the invite list");
  assert.equal(channelKeepsPrivateForExternal({ ...priv, hasExternalRelation: false }, [{}], [guest]), false, "the server's answer wins");
  assert.equal(channelKeepsPrivateForExternal(priv, [{}], []), true, "older server: an open invite");
  assert.equal(channelKeepsPrivateForExternal(priv, [], [guest]), true, "older server: a local Guest");
  assert.equal(channelKeepsPrivateForExternal(priv, [], [{ role: "guest", serverId: "s2" }]), false, "another server's guest");
  assert.equal(channelKeepsPrivateForExternal(priv, [], [{ role: "member", serverId: "s1" }]), false);
  assert.equal(channelKeepsPrivateForExternal({ type: "channel", serverId: "s1", hasExternalRelation: true }, [], []), false, "public: nothing to block");
});
