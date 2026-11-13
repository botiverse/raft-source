import assert from "node:assert/strict";

import { formatAttachmentComments, formatAttachmentUploaded } from "./_format";

// Byte pins: expected strings below are copied from the PRE-MOVE inline
// literals in upload.ts/comments.ts (print-seam S2), not from the new
// formatter code. The move must not change a single output byte.

test("formatAttachmentUploaded matches pre-move upload.ts bytes", () => {
  assert.equal(
    formatAttachmentUploaded({ id: "aaaa1111-0000-0000-0000-000000000000", filename: "spec.md", sizeBytes: 12595 }),
    "File uploaded: spec.md (12.3KB)\nAttachment ID: aaaa1111-0000-0000-0000-000000000000\n\nUse this ID with raft message send --attachment-id aaaa1111-0000-0000-0000-000000000000 to include it in a message.\n",
  );
});

test("formatAttachmentComments matches pre-move comments.ts bytes (empty and list)", () => {
  assert.equal(
    formatAttachmentComments("aaaa1111-0000-0000-0000-000000000000", [], null),
    "No comments on attachment aaaa1111.\n",
  );
  assert.equal(
    formatAttachmentComments(
      "aaaa1111-0000-0000-0000-000000000000",
      [
        {
          id: "bbbb2222-0000-0000-0000-000000000000",
          senderType: "user",
          senderName: "richard",
          content: "looks good",
          createdAt: "2026-08-31T08:00:00.000Z",
          reactions: [{ emoji: "✅", reactorType: "user", reactorId: "u1" }],
          anchor: { type: "lines", data: { start: 12, end: 18 } },
        },
        {
          id: "cccc3333-0000-0000-0000-000000000000",
          senderType: "agent",
          senderName: "Alice",
          content: "fixed",
          createdAt: "2026-08-31T08:01:00.000Z",
          reactions: [],
          anchor: null,
        },
      ],
      "thread-chan-1",
    ),
    "## Comments on attachment aaaa1111 (2)\n" +
      "[msg=bbbb2222 time=2026-08-31T08:00:00.000Z type=user] ✅ [anchor: L12–18] @richard: looks good\n" +
      "[msg=cccc3333 time=2026-08-31T08:01:00.000Z type=agent] @Alice: fixed\n" +
      "(full conversation lives in thread channel thread-chan-1)\n",
  );
});

test("formatAttachmentUploaded: uploaded to a task ref, the hint is the task reply (raft message send refuses task refs)", () => {
  const attachment = { id: "aaaa1111-0000-0000-0000-000000000000", filename: "spec.md", sizeBytes: 12595 };
  assert.equal(
    formatAttachmentUploaded(attachment, "#proj-launch:#2"),
    "File uploaded: spec.md (12.3KB)\nAttachment ID: aaaa1111-0000-0000-0000-000000000000\n\nUse this ID with raft task reply \"#proj-launch:#2\" --attachment-id aaaa1111-0000-0000-0000-000000000000 to include it in a reply in the task's conversation.\n",
  );
  // Any other target: the message send hint, byte-identical to before.
  assert.equal(
    formatAttachmentUploaded(attachment, "#proj-launch"),
    formatAttachmentUploaded(attachment),
  );
  assert.equal(
    formatAttachmentUploaded(attachment, "#proj-launch:abcd1234"),
    formatAttachmentUploaded(attachment),
  );
});
