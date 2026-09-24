import assert from "node:assert/strict";
import test from "node:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PendingMentionActionStrip } from "../src/components/message/PendingMentionActionStrip";
import type { PendingMentionAction } from "../src/store/messageStore";
import { TestIntlProvider } from "./helpers/intl";

function action(overrides: Partial<PendingMentionAction> = {}): PendingMentionAction {
  return {
    resolutionId: "resolution-1",
    messageId: "message-1",
    targetType: "agent",
    targetHandle: "Noel",
    reason: "not in channel",
    availableActions: ["add", "notify"],
    targetAvatarUrl: null,
    expiresAt: null,
    ...overrides,
  };
}

test.afterEach(() => {
  cleanup();
});

test("pending mention strip keeps the compact neutral treatment and exposes recovery actions", () => {
  const calls: Array<[string, "added" | "notified"] | ["dismiss", string]> = [];

  render(
    <PendingMentionActionStrip
      actions={[action({ availableActions: ["invite", "notify_only"] })]}
      actionState={{}}
      actionRemoving={{}}
      actionExecuting={{}}
      channelName="launch"
      onMarkAction={(resolutionId, state) => calls.push([resolutionId, state])}
      onAddAllActions={() => undefined}
      onDismissAction={(resolutionId) => calls.push(["dismiss", resolutionId])}
    />,
    { wrapper: TestIntlProvider },
  );

  const strip = screen.getByTestId("pending-mention-action-strip");
  const row = screen.getByTestId("pending-mention-action-rows").querySelector(":scope > div") as HTMLElement;
  assert.match(strip.className, /\bw-full\b/);
  assert.match(strip.className, /\bbg-brutal-cream\b/);
  assert.doesNotMatch(strip.className, /\bbg-soft-signal\b/);
  assert.doesNotMatch(strip.className, /\bml-12\b/);
  assert.doesNotMatch(strip.className, /\bmr-2\b/);
  assert.doesNotMatch(strip.textContent ?? "", /Undelivered mentions/);
  assert.doesNotMatch(strip.textContent ?? "", /Message sent, but these @mentions were not delivered/);
  assert.match(strip.textContent ?? "", /@Noel/);
  assert.match(strip.textContent ?? "", /@Noel was not notified because they are not in #launch/);
  assert.match(strip.textContent ?? "", /N/);
  assert.match(row.className, /\bflex-col\b/);
  assert.match(row.className, /\bsm:flex-row\b/);
  const buttons = within(row).getByTestId("pending-mention-action-buttons");
  assert.match(buttons.className, /\bw-full\b/);
  assert.match(buttons.className, /\bsm:w-auto\b/);
  const status = within(row).getByTestId("pending-mention-action-status");
  assert.match(status.className, /\bline-clamp-2\b/);
  assert.match(status.className, /\bsm:line-clamp-none\b/);
  assert.match(status.className, /\bsm:truncate\b/);

  fireEvent.click(within(strip).getByRole("button", { name: "Add" }));
  fireEvent.click(within(strip).getByRole("button", { name: "Notify" }));
  fireEvent.click(within(strip).getByRole("button", { name: "Ignore" }));

  assert.deepEqual(calls, [
    ["resolution-1", "added"],
    ["resolution-1", "notified"],
    ["dismiss", "resolution-1"],
  ]);
});

test("pending mention strip respects action availability and local states", () => {
  render(
    <PendingMentionActionStrip
      actions={[
        action({ resolutionId: "notify-only", targetHandle: "@Ada", availableActions: ["notify_only"] }),
        action({ resolutionId: "notify-direct", targetHandle: "Nia", availableActions: ["notify"] }),
        action({ resolutionId: "add-only", targetType: "user", targetHandle: "Bao", availableActions: ["invite"] }),
        action({ resolutionId: "add-direct", targetType: "user", targetHandle: "Cal", availableActions: ["add"] }),
        action({ resolutionId: "external-handle", targetType: "external", targetHandle: "ghost", availableActions: [] }),
        action({ resolutionId: "spaced-initial", targetType: "agent", targetHandle: "@  Zoe", availableActions: [] }),
        action({ resolutionId: "internal-at-initial", targetType: "external", targetHandle: " @Zed", availableActions: [] }),
        action({ resolutionId: "blank-initial", targetType: "external", targetHandle: "   ", availableActions: [] }),
        action({ resolutionId: "added", targetHandle: "Cara", availableActions: ["add", "notify"] }),
        action({ resolutionId: "notified", targetHandle: "Dee", availableActions: ["add", "notify"] }),
      ]}
      actionState={{ added: "added", notified: "notified" }}
      actionRemoving={{ "add-only": true }}
      actionExecuting={{ "notify-only": "notified" }}
      channelName="#general"
      onMarkAction={() => undefined}
      onAddAllActions={() => undefined}
      onDismissAction={() => undefined}
    />,
    { wrapper: TestIntlProvider },
  );

  const rows = screen.getByTestId("pending-mention-action-rows").querySelectorAll(":scope > div");
  assert.equal(rows.length, 10);

  assert.match(rows[0]?.textContent ?? "", /@Ada was not notified because they are not in #general/);
  assert.doesNotMatch(rows[0]?.textContent ?? "", /@@Ada/);
  assert.match(rows[0]?.innerHTML ?? "", />A<\/span>/);
  assert.equal(within(rows[0] as HTMLElement).queryAllByTestId("pending-mention-target-avatar").length, 0);
  assert.equal(within(rows[0] as HTMLElement).queryAllByTestId("pending-mention-target-initial").length, 1);
  assert.match(rows[0]?.className ?? "", /opacity-100/);
  assert.equal(within(rows[0] as HTMLElement).queryAllByRole("button", { name: "Add" }).length, 0);
  assert.equal(within(rows[0] as HTMLElement).getByRole("button", { name: "Notify" }).hasAttribute("disabled"), true);

  assert.match(rows[1]?.textContent ?? "", /@Nia was not notified because they are not in #general/);
  assert.equal(within(rows[1] as HTMLElement).queryAllByRole("button", { name: "Add" }).length, 0);
  assert.equal(within(rows[1] as HTMLElement).queryAllByRole("button", { name: "Notify" }).length, 1);

  assert.match(rows[2]?.className ?? "", /opacity-0/);
  assert.match(rows[2]?.textContent ?? "", /@Bao was not notified because they are not in #general/);
  assert.match(rows[2]?.innerHTML ?? "", />B<\/span>/);
  assert.equal(within(rows[2] as HTMLElement).queryAllByRole("button", { name: "Notify" }).length, 0);
  assert.equal(within(rows[2] as HTMLElement).queryAllByRole("button", { name: "Add" }).length, 1);

  assert.match(rows[3]?.textContent ?? "", /@Cal was not notified because they are not in #general/);
  assert.match(rows[3]?.innerHTML ?? "", />C<\/span>/);
  assert.equal(within(rows[3] as HTMLElement).queryAllByRole("button", { name: "Add" }).length, 1);
  assert.equal(within(rows[3] as HTMLElement).queryAllByRole("button", { name: "Notify" }).length, 0);

  assert.match(rows[4]?.textContent ?? "", /ghost was not notified because they are not in #general/);
  assert.doesNotMatch(rows[4]?.textContent ?? "", /@ghost/);
  assert.match(rows[4]?.innerHTML ?? "", />G<\/span>/);
  assert.equal(within(rows[4] as HTMLElement).queryAllByRole("button", { name: "Add" }).length, 0);
  assert.equal(within(rows[4] as HTMLElement).queryAllByRole("button", { name: "Notify" }).length, 0);

  assert.match(rows[5]?.textContent ?? "", /@  Zoe was not notified because they are not in #general/);
  assert.match(rows[5]?.innerHTML ?? "", />Z<\/span>/);
  assert.equal(within(rows[5] as HTMLElement).queryAllByTestId("pending-mention-target-avatar").length, 0);

  assert.match(rows[6]?.textContent ?? "", / @Zed was not notified because they are not in #general/);
  assert.match(rows[6]?.innerHTML ?? "", />@<\/span>/);

  assert.match(rows[7]?.innerHTML ?? "", />\?<\/span>/);

  assert.match(rows[8]?.textContent ?? "", /@Cara was added to #general/);
  assert.equal(within(rows[8] as HTMLElement).queryAllByRole("button", { name: "Add" }).length, 0);
  assert.equal(within(rows[8] as HTMLElement).getByText("Added").textContent, "Added");

  assert.match(rows[9]?.textContent ?? "", /Notification queued for @Dee/);
  assert.equal(within(rows[9] as HTMLElement).queryAllByRole("button", { name: "Notify" }).length, 0);
  assert.equal(within(rows[9] as HTMLElement).getByText("Queued").textContent, "Queued");
});

test("pending mention strip renders real target avatars only when avatar metadata is present", () => {
  render(
    <PendingMentionActionStrip
      actions={[
        action({ resolutionId: "agent-avatar", targetHandle: "Viewer", targetAvatarUrl: "pixel:random:Viewer" }),
        action({ resolutionId: "agent-fallback", targetHandle: "NoAvatar", targetAvatarUrl: null }),
        action({ resolutionId: "human-avatar", targetType: "user", targetHandle: "HumanAvatar", targetAvatarUrl: "pixel:random:HumanAvatar" }),
        action({ resolutionId: "external-avatar", targetType: "external", targetHandle: "Ghost", targetAvatarUrl: "pixel:random:Ghost" }),
      ]}
      actionState={{}}
      actionRemoving={{}}
      actionExecuting={{}}
      channelName="launch"
      onMarkAction={() => undefined}
      onAddAllActions={() => undefined}
      onDismissAction={() => undefined}
    />,
    { wrapper: TestIntlProvider },
  );

  const rows = screen.getByTestId("pending-mention-action-rows").querySelectorAll(":scope > div");
  assert.equal(rows.length, 4);

  const avatarRow = rows[0] as HTMLElement;
  assert.equal(within(avatarRow).queryAllByTestId("pending-mention-target-avatar").length, 1);
  assert.equal(within(avatarRow).queryAllByTestId("pending-mention-target-initial").length, 0);
  assert.doesNotMatch(avatarRow.innerHTML, />V<\/span>/);
  assert.match(avatarRow.innerHTML, /bg-brutal-cyan/);
  assert.match(avatarRow.innerHTML, /grid/);

  const fallbackRow = rows[1] as HTMLElement;
  assert.equal(within(fallbackRow).queryAllByTestId("pending-mention-target-avatar").length, 0);
  assert.equal(within(fallbackRow).queryAllByTestId("pending-mention-target-initial").length, 1);
  assert.match(fallbackRow.innerHTML, />N<\/span>/);
  assert.doesNotMatch(fallbackRow.innerHTML, /grid/);

  const humanRow = rows[2] as HTMLElement;
  assert.equal(within(humanRow).queryAllByTestId("pending-mention-target-avatar").length, 1);
  assert.equal(within(humanRow).queryAllByTestId("pending-mention-target-initial").length, 0);
  assert.doesNotMatch(humanRow.innerHTML, />H<\/span>/);
  assert.match(humanRow.innerHTML, /bg-brutal-lavender/);
  assert.match(humanRow.innerHTML, /grid/);

  const externalRow = rows[3] as HTMLElement;
  assert.equal(within(externalRow).queryAllByTestId("pending-mention-target-avatar").length, 0);
  assert.equal(within(externalRow).queryAllByTestId("pending-mention-target-initial").length, 1);
  assert.match(externalRow.innerHTML, />G<\/span>/);
  assert.doesNotMatch(externalRow.innerHTML, /grid/);
});

test("pending mention strip offers one bottom-right batch add for all eligible unresolved rows", () => {
  const calls: string[][] = [];
  const { rerender } = render(
    <PendingMentionActionStrip
      actions={[
        action({ resolutionId: "add-first", targetHandle: "Tommy", availableActions: ["add", "notify"] }),
        action({ resolutionId: "notify-only", targetHandle: "Noel", availableActions: ["notify_only"] }),
        action({ resolutionId: "add-second", targetHandle: "King", availableActions: ["invite"] }),
        action({ resolutionId: "already-added", targetHandle: "Ada", availableActions: ["add"] }),
        action({ resolutionId: "removing", targetHandle: "Nia", availableActions: ["add"] }),
      ]}
      actionState={{ "already-added": "added" }}
      actionRemoving={{ removing: true }}
      actionExecuting={{}}
      channelName="mobile"
      onMarkAction={() => undefined}
      onAddAllActions={(resolutionIds) => calls.push(resolutionIds)}
      onDismissAction={() => undefined}
    />,
    { wrapper: TestIntlProvider },
  );

  const footer = screen.getByTestId("pending-mention-action-footer");
  assert.match(footer.className, /\bjustify-end\b/);
  assert.match(footer.className, /\bborder-t-2\b/);
  const addAll = within(footer).getByRole("button", { name: "Add all" }) as HTMLButtonElement;
  assert.equal(addAll.disabled, false);
  fireEvent.click(addAll);
  assert.deepEqual(calls, [["add-first", "add-second"]]);

  rerender(
    <PendingMentionActionStrip
      actions={[
        action({ resolutionId: "add-first", targetHandle: "Tommy", availableActions: ["add", "notify"] }),
        action({ resolutionId: "add-second", targetHandle: "King", availableActions: ["invite"] }),
      ]}
      actionState={{}}
      actionRemoving={{}}
      actionExecuting={{ "add-second": "added" }}
      channelName="mobile"
      onMarkAction={() => undefined}
      onAddAllActions={(resolutionIds) => calls.push(resolutionIds)}
      onDismissAction={() => undefined}
    />,
  );
  assert.equal((screen.getByRole("button", { name: "Add all" }) as HTMLButtonElement).disabled, true);
});

test("pending mention strip does not duplicate a single eligible Add with Add all", () => {
  render(
    <PendingMentionActionStrip
      actions={[
        action({ resolutionId: "add-only", targetHandle: "Tommy", availableActions: ["add"] }),
        action({ resolutionId: "notify-only", targetHandle: "Noel", availableActions: ["notify"] }),
      ]}
      actionState={{}}
      actionRemoving={{}}
      actionExecuting={{}}
      channelName="mobile"
      onMarkAction={() => undefined}
      onAddAllActions={() => undefined}
      onDismissAction={() => undefined}
    />,
    { wrapper: TestIntlProvider },
  );

  assert.equal(screen.queryByRole("button", { name: "Add all" }), null);
  assert.ok(screen.getByRole("button", { name: "Add" }));
});
