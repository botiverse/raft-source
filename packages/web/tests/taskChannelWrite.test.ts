import assert from "node:assert/strict";

import type { Channel } from "../src/store/channelStore";
import { canWriteTasksInChannel, offersMessageTaskActions } from "../src/components/task/taskChannelWrite";

// A public channel can be read without joining it, and the server refuses a
// reader's task writes (routes/tasks.ts rejectIfNoTaskWriteAccess: 403 "You
// must join this channel to modify tasks"; rejectIfArchived: 409). The browser
// reads the same answer off the channel row, so it offers no task action that
// can only fail.

function channel(overrides: Partial<Channel> = {}): Channel {
  return { id: "ch-1", name: "general", description: null, type: "channel", joined: true, ...overrides } as Channel;
}

test("a member writes tasks; a reader of a public channel they have not joined does not", () => {
  assert.equal(canWriteTasksInChannel(channel({ joined: true })), true);
  assert.equal(canWriteTasksInChannel(channel({ joined: false })), false);
  assert.equal(canWriteTasksInChannel(channel({ type: "private", joined: true })), true);
  assert.equal(canWriteTasksInChannel(channel({ type: "joint", joined: false })), false);
});

test("no task writes in an archived channel, member or not", () => {
  assert.equal(canWriteTasksInChannel(channel({ joined: true, archivedAt: "2026-11-01T00:00:00.000Z" })), false);
});

test("a DM has nothing to join: either side writes its tasks", () => {
  assert.equal(canWriteTasksInChannel(channel({ type: "dm", joined: undefined })), true);
  assert.equal(canWriteTasksInChannel(channel({ type: "dm", joined: false })), true);
});

test("a Lounge follows canPost, not joined (the first post joins it)", () => {
  assert.equal(canWriteTasksInChannel(channel({ loungeAgentId: "agent-1", joined: false })), true);
  assert.equal(canWriteTasksInChannel(channel({ loungeAgentId: "agent-1", joined: false, canPost: false })), false);
  assert.equal(canWriteTasksInChannel(channel({ loungeAgentId: "agent-1", joined: true, canPost: false })), false);
});

test("only a known no hides an action: a row not loaded, or membership not hydrated, stays writable", () => {
  // A deleted channel's tasks have no row, and the server lets them be closed.
  assert.equal(canWriteTasksInChannel(undefined), true);
  assert.equal(canWriteTasksInChannel(channel({ joined: undefined })), true);
});

test("a message's task actions: a known channel that is not a thread, for someone who may write its tasks", () => {
  assert.equal(offersMessageTaskActions(channel({ joined: true })), true);
  assert.equal(offersMessageTaskActions(channel({ type: "dm", joined: undefined })), true);
  assert.equal(offersMessageTaskActions(channel({ joined: false })), false, "a reader who has not joined");
  assert.equal(offersMessageTaskActions(channel({ joined: true, archivedAt: "2026-11-01T00:00:00.000Z" })), false);
  assert.equal(offersMessageTaskActions(channel({ type: "thread", joined: true })), false, "a reply carries no task");
  assert.equal(offersMessageTaskActions(undefined), false, "a channel not loaded offers none, as before");
});
