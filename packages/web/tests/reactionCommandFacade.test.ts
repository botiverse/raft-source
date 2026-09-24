import assert from "node:assert/strict";
import { test } from "node:test";

import api from "../src/api/client.js";
import {
  describeMessageReactionCommand,
  executeMessageReactionCommand,
} from "../src/store/reactionCommandFacade.js";

test("typed reaction facade maps set-interaction to the existing HTTP transport", async (t) => {
  const command = describeMessageReactionCommand({
    serverId: "server-a",
    messageId: "message-a",
    emoji: "👍",
    active: false,
  });
  assert.deepEqual(command, {
    kind: "set-interaction",
    target: { kind: "message", serverId: "server-a", id: "message-a" },
    interaction: "reaction",
    value: { emoji: "👍", active: false },
  });

  const response = { id: "message-a", channelId: "channel-a", reactions: [] };
  const request = t.mock.method(api, "request", async () => ({ data: response }));
  assert.equal(await executeMessageReactionCommand(command), response);
  assert.deepEqual(request.mock.calls[0]?.arguments[0], {
    method: "delete",
    url: "/messages/message-a/reactions",
    data: { emoji: "👍" },
  });
});
