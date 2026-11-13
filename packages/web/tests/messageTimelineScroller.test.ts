import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MessageTimeline from "../src/components/message/MessageTimeline";
import { TestIntlProvider } from "./helpers/intl";

// The timeline's scroller (VirtualMessageTimeline on raft-ui VirtualList).
// Scrolling itself needs layout, which jsdom does not provide: it is tested
// in a real browser (tests/e2e/tests/virtual-timeline.spec.ts and the other
// timeline specs). These pin what holds without layout.

test("the rendered scroller style disables native overflow anchoring", () => {
  // The list compensates size changes itself (keeps the rows in view in
  // place); browser-native overflow anchoring would apply them a second time.
  const markup = renderToStaticMarkup(
    createElement(TestIntlProvider, null, createElement(MessageTimeline, {
      source: {
        messages: [],
        hasOlder: false,
        hasNewer: false,
        loading: false,
        loadOlder: () => {},
        loadNewer: () => {},
      },
      renderItem: () => null,
    })),
  );

  assert.match(
    markup,
    /overflow-anchor:none/,
    "runtime markup must opt the scroller out of browser-native overflow anchoring",
  );
});

