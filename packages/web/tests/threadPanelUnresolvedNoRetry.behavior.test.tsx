import "./helpers/domSetup";

import assert from "node:assert/strict";
import { createRef } from "react";
import { cleanup, screen } from "@testing-library/react";
import { ThreadPanelResolvingShell } from "../src/features/thread/ThreadPanelResolvingShell";
import { renderWithIntl } from "./helpers/intl";

// #503: a thread whose link ids nothing resolves ends on the generic failure
// with no Retry (Retry would only resolve the same ids again); a lookup that
// failed for any other reason keeps Retry.

afterEach(cleanup);

function show(openThreadError: { unavailable?: boolean; unresolved?: boolean }) {
  renderWithIntl(
    <ThreadPanelResolvingShell
      panelClassName=""
      showHeader={false}
      mobileBackHandler={() => {}}
      handleClose={() => {}}
      closeButtonClassName=""
      resolveRegionRef={createRef<HTMLDivElement>()}
      resolveFailed
      handleRetryOpenThreadFocused={() => {}}
      openThreadError={openThreadError}
      currentServer={null}
      repliesLoadingSince={0}
    />,
  );
}

test("an unresolved anchor shows the failure without Retry", () => {
  show({ unavailable: false, unresolved: true });
  assert.ok(screen.getByTestId("thread-replies-load-failed"));
  assert.ok(screen.queryByTestId("thread-retry") === null, "no Retry");
});

test("a failed lookup that may pass keeps Retry", () => {
  show({ unavailable: false, unresolved: false });
  assert.ok(screen.getByTestId("thread-replies-load-failed"));
  assert.ok(screen.getByTestId("thread-retry"));
});
