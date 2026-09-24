import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import ConfirmDialog from "../src/components/ConfirmDialog";
import ResetAgentDialog from "../src/components/agent/ResetAgentDialog";
// ConfirmDialog is react-intl-migrated, so it needs an <IntlProvider> ancestor.
import { renderWithIntl as render } from "./helpers/intl";

afterEach(cleanup);

const noop = () => {};

test("plain rich-content messages do not inherit the confirmation warning frame", () => {
  render(
    <ConfirmDialog
      title="Restart Bernard"
      plainMessage
      message={<div data-testid="mode-picker">Mode picker</div>}
      confirmLabel="Restart"
      confirmColor="bg-brutal-cyan"
      onConfirm={noop}
      onClose={noop}
    />,
  );

  const frame = screen.getByTestId("mode-picker").parentElement;
  assert.ok(frame);
  assert.equal(frame.className, "mb-5");
  assert.equal(frame.querySelector("svg"), null, "plain rich content must not gain a warning icon");
  assert.doesNotMatch(frame.className, /border-2|bg-brutal-orange/);
});

test("ordinary confirmations use one compact content block and compact semantic actions", () => {
  render(
    <ConfirmDialog
      title="Leave channel"
      message={<div data-testid="warning-copy">Are you sure?</div>}
      confirmLabel="Leave"
      confirmColor="bg-brutal-orange"
      onConfirm={noop}
      onClose={noop}
    />,
  );

  const frame = screen.getByTestId("warning-copy").parentElement;
  assert.ok(frame);
  assert.equal(frame.getAttribute("data-slot"), "confirm-dialog-content");
  assert.doesNotMatch(frame.className, /border-2|bg-brutal-orange/);
  assert.equal(frame.querySelector("svg"), null, "confirmation copy must not repeat itself as a warning panel");

  const cancel = screen.getByRole("button", { name: "Cancel" });
  const confirm = screen.getByRole("button", { name: "Leave" });
  for (const action of [cancel, confirm]) {
    assert.match(action.className, /\bh-7\b/);
    assert.match(action.className, /\bpx-2\.5\b/);
    assert.match(action.className, /\btext-xs\b/);
  }
  assert.match(cancel.className, /\bbg-white\b/);
  assert.match(confirm.className, /\bbg-brutal-orange\b/);
});

test("destructive confirmations reserve red for the concrete destructive action", () => {
  render(
    <ConfirmDialog
      title="Delete server"
      message={<div data-testid="destructive-copy">This cannot be undone.</div>}
      onConfirm={noop}
      onClose={noop}
    />,
  );

  const frame = screen.getByTestId("destructive-copy").parentElement;
  assert.ok(frame);
  assert.equal(frame.getAttribute("data-slot"), "confirm-dialog-content");
  assert.doesNotMatch(frame.className, /border-2|bg-brutal-red/);
  assert.equal(frame.querySelector("svg"), null);
  assert.match(screen.getByRole("button", { name: "Delete" }).className, /\bbg-brutal-red\b/);
});

test("Reset Agent dialog renders the migrated zh surface under active zh-cn", () => {
  // Migrated in batch F (@AngLee rulings 2026-08-04): the dialog actions,
  // descriptions, title and loading now come from the catalog.
  render(
    <ResetAgentDialog agentId="agent-1" agentName="VPS-ADMIN" canFullReset onClose={noop} />,
    { locale: "zh-cn" },
  );

  assert.ok(screen.getByText("重新启动 VPS-ADMIN"));
  assert.ok(screen.getByText("重置会话并重启"));
  assert.ok(screen.getByText("完全重置并重启"));
  assert.ok(screen.getByText(/停止并重新启动 agent 进程/));
  // chromeLocale="active" — the shared chrome follows the active zh locale too.
  assert.ok(screen.getByRole("button", { name: "取消" }));
  assert.ok(screen.getByRole("button", { name: "关闭对话框" }));
  assert.equal(screen.queryByText("Restart"), null, "dialog copy must not stay English under zh-cn");
  assert.equal(screen.queryByText("Full Reset & Restart"), null);
});

test("Reset Agent full mode shows the zh permanent-delete warning with no English residue", () => {
  render(
    <ResetAgentDialog agentId="agent-1" agentName="VPS-ADMIN" canFullReset onClose={noop} />,
    { locale: "zh-cn" },
  );
  fireEvent.click(screen.getByText("完全重置并重启"));
  assert.ok(screen.getByText(/这会永久删除包括 MEMORY\.md 和 notes\/ 在内的所有工作区文件/));
  assert.equal(screen.queryByText(/permanently delete all workspace files/), null);
});

