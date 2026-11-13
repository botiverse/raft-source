import "./helpers/domSetup";
import assert from "node:assert/strict";

import { useProfileStore } from "../src/store/profileStore";
import { useThreadStore } from "../src/store/threadStore";
import { openMessagePlace } from "../src/utils/messagePlace";
import type { MessagePlaceNav } from "../src/utils/messagePlace";

// #11969 review: "Open message" on a task message in an agent's activity is
// clicked from that agent's profile panel. The route moves to the task's
// conversation, but the focus is set before React applies it, so the
// store→URL sync it triggers saw the old profile still open and wrote
// `profile=` back onto the task URL (a second history entry, the profile
// stacked over the task dialog). The side panels follow the new URL first.

const originalProfile = useProfileStore.getState();
const originalThread = useThreadStore.getState();

afterEach(() => {
  useProfileStore.setState(originalProfile, true);
  useThreadStore.setState(originalThread, true);
  window.history.replaceState(null, "", "/");
});

test("a task message opened from an agent's profile panel closes the panel and lands on the message", () => {
  window.history.replaceState(null, "", "/channel/ch-agents?profile=agent:agent-1");
  useProfileStore.setState({ profileType: "agent", profileId: "agent-1" });

  const taskUrl = "/channel/ch-general?task=ch-general:task:task-7";
  const nav: MessagePlaceNav = {
    toMessage: () => assert.fail("not a channel message"),
    toDmMessage: () => assert.fail("not a DM message"),
    toThreadMessage: () => assert.fail("not a thread reply"),
    toTaskConversation: (_channel, _task, _kind, onNavigated) => {
      // As guardedNavigate: the URL has moved, React has not rendered it yet.
      window.history.pushState(null, "", taskUrl);
      onNavigated?.();
    },
  };

  openMessagePlace({
    kind: "task",
    taskId: "task-7",
    parentChannelId: "ch-general",
    parentRouteKind: "channel",
    conversationChannelId: "ch-task-7",
    messageId: "msg-3",
  }, nav);

  assert.equal(useProfileStore.getState().profileId, null, "the profile panel the click came from closes");
  assert.equal(useThreadStore.getState().taskModal?.taskId, "task-7");
  assert.equal(useThreadStore.getState().taskModal?.focusedMessageId, "msg-3", "the dialog lands on the message");
});
