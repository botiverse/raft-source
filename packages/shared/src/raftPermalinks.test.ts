import assert from "node:assert/strict";
import { isRaftAppHostname, parseRaftPermalink } from "./raftPermalinks";

test("parseRaftPermalink parses standard app.slock.ai permalinks", () => {
  const parsed = parseRaftPermalink(
    "https://app.slock.ai/s/botiverse/channel/89dce17f-1cd3-4db8-b08f-7b4141004b5a?msg=7556f881-a5f8-4b0d-88dc-8b5af28e8f05"
  );
  assert.deepEqual(parsed, {
    routeKind: "channel",
    serverSlug: "botiverse",
    channelId: "89dce17f-1cd3-4db8-b08f-7b4141004b5a",
    messageId: "7556f881-a5f8-4b0d-88dc-8b5af28e8f05",
    threadParentMessageId: null,
  });
});

test("parseRaftPermalink parses app.raft.build permalinks", () => {
  const parsed = parseRaftPermalink(
    "https://app.raft.build/s/botiverse/channel/89dce17f-1cd3-4db8-b08f-7b4141004b5a?msg=7556f881-a5f8-4b0d-88dc-8b5af28e8f05"
  );
  assert.deepEqual(parsed, {
    routeKind: "channel",
    serverSlug: "botiverse",
    channelId: "89dce17f-1cd3-4db8-b08f-7b4141004b5a",
    messageId: "7556f881-a5f8-4b0d-88dc-8b5af28e8f05",
    threadParentMessageId: null,
  });
});

test("parseRaftPermalink does not treat the API host as a permalink origin", () => {
  assert.equal(
    parseRaftPermalink(
      "https://api.raft.build/s/botiverse/channel/89dce17f-1cd3-4db8-b08f-7b4141004b5a?msg=7556f881-a5f8-4b0d-88dc-8b5af28e8f05"
    ),
    null
  );
});

test("parseRaftPermalink parses DM permalinks", () => {
  const parsed = parseRaftPermalink(
    "https://app.slock.ai/s/botiverse/dm/89dce17f-1cd3-4db8-b08f-7b4141004b5a?msg=7556f881-a5f8-4b0d-88dc-8b5af28e8f05"
  );
  assert.deepEqual(parsed, {
    routeKind: "dm",
    serverSlug: "botiverse",
    channelId: "89dce17f-1cd3-4db8-b08f-7b4141004b5a",
    messageId: "7556f881-a5f8-4b0d-88dc-8b5af28e8f05",
    threadParentMessageId: null,
  });
});

test("parseRaftPermalink parses thread permalinks", () => {
  const parsed = parseRaftPermalink(
    "https://app.slock.ai/s/botiverse/channel/89dce17f-1cd3-4db8-b08f-7b4141004b5a?thread=89dce17f-1cd3-4db8-b08f-7b4141004b5a%3A11111111-2222-3333-4444-555555555555&msg=7556f881-a5f8-4b0d-88dc-8b5af28e8f05"
  );
  assert.deepEqual(parsed, {
    routeKind: "channel",
    serverSlug: "botiverse",
    channelId: "89dce17f-1cd3-4db8-b08f-7b4141004b5a",
    messageId: "7556f881-a5f8-4b0d-88dc-8b5af28e8f05",
    threadParentMessageId: "11111111-2222-3333-4444-555555555555",
  });
});

test("parseRaftPermalink accepts the current host for self-hosted deployments", () => {
  const parsed = parseRaftPermalink(
    "https://chat.example.com/s/botiverse/channel/89dce17f-1cd3-4db8-b08f-7b4141004b5a?msg=7556f881-a5f8-4b0d-88dc-8b5af28e8f05",
    "chat.example.com",
  );
  assert.equal(parsed?.serverSlug, "botiverse");
});

