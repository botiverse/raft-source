// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
// Install on the web (docs/contracts/runtime-auth.md §6e). Offered only where the server's runtime-auth read says so
// for that runtime (`runtimeInstall` and the Computer's `installableRuntimes`: runtime_install_button, a viewer who
// may act, the same people as Upgrade, a Computer that runs that runtime's installer), on the Computer page's
// "not installed" chip. A press reads the plan first and shows the exact commands and the vendor's page; only the
// confirm runs it. Where OAR will not run them (administrator rights, a missing tool, an unknown location) the
// steps are shown to run by hand, with no Install. Then one plain sentence per outcome.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RuntimeInstallPlan, RuntimeInstallResult } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import MachineRuntimeChips from "../src/components/machine/MachineRuntimeChips";
import { runtimeInstallCopy } from "../src/features/computer/runtimeInstallCopy";
import type { RuntimeInstallState } from "../src/features/computer/runtimeInstallCopy";
import { RuntimeAuthClient, runtimeInstallOffered } from "../src/utils/runtimeAuthClient";
import type { RuntimeAuthView } from "../src/utils/runtimeAuthClient";

// The commands render in raft-ui's CodeBlock, which measures itself with ResizeObserver; jsdom has none.
const originalResizeObserver = globalThis.ResizeObserver;
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
beforeEach(() => {
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = originalResizeObserver;
});

const BASE: RuntimeAuthView = {
  status: { collectedAt: "2026-11-17T10:00:00.000Z", runtimes: { claude: { kind: "logged_in" }, grok: { kind: "unavailable", reason: "not_installed" } } },
  availability: "ok",
  runtimes: ["claude", "codex", "grok"],
  logoutRuntimes: ["claude", "codex", "grok"],
  canAct: true,
};
const OFFERED: RuntimeAuthView = { ...BASE, runtimeInstall: true, installableRuntimes: ["grok"] };

const STEP = "curl -fsSL https://x.ai/cli/install.sh | bash";
const PLAN: RuntimeInstallPlan = { kind: "plan", steps: [STEP], source: "https://docs.x.ai/docs/grok-build" };

function fakeClient(view: RuntimeAuthView, answers: { plan?: () => Promise<{ plan: RuntimeInstallPlan }>; install?: () => Promise<{ result: RuntimeInstallResult }> } = {}) {
  const posts: Array<{ url: string; body: unknown }> = [];
  const http = {
    get: async <T,>() => view as T,
    post: async <T,>(url: string, body?: unknown) => {
      posts.push({ url, body });
      if (url.endsWith("/install-plan")) return (await (answers.plan ?? (async () => ({ plan: PLAN })))()) as T;
      if (url.endsWith("/install")) return (await (answers.install ?? (async () => assert.fail("never installs unasked")))()) as T;
      return assert.fail(`unexpected POST ${url}`);
    },
  };
  const socket = { current: () => null, onReplaced: () => () => {} };
  return { posts, client: new RuntimeAuthClient(http, socket) };
}

function chips(client: RuntimeAuthClient, canView = true) {
  render(
    <TestIntlProvider>
      <MachineRuntimeChips machineId="m1" machineRuntimeIds={[]} serverId="s1" canViewRuntimeAccountUsage={canView} runtimeAuthClient={client} />
    </TestIntlProvider>,
  );
  fireEvent.click(screen.getByTestId("machine-runtime-show-all"));
}

/**
 * The chip is a plain badge until the runtime-auth read offers Install, and
 * both carry the same test id: wait for the popover trigger before clicking,
 * or the click lands on the badge the read then replaces.
 */
async function openGrokCard() {
  const trigger = await waitFor(() => {
    const chip = screen.getByTestId("machine-runtime-chip-grok");
    assert.equal(chip.getAttribute("aria-haspopup"), "dialog", "Install offered: the chip opens a card");
    return chip;
  });
  fireEvent.click(trigger);
  return screen.findByTestId("machine-runtime-install-grok");
}

test("offered only with the server's say-so, to a viewer who may act, for a runtime the Computer can install", () => {
  assert.equal(runtimeInstallOffered(OFFERED, "grok"), true);
  assert.equal(runtimeInstallOffered(OFFERED, "qwen"), false, "the Computer did not report qwen installable");
  assert.equal(runtimeInstallOffered(BASE, "grok"), false, "no runtime_install_button, or an older server or Computer");
  assert.equal(runtimeInstallOffered({ ...OFFERED, canAct: false }, "grok"), false, "a viewer who may not act");
  assert.equal(runtimeInstallOffered(OFFERED, null), false, "a runtime with no sign-in id (Cursor)");
  assert.equal(runtimeInstallOffered(null, "grok"), false);
});

test("a not-installed chip offers Install only where it is offered", async () => {
  const { client } = fakeClient(BASE);
  chips(client);
  await act(async () => {});
  fireEvent.click(await screen.findByTestId("machine-runtime-chip-grok"));
  await act(async () => {});
  assert.ok(screen.queryByTestId("machine-runtime-install-grok") === null, "a plain chip where the read does not offer it");
  cleanup();

  const offered = fakeClient(OFFERED);
  chips(offered.client, false);
  await act(async () => {});
  fireEvent.click(await screen.findByTestId("machine-runtime-chip-grok"));
  await act(async () => {});
  assert.ok(screen.queryByTestId("machine-runtime-install-grok") === null, "a viewer who cannot see the Computer's runtime accounts gets no read and no Install");
});

