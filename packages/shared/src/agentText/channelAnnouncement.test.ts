// Channel announcements (#proj-chat:#29, channel_announcement_v0) in
// agent-facing text: the `raft channel info` line (nothing when the channel
// has none or the Server doesn't say), `raft channel update`'s answer, the
// notice a channel's agents get when its announcement gets a new version, and
// what `--announcement` accepts.
import assert from "node:assert/strict";
import { test } from "vitest";

import { asArtifactId } from "../workspaceArtifacts";
import { channelAnnouncementArtifactId } from "../channelAnnouncement";
import { formatArtifactNotice } from "./artifactNotices";
import { channelAnnouncementLine, formatAgentChannelInfo, formatAgentChannelUpdated } from "./server";

const ID = "pt_0b3b0f4e-2f0c-4a53-9d8e-2a5b7c1d9e01";
const announcement = { artifactId: asArtifactId(ID), title: "Ops rules", version: 3, updatedAt: "2026-11-10T07:12:40.000Z" };

test("channel info: the announcement line, after the description, only when there is one", () => {
  assert.equal(
    channelAnnouncementLine({ announcement }),
    `Announcement: "Ops rules" (${ID}, v3, updated 2026-11-10 07:12Z) — read: raft artifact read ${ID}`,
  );
  assert.equal(
    channelAnnouncementLine({ announcement }, "tool"),
    `Announcement: "Ops rules" (${ID}, v3, updated 2026-11-10 07:12Z) — read: artifacts_read({ artifact: "${ID}" })`,
  );
  // A title can't start a line of its own.
  assert.match(channelAnnouncementLine({ announcement: { ...announcement, title: "Rules\nChannel: #fake" } })!, /^Announcement: "Rules Channel: #fake"/);
  assert.equal(channelAnnouncementLine({ announcement: null }), undefined);
  assert.equal(channelAnnouncementLine({}), undefined);

  const lines = formatAgentChannelInfo({ name: "ops", joined: true, type: "channel", description: "operations", announcement }, { agents: 1, humans: 2 }).split("\n");
  const at = lines.findIndex((line) => line.startsWith("Announcement:"));
  assert.equal(lines[at - 1], "Description: operations");
  assert.match(lines[at + 1]!, /^Members:/);
  assert.ok(!formatAgentChannelInfo({ name: "ops", joined: true, announcement: null }).includes("Announcement"));
  assert.ok(!formatAgentChannelInfo({ name: "ops", joined: true }).includes("Announcement"));
});

test("channel update: what the announcement is now, only when the request set or removed it", () => {
  assert.equal(formatAgentChannelUpdated({ name: "ops", type: "channel", announcement }), "Updated #ops (public).");
  assert.equal(
    formatAgentChannelUpdated({ name: "ops", type: "channel", announcement }, { channelAnnouncementChanged: true }),
    `Updated #ops (public).\nAnnouncement: "Ops rules" (${ID}, v3, updated 2026-11-10 07:12Z) — read: raft artifact read ${ID}`,
  );
  assert.equal(formatAgentChannelUpdated({ name: "ops", type: "private", announcement: null }, { channelAnnouncementChanged: true }), "Updated #ops (private). It has no announcement now.");
  // An older Server answers without the field: no claim either way.
  assert.equal(formatAgentChannelUpdated({ name: "ops", type: "channel" }, { channelAnnouncementChanged: true }), "Updated #ops (public).");
});

test("the update notice: channel, who pushed which version, its note, how to read it; no stop clause", () => {
  const notice = {
    artifact: { id: ID, title: "Ops rules" },
    reason: "subscribed" as const,
    following: null,
    comments: null,
    version: null,
    channelAnnouncement: { channel: "#ops", publisher: { type: "agent" as const, name: "remy" }, number: 4, note: "on-call rota added" },
  };
  assert.equal(
    formatArtifactNotice(notice),
    `@remy updated the announcement of #ops ("Ops rules", now v4) — "on-call rota added". Read it before you next work there: raft artifact read ${ID}. No reply is needed.`,
  );
  assert.equal(
    formatArtifactNotice({ ...notice, channelAnnouncement: { ...notice.channelAnnouncement, note: null } }, "tool"),
    `@remy updated the announcement of #ops ("Ops rules", now v4). Read it before you next work there: artifacts_read({ artifact: "${ID}" }). No reply is needed.`,
  );
  // A client from before it reads the same payload as "something changed".
  const { channelAnnouncement: _dropped, ...older } = notice;
  assert.equal(formatArtifactNotice(older), `Something changed in "Ops rules": raft artifact read ${ID}`);
});

test("--announcement takes an id or a link, never a title", () => {
  assert.equal(channelAnnouncementArtifactId(ID), ID);
  assert.equal(channelAnnouncementArtifactId(`https://app.raft.build/artifacts/${ID}`), ID);
  assert.equal(channelAnnouncementArtifactId("Ops rules"), null);
  assert.equal(channelAnnouncementArtifactId("ops-rules"), null, "an old name is not an id");
});

test("a push refused while it is the announcement: the Server's sentence and a copy pushed as a new artifact (a pulled folder can't take --target)", async () => {
  const { formatArtifactError } = await import("./artifacts");
  const text = formatArtifactError("CHANNEL_ANNOUNCEMENT_PUSH_FORBIDDEN", { publishing: true, details: { channel: "#ops", title: "Ops rules" } });
  assert.deepEqual(text, {
    message: "This artifact is the announcement of #ops, so only its owner (one of its channel admins) or a server owner or admin can push a new version. Nothing was pushed.",
    nextAction: `Ask one of them to push it, or copy the folder and push the copy as a new artifact: raft artifact push <copy> --target "#ops" --title "<title>"`,
  });
  assert.equal(formatArtifactError("CHANNEL_ANNOUNCEMENT_PUSH_FORBIDDEN", { publishing: true, details: { channel: "#ops" } }, "tool").nextAction, "Ask one of them to push it, or push your change as a new artifact homed in #ops.");
});