test("parseRaftPermalink accepts configured host allowlists", () => {
  const parsed = parseRaftPermalink(
    "https://new.example.com/s/botiverse/channel/89dce17f-1cd3-4db8-b08f-7b4141004b5a?msg=7556f881-a5f8-4b0d-88dc-8b5af28e8f05",
    ["old.example.com", "new.example.com"],
  );
  assert.equal(parsed?.serverSlug, "botiverse");
});

test("parseRaftPermalink resolves thread-only URLs (no msg) to the thread parent", () => {
  const parsed = parseRaftPermalink(
    "https://app.slock.ai/s/botiverse/channel/89dce17f-1cd3-4db8-b08f-7b4141004b5a?thread=89dce17f-1cd3-4db8-b08f-7b4141004b5a%3A11111111-2222-3333-4444-555555555555"
  );
  assert.deepEqual(parsed, {
    routeKind: "channel",
    serverSlug: "botiverse",
    channelId: "89dce17f-1cd3-4db8-b08f-7b4141004b5a",
    messageId: "11111111-2222-3333-4444-555555555555",
    threadParentMessageId: "11111111-2222-3333-4444-555555555555",
  });
});

test("parseRaftPermalink rejects URLs without a message id", () => {
  assert.equal(
    parseRaftPermalink("https://app.slock.ai/s/botiverse/channel/89dce17f-1cd3-4db8-b08f-7b4141004b5a"),
    null
  );
});

// A permalink typed straight into Chinese prose has no space before the next
// word, so the autolinked URL swallows it. Only the leading id is the target.
test("parseRaftPermalink keeps only the leading message id when CJK text follows it", () => {
  const base = "https://app.slock.ai/s/botiverse/channel/89dce17f-1cd3-4db8-b08f-7b4141004b5a";
  assert.equal(
    parseRaftPermalink(`${base}?msg=7556f881-a5f8-4b0d-88dc-8b5af28e8f05这条你是不是没收到`)?.messageId,
    "7556f881-a5f8-4b0d-88dc-8b5af28e8f05",
  );
  assert.equal(
    parseRaftPermalink(`${base}?msg=7556f881-a5f8-4b0d-88dc-8b5af28e8f05，看一下`)?.messageId,
    "7556f881-a5f8-4b0d-88dc-8b5af28e8f05",
  );
  assert.equal(parseRaftPermalink(`${base}?msg=7556f881这条`)?.messageId, "7556f881");
  assert.deepEqual(
    parseRaftPermalink(`${base}?thread=89dce17f-1cd3-4db8-b08f-7b4141004b5a%3A11111111-2222-3333-4444-555555555555这个`),
    {
      routeKind: "channel",
      serverSlug: "botiverse",
      channelId: "89dce17f-1cd3-4db8-b08f-7b4141004b5a",
      messageId: "11111111-2222-3333-4444-555555555555",
      threadParentMessageId: "11111111-2222-3333-4444-555555555555",
    },
  );
});

test("parseRaftPermalink rejects message ids that are not a UUID or short id", () => {
  const base = "https://app.slock.ai/s/botiverse/channel/89dce17f-1cd3-4db8-b08f-7b4141004b5a";
  assert.equal(parseRaftPermalink(`${base}?msg=not-a-message`), null);
  assert.equal(parseRaftPermalink(`${base}?msg=这条`), null);
  // An id that runs on into more id characters is not silently truncated.
  assert.equal(parseRaftPermalink(`${base}?msg=7556f881-a5f8-4b0d-88dc-8b5af28e8f05abc`), null);
  assert.equal(parseRaftPermalink(`${base}?msg=abc123456789`), null);
});

test("isRaftAppHostname: the page's and the deployment's hosts and the fixed defaults, exact hostnames only", () => {
  assert.equal(isRaftAppHostname("app.raft.build"), true);
  assert.equal(isRaftAppHostname("raft.example.com", ["raft.example.com"]), true);
  assert.equal(isRaftAppHostname("example.com", ["raft.example.com"]), false);
  assert.equal(isRaftAppHostname("app.raft.build.evil.test"), false);
});
