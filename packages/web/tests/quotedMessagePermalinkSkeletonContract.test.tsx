import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render } from "@testing-library/react";
import type { ParsedRaftPermalink } from "@botiverse/raft-shared";
import api from "../src/api/client";
import QuotedMessagePermalinkPreview from "../src/components/message/QuotedMessagePermalinkPreview";
import { TestIntlProvider } from "./helpers/intl";

const originalGet = api.get;

afterEach(() => {
  cleanup();
  api.get = originalGet;
});

test("quoted message permalink loading skeleton keeps placeholder bars as horizontal lines", () => {
  api.get = (() => new Promise(() => {})) as typeof api.get;

  const permalink: ParsedRaftPermalink = {
    routeKind: "channel",
    serverSlug: "server",
    channelId: "channel-1",
    messageId: "message-1",
    threadParentMessageId: null,
  };

  const { container } = render(
    <TestIntlProvider>
      <QuotedMessagePermalinkPreview permalink={permalink} onOpen={() => undefined} />
    </TestIntlProvider>,
  );

  const bars = [...container.querySelectorAll("div")].filter((el) =>
    /(^|\s)bg-black\/10(\s|$)/.test(el.className),
  );
  assert.ok(bars.length >= 1, "loading preview must paint placeholder bars");
  const last = bars[bars.length - 1]!;
  assert.match(
    last.className,
    /(^|\s)h-3(\s|$)/,
    "the final skeleton placeholder must stay a 3-tall line",
  );
  assert.match(
    last.className,
    /(^|\s)w-3\/4(\s|$)/,
    "the final skeleton placeholder must be a 75%-width line, not a square",
  );
  assert.doesNotMatch(
    last.className,
    /(^|\s)size-3\/4(\s|$)/,
    "`size-3/4` creates a tall square that overflows the preview border",
  );
});
