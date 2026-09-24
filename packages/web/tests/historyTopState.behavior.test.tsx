import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import HistoryTopState from "../src/components/message/HistoryTopState";

afterEach(cleanup);

test("available history is loaded by the timeline sentinel without a manual button", () => {
  const view = render(
    <HistoryTopState
      hasMore
      historyLimited={false}
      loadingOlder={false}
      noun="replies"
    />,
    { wrapper: TestIntlProvider },
  );

  assert.equal(screen.queryByRole("button", { name: /load older replies/i }), null);
  assert.equal(view.container.textContent, "");
});

test("automatic history loading keeps progress and terminal copy visible", () => {
  const view = render(
    <HistoryTopState
      hasMore
      historyLimited={false}
      loadingOlder
      noun="replies"
    />,
    { wrapper: TestIntlProvider },
  );
  assert.match(view.container.textContent ?? "", /Loading older replies/);

  view.rerender(
    <HistoryTopState
      hasMore={false}
      historyLimited={false}
      loadingOlder={false}
      noun="replies"
    />,
  );
  assert.match(view.container.textContent ?? "", /Beginning of replies/);

  view.rerender(
    <HistoryTopState
      hasMore={false}
      historyLimited
      loadingOlder={false}
      noun="replies"
    />,
  );
  assert.match(view.container.textContent ?? "", /Older replies are limited/);
});
