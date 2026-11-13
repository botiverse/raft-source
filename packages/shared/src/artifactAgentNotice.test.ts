import assert from "node:assert/strict";

import { artifactAgentNoticeSchema } from "./artifactAgentNotice";

const xxchan = { type: "user", name: "xxchan" };
const excerpt = { id: "c_812", author: xxchan, version: 12, path: "components.html", createdAt: "2026-10-22T14:05:00.000Z", excerpt: "keep the old header", truncated: false, bodyChars: 19 };

test("the three notices parse; a comment notice needs at least one comment, a version notice at least one of your files", () => {
  const artifact = { id: "pt_abc", title: "Workspace prototype" };
  assert.ok(artifactAgentNoticeSchema.safeParse({ artifact, reason: "mentioned", following: null, comments: { count: 1, latest: [excerpt] }, version: null }).success);
  assert.ok(artifactAgentNoticeSchema.safeParse({ artifact, reason: "subscribed", following: { kind: "published", version: 12 }, comments: { count: 3, latest: [excerpt] }, version: null }).success);
  assert.ok(artifactAgentNoticeSchema.safeParse({
    artifact, reason: "your_file_changed", following: null, comments: null,
    version: { number: 14, publisher: { type: "agent", name: "Tenny" }, note: null, yourFiles: ["tech.html"], yourVersion: 12 },
  }).success);
  assert.ok(!artifactAgentNoticeSchema.safeParse({ artifact, reason: "mentioned", following: null, comments: { count: 1, latest: [] }, version: null }).success);
  assert.ok(!artifactAgentNoticeSchema.safeParse({ artifact, reason: "your_file_changed", following: null, comments: null, version: { number: 14, publisher: xxchan, note: null, yourFiles: [], yourVersion: 12 } }).success);
});
