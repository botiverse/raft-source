import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render } from "@testing-library/react";

import { InlineThreadReplies } from "../src/components/message/InlineThreadReplies";
import type { ThreadReplyPreview } from "../src/store/threadRepliesReadModel";
import { TestIntlProvider } from "./helpers/intl";

// A page read with threadPreviewChars (channelPageQuery.ts) gets reply previews cut to 200 characters, which can end
// mid-link or mid-code-block: the inline reply row shows them as the text they are, never as Markdown.

afterEach(() => cleanup());

const cut = "See [the deploy notes](https://example.com/notes) and `pnpm run build` then **ship** it: ```ts\nconst x = [1, 2";

test("a cut reply preview with Markdown and link syntax shows as literal text", () => {
  const reply: ThreadReplyPreview & { truncated: boolean } = {
    messageId: "r1", seq: 2, preview: cut, truncated: true,
    senderId: "u2", senderType: "user", senderName: "Sam", senderAvatarUrl: null, createdAt: "2026-11-14T09:00:00.000Z",
  };
  const { container } = render(
    <TestIntlProvider>
      <InlineThreadReplies replies={[reply]} replyCount={3} unreadCount={0} hasDraft={false} onOpenThread={() => {}} />
    </TestIntlProvider>,
  );
  assert.ok(container.textContent?.includes(cut), "the preview's characters, as sent");
  assert.equal(container.querySelectorAll("a, code, pre, strong:not([role]), em").length, 0, "no link, code or emphasis drawn from it");
});
