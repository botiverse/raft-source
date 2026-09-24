import assert from "node:assert/strict";
import test from "node:test";
import { getDefaultAvatarDataUrl, resolveAvatarImageFetchTargetUrl } from "../src/utils/selectScreenshot";

test("share screenshot routes CDN avatar URLs through the API avatar endpoint", () => {
  assert.equal(
    resolveAvatarImageFetchTargetUrl(
      "https://cdn.example.com/avatars/0d67fa6a-6357-4c17-8ead-d29708752e52/0123456789abcdef0123456789abcdef.webp",
      "https://app.raft.build/s/demo/channel/channel-id",
    ),
    "/api/avatars/0d67fa6a-6357-4c17-8ead-d29708752e52/0123456789abcdef0123456789abcdef.webp",
  );
});

test("share screenshot leaves non-avatar image URLs on their original fetch path", () => {
  assert.equal(
    resolveAvatarImageFetchTargetUrl(
      "https://cdn.example.com/attachments/server-id/thumb.webp",
      "https://app.raft.build/s/demo/channel/channel-id",
    ),
    null,
  );
});

test("share screenshot fallback avatars stay visible and role-specific", () => {
  const human = decodeURIComponent(getDefaultAvatarDataUrl("human").split(",", 2)[1] ?? "");
  const agent = decodeURIComponent(getDefaultAvatarDataUrl("agent").split(",", 2)[1] ?? "");

  assert.match(human, /#BBAFE6/);
  assert.match(human, /<circle/);
  assert.match(agent, /#27CCF3/);
  assert.match(agent, /shape-rendering="crispEdges"/);
});
