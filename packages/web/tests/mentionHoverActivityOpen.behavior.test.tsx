import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { default: MentionHoverActivityPreview } = await import(
  "../src/components/message/MentionHoverActivityPreview"
);
const { TestIntlProvider } = await import("./helpers/intl");
import type { TrajectoryLogEntry } from "../src/store/agentStore";

/**
 * The recent-activity heading opens that agent's activity (task #608, @WAWQAQ).
 *
 * The heading ITSELF is the control, which is what was asked for. It therefore
 * must not carry `uppercase`: `clickableCaseContract` requires clickable labels
 * to be Title Case and reserves UPPERCASE for static dividers. Both halves are
 * asserted here, because satisfying one by breaking the other is the easy
 * mistake — my first attempt made the uppercase heading clickable, and the
 * second moved the action off the heading entirely.
 */

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function entry(index: number): TrajectoryLogEntry {
  return {
    timestamp: Date.UTC(2026, 0, 1, 8, 0, index),
    entry: {
      kind: "status",
      activity: "working",
      activityKind: "working",
      detail: `Step ${index}`,
      detailKind: "other",
    },
  } as TrajectoryLogEntry;
}

function renderPreview(onOpenActivity?: () => void) {
  return render(
    <TestIntlProvider>
      <MentionHoverActivityPreview
        entries={[entry(1), entry(2)]}
        formatTimestamp={() => "08:00:01"}
        onOpenActivity={onOpenActivity}
      />
    </TestIntlProvider>,
  );
}

test("the recent-activity heading is itself the control and opens the activity", () => {
  let opened = 0;
  renderPreview(() => { opened += 1; });

  const heading = screen.getByTestId("mention-hover-activity-open");
  assert.equal(heading.tagName, "BUTTON", "the heading itself must be the control");
  assert.match(
    heading.textContent ?? "",
    /Recent activity/,
    "the control must BE the heading, not a separate action beside it",
  );
  fireEvent.click(heading);
  assert.equal(opened, 1);
});

test("the clickable heading is Title Case, not uppercase", () => {
  renderPreview(() => undefined);
  const heading = screen.getByTestId("mention-hover-activity-open");
  assert.doesNotMatch(
    heading.className,
    /\buppercase\b/,
    "clickableCaseContract: a clickable label must not carry `uppercase`",
  );
});

test("without an opener the heading stays a static divider and no dead control renders", () => {
  renderPreview(undefined);
  assert.equal(
    screen.queryByTestId("mention-hover-activity-open") === null,
    true,
    "a heading with nowhere to go must not look clickable",
  );
  // Static dividers keep UPPERCASE, and the rows still render.
  assert.equal(screen.getAllByTestId("mention-hover-activity-row").length, 2);
});