test("Install shows the exact commands and the vendor's page first; only the confirm runs it, naming the runtime alone", async () => {
  let finish!: (answer: { result: RuntimeInstallResult }) => void;
  const { client, posts } = fakeClient(OFFERED, { install: () => new Promise((resolve) => { finish = resolve; }) });
  chips(client);
  fireEvent.click(await openGrokCard());

  assert.equal((await screen.findByTestId("runtime-install-steps")).textContent, STEP);
  assert.equal(screen.getByTestId("runtime-install-source").getAttribute("href"), "https://docs.x.ai/docs/grok-build");
  assert.deepEqual(posts.map((post) => post.url), ["/servers/s1/machines/m1/runtimes/grok/install-plan"], "reading the plan runs nothing");

  fireEvent.click(screen.getByTestId("runtime-install-confirm"));
  assert.match((await screen.findByTestId("runtime-install-outcome")).textContent ?? "", /Installing Grok Build on this Computer/);
  assert.deepEqual(posts.map((post) => post.url), [
    "/servers/s1/machines/m1/runtimes/grok/install-plan",
    "/servers/s1/machines/m1/runtimes/grok/install",
  ]);
  assert.ok(posts.every((post) => JSON.stringify(post.body) === JSON.stringify({ respondAsync: true })), "no command, URL or line from the web");

  await act(async () => finish({ result: { kind: "installed", version: "0.1.9" } }));
  assert.equal((await screen.findByTestId("runtime-install-outcome")).textContent, "Installed Grok Build 0.1.9.");
});

test("Cancel runs nothing", async () => {
  const { client, posts } = fakeClient(OFFERED);
  chips(client);
  fireEvent.click(await openGrokCard());
  await screen.findByTestId("runtime-install-steps");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => {});
  assert.ok(screen.queryByTestId("runtime-install-dialog") === null);
  assert.deepEqual(posts.map((post) => post.url), ["/servers/s1/machines/m1/runtimes/grok/install-plan"]);
});

test("where OAR needs administrator rights, the steps are shown to run by hand, with no Install", async () => {
  const manual: RuntimeInstallPlan = { kind: "unsupported", reason: "requires_privileges", detail: "The installer writes to /usr/local.", steps: ["sudo npm install -g @x/grok"], source: "https://docs.x.ai/docs/grok-build" };
  const { client, posts } = fakeClient(OFFERED, { plan: async () => ({ plan: manual }) });
  chips(client);
  fireEvent.click(await openGrokCard());
  assert.equal((await screen.findByTestId("runtime-install-steps")).textContent, "sudo npm install -g @x/grok");
  const dialog = screen.getByTestId("runtime-install-dialog").textContent ?? "";
  assert.match(dialog, /needs administrator rights/);
  assert.match(dialog, /The installer writes to \/usr\/local\./);
  assert.equal(screen.getByTestId("runtime-install-confirm").textContent, "Close");
  fireEvent.click(screen.getByTestId("runtime-install-confirm"));
  await act(async () => {});
  assert.deepEqual(posts.map((post) => post.url), ["/servers/s1/machines/m1/runtimes/grok/install-plan"], "nothing installed");
});

test("a Computer too old for Install is told to update the Computer first", async () => {
  const refused = Object.assign(new Error("409"), { response: { status: 409, data: { code: "computer_upgrade_required" } } });
  const { client } = fakeClient(OFFERED, { plan: async () => { throw refused; } });
  chips(client);
  fireEvent.click(await openGrokCard());
  assert.equal(
    (await screen.findByTestId("runtime-install-outcome")).textContent,
    "This Computer is too old to install runtimes from here. Update the Computer first.",
  );
});

test("one plain sentence per outcome", () => {
  const cases: Array<[RuntimeInstallState, string, "success" | "warning"]> = [
    [{ kind: "done", runtime: "grok", result: { kind: "installed", version: "0.1.9" } }, "machine.runtimeInstall.installedVersion", "success"],
    [{ kind: "done", runtime: "grok", result: { kind: "installed" } }, "machine.runtimeInstall.installed", "success"],
    [{ kind: "done", runtime: "grok", result: { kind: "already_installed" } }, "machine.runtimeInstall.alreadyInstalled", "success"],
    [{ kind: "done", runtime: "grok", result: { kind: "failed", exitCode: 1 } }, "machine.runtimeInstall.failed", "warning"],
    [{ kind: "done", runtime: "grok", result: { kind: "unsupported", reason: "platform" } }, "machine.runtimeInstall.unsupported.platform", "warning"],
    [{ kind: "done", runtime: "grok", result: { kind: "unsupported", reason: "line_required" } }, "machine.runtimeInstall.unsupported.other", "warning"],
    [{ kind: "done", runtime: "grok", result: { kind: "error", code: "in_progress" } }, "machine.runtimeInstall.inProgress", "warning"],
    [{ kind: "done", runtime: "grok", result: { kind: "error", code: "internal" } }, "machine.runtimeInstall.error", "warning"],
    [{ kind: "refused", runtime: "grok", reason: "computer_upgrade_required" }, "machine.runtimeInstall.computerTooOld", "warning"],
    [{ kind: "refused", runtime: "grok", reason: "computer_offline" }, "machine.runtimeInstall.computerOffline", "warning"],
    [{ kind: "refused", runtime: "grok", reason: "computer_timeout" }, "machine.runtimeInstall.timeout", "warning"],
    [{ kind: "refused", runtime: "grok", reason: "failed" }, "machine.runtimeInstall.error", "warning"],
  ];
  for (const [state, id, tone] of cases) {
    const copy = runtimeInstallCopy(state);
    assert.equal(copy?.id, id);
    assert.equal(copy?.tone, tone, id);
  }
  for (const quiet of [{ kind: "idle" }, { kind: "planning", runtime: "grok" }, { kind: "running", runtime: "grok" }] as const) {
    assert.equal(runtimeInstallCopy(quiet), null, `nothing is said for ${quiet.kind}`);
  }
});
