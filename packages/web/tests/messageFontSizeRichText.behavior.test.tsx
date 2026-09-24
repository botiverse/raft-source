import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TestIntlProvider } from "./helpers/intl";

Object.assign(globalThis, { React });

const { default: MarkdownContent } = await import("../src/components/markdown/MarkdownContent");
const { MSG_REF_CHIP } = await import("../src/components/message/messageRefChip");
const { AttachmentCommentRefChip } = await import("../src/components/message/AttachmentCommentRefChip");

test("message rich text tokens inherit the message font-size scale", () => {
  const html = renderToStaticMarkup(
    <TestIntlProvider>
      <div className="text-[18px]">
        <MarkdownContent
          source={[
            "# Primary heading",
            "",
            "## Secondary heading",
            "",
            "### Tertiary heading",
            "",
            "Inline `code` keeps the message body scale.",
            "",
            "```ts",
            "const scaled = true;",
            "```",
          ].join("\n")}
        />
      </div>
    </TestIntlProvider>,
  );

  const inheritedTokenCount = html.match(/\[font-size:inherit\]/g)?.length ?? 0;
  assert.equal(inheritedTokenCount, 1);
  assert.match(html, /<h1\b[^>]*class="[^"]*text-\[1\.286em\][^"]*"[^>]*>Primary heading<\/h1>/);
  assert.match(html, /<h2\b[^>]*class="[^"]*text-\[1\.143em\][^"]*"[^>]*>Secondary heading<\/h2>/);
  assert.match(html, /<h3\b[^>]*class="[^"]*text-\[1\.071em\][^"]*"[^>]*>Tertiary heading<\/h3>/);
  assert.match(html, /<pre class="(?=[^"]*\[font-size:inherit\])(?=[^"]*font-mono)[^"]*"/);
  assert.match(
    html,
    /<code\b[^>]*class="(?=[^"]*\[font-size:0\.875em\])(?=[^"]*leading-\[1\.3em\])(?=[^"]*font-mono)[^"]*"/,
  );

  assert.match(MSG_REF_CHIP, /\[font-size:0\.875em\]/);
  assert.match(MSG_REF_CHIP, /leading-\[1\.3em\]/);
  assert.doesNotMatch(MSG_REF_CHIP, /text-sm|leading-\[21px\]/);
});

test("attachment comment-ref chip scales with the message body font-size preference", () => {
  const html = renderToStaticMarkup(
    <TestIntlProvider>
      <AttachmentCommentRefChip
        commentRef={{
          attachmentId: "att-1",
          filename: "notes.txt",
          hostMessageId: "host-1",
          hostSource: { type: "channel", routeKind: "channel", channelId: "chan-1" },
          anchorLabel: null,
          anchorQuote: null,
        }}
        commentsEnabled={true}
        onJumpToHost={() => {}}
        bodyFontSizeClass="text-[13px]"
      />
    </TestIntlProvider>,
  );

  // The chip wrapper carries the same font-size class the message body uses, and
  // the chip box itself is `[font-size:0.875em]` — so the "re:" chip stays one
  // step smaller while still scaling from the user's body size rather than the
  // outer base size (stdrc task #463).
  assert.match(html, /class="mb-0\.5 text-\[13px\]"/);
  assert.match(html, /\[font-size:0\.875em\]/);
});
