import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveAgentActivityBarPresentation } from "../src/components/layout/LiveAgentActivityBar";
import { TestIntlProvider } from "./helpers/intl";

test("LiveAgentActivityBar matches agent header status typography and hides when inactive", () => {
  const inactive = renderToStaticMarkup(
    createElement(TestIntlProvider, null,
      createElement(LiveAgentActivityBarPresentation, { latest: null }),
    ),
  );

  assert.equal(inactive, "");

  const active = renderToStaticMarkup(
    createElement(TestIntlProvider, null,
      createElement(LiveAgentActivityBarPresentation, {
        latest: {
          id: "activity-1",
          kind: "activity",
          agentId: "agent-1",
          agentName: "Runner",
          agentAvatarUrl: null,
          text: "Running tests",
          context: null,
          activity: "working",
          createdAt: 123,
        },
      }),
    ),
  );

  assert.match(active, /gap-1\.5/);
  assert.match(active, /text-sm text-black\/60 font-mono/);
  assert.match(active, /flex min-h-8 items-center gap-2/);
  assert.doesNotMatch(active, /transition-transform/);
  assert.match(active, /Running tests/);
  assert.doesNotMatch(active, /Agent activity will appear here/);
});

test("LiveAgentActivityBar formats stored descriptors with the active app locale", () => {
  const active = renderToStaticMarkup(
    createElement(TestIntlProvider, { locale: "zh-cn" },
      createElement(LiveAgentActivityBarPresentation, {
        latest: {
          id: "activity-zh",
          kind: "activity",
          agentId: "agent-1",
          agentName: "Runner",
          agentAvatarUrl: null,
          text: "Thinking…",
          textDescriptor: { primary: { id: "activity.status.thinkingEllipsis" } },
          context: null,
          activity: "thinking",
          createdAt: 123,
        },
      }),
    ),
  );

  assert.match(active, /思考中…/);
  assert.doesNotMatch(active, /Thinking…/);
});
