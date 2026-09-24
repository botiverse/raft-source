import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import api from "../src/api/client.js";
import { useMessageStore } from "../src/store/messageStore.js";
import { reactionReadModelStore } from "../src/store/reactionReadModels.js";
import {
  hydrateReactionViewerSnapshot,
  resetReactionViewerHydratesForTests,
} from "../src/store/reactionViewerReadModel.js";
import { useServerStore } from "../src/store/serverStore.js";

afterEach(() => {
  resetReactionViewerHydratesForTests();
  reactionReadModelStore.getState().reset();
  useMessageStore.setState({ currentUserId: null });
  useServerStore.setState({ current: null });
});

test("cold viewer GET enters the same versioned complete-snapshot projector", async (t) => {
  useServerStore.setState({
    current: {
      id: "server-a",
      name: "Server A",
      slug: "server-a",
      ownerId: "principal-a",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-13T00:00:00.000Z",
    },
  });
  useMessageStore.getState().setCurrentUserId("principal-a");
  const get = t.mock.method(api, "get", async () => ({
    data: {
      serverId: "server-a",
      messageId: "message-a",
      viewerVersion: 4,
      reactedEmojis: ["👍"],
    },
  }));

  assert.deepEqual(await hydrateReactionViewerSnapshot({
    principalId: "principal-a",
    serverId: "server-a",
    messageId: "message-a",
  }), { kind: "applied" });
  assert.equal(get.mock.calls[0]?.arguments[0], "/messages/message-a/reactions/viewer");
  assert.deepEqual(
    reactionReadModelStore.getState().readViewerOverlay(
      "principal-a",
      "server-a",
      "message-a",
      "👍",
    ),
    { status: "loaded", reactedByMe: true },
  );
  assert.deepEqual([...reactionReadModelStore.getState().viewerVersions.values()], [4]);
});