test("Reset Agent hides full workspace reset when only runtime control is granted", () => {
  render(
    <ResetAgentDialog
      agentId="agent-1"
      agentName="MEMBER-AGENT"
      canFullReset={false}
      memberRuntimeOnly
      onClose={noop}
    />,
  );

  assert.equal(screen.getAllByText("Restart Model").length, 2, "selected mode also labels confirm action");
  assert.ok(screen.getByText("Reset Model"));
  assert.equal(screen.queryByText("Restart"), null);
  assert.equal(screen.queryByText("Reset Session & Restart"), null);
  assert.equal(screen.queryByText("Full Reset & Restart"), null);
});

test("a fully migrated caller can opt the whole shared chrome into active zh-cn", () => {
  render(
    <ConfirmDialog
      chromeLocale="active"
      title="删除服务器"
      message="此操作无法撤销。"
      confirmLabel="删除服务器"
      loadingLabel="删除中…"
      onConfirm={noop}
      onClose={noop}
    />,
    { locale: "zh-cn" },
  );

  assert.equal(screen.getAllByText("删除服务器").length, 2, "title and confirm action share the locale");
  assert.ok(screen.getByText("此操作无法撤销。"));
  assert.ok(screen.getByRole("button", { name: "取消" }));
  assert.ok(screen.getByRole("button", { name: "关闭对话框" }));
  assert.equal(screen.queryByRole("button", { name: "Cancel" }), null);
});

// Rendered replacement for the former source-regex "disables close affordances
// while confirm is in flight" contract (agentDeleteDialogContract). Drives the
// real loading state via a pending confirm promise and asserts the user-visible
// result: close/cancel are disabled and the localized spinner + loading label
// render. Also pins that the labels resolve through the react-intl catalog
// (default confirm label "Delete", loading label "Processing…").
test("close and cancel affordances are disabled while the confirm action is in flight", async () => {
  let resolveConfirm = noop;
  const onConfirm = () =>
    new Promise<void>((resolve) => {
      resolveConfirm = resolve;
    });

  render(
    <ConfirmDialog
      title="Delete server"
      message={<div>This cannot be undone.</div>}
      confirmTestId="confirm-in-flight"
      onConfirm={onConfirm}
      onClose={noop}
    />,
  );

  const confirmButton = screen.getByTestId("confirm-in-flight");
  // Default confirm label comes from the catalog, not a hardcoded "Delete".
  assert.match(confirmButton.textContent ?? "", /Delete/);
  // Before confirming, close/cancel are enabled.
  const cancelButton = screen.getByRole("button", { name: "Cancel" });
  assert.equal((cancelButton as HTMLButtonElement).disabled, false);

  await act(async () => {
    fireEvent.click(confirmButton);
  });

  // Now in flight: the spinner + localized loading label render...
  await waitFor(() => assert.ok(screen.getByText("Processing…")));
  assert.ok(screen.getByRole("status", { name: "Processing" }), "spinner accessibility copy uses the same chrome locale");
  // ...the confirm button reports busy...
  assert.equal(confirmButton.getAttribute("aria-busy"), "true");
  // ...the header close button is disabled and relabeled for the busy state...
  const closeButton = screen.getByLabelText("Action in progress");
  assert.equal((closeButton as HTMLButtonElement).disabled, true);
  // ...and cancel is disabled so the action can't be abandoned mid-flight.
  assert.equal((cancelButton as HTMLButtonElement).disabled, true);

  await act(async () => {
    resolveConfirm();
  });
});

test("narrow confirmation actions wrap without shrinking labels into each other", () => {
  render(
    <ConfirmDialog
      title="Restart agent"
      message="Choose a restart mode."
      confirmLabel="Restart"
      loadingLabel="Restarting…"
      confirmTestId="narrow-confirm"
      onConfirm={noop}
      onClose={noop}
    />,
  );

  const confirmButton = screen.getByTestId("narrow-confirm");
  const cancelButton = screen.getByRole("button", { name: "Cancel" });
  const actions = confirmButton.parentElement;
  assert.ok(actions);
  assert.match(actions.className, /\bflex-wrap\b/, "actions must wrap when both labels cannot fit");
  assert.match(cancelButton.className, /\bshrink-0\b/);
  assert.match(cancelButton.className, /\bwhitespace-nowrap\b/);
  assert.match(confirmButton.className, /\bshrink-0\b/);
  assert.match(confirmButton.className, /\bwhitespace-nowrap\b/);
});

test("an unknown rejection uses the dialog chrome locale fallback", async () => {
  render(
    <ConfirmDialog
      title="Delete server"
      message="This cannot be undone."
      onConfirm={async () => {
        throw { reason: "closed-value rejection" };
      }}
      onClose={noop}
    />,
    { locale: "zh-cn" },
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  });

  assert.ok(screen.getByText("Something went wrong"), "default English surface keeps its fallback error English");
  assert.equal(screen.queryByText("出了点问题"), null);
});
