// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
// Upgrade on the web (docs/contracts/runtime-auth.md §6d). Offered only where the server's runtime-auth read says so
// for that runtime (`runtimeUpgrade` and the Computer's `upgradableRuntimes`: runtime_upgrade_button, a viewer who may
// act, a Computer that runs that runtime's updater):
// - the runtime's card on the Computer page, where the Computer's update check found a newer version (or it reported
//   no check: an older Computer or server); "1.5.11 · Latest" or "Couldn't check for updates" and no Upgrade otherwise;
// - the agent form's model-source line for a CLI too old to list the options (`runtime_outdated`), in place of
//   "Update it there.";
// - the runtime picker's notice for `version_unsupported` (live once OAR reports it).
// A press runs it once, says "Upgrading…" meanwhile, then one plain sentence per outcome.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RuntimeAuthStatus, RuntimeUpdateCheck, RuntimeUpgradeResult } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import RuntimeSignInNotice from "../src/components/machine/RuntimeSignInNotice";
import { RuntimeUsageSurface } from "../src/components/machine/RuntimeUsageSurface";
import type { SurfaceAuth } from "../src/components/machine/RuntimeUsageSurface";
import { RuntimeFormV2SourceStatusLine } from "../src/components/agent/RuntimeFormV2SourceStatusLine";
import { RuntimeUpgradeTargetContext } from "../src/features/computer/runtimeUpgradeTarget";
import { runtimeUpgradeCopy } from "../src/features/computer/runtimeUpgradeOutcomeCopy";
import type { RuntimeUpgradeState } from "../src/features/computer/runtimeUpgradeOutcomeCopy";
import { RuntimeAuthClient, runtimeUpdateOf, runtimeUpgradeOffered } from "../src/utils/runtimeAuthClient";
import type { RuntimeAuthView } from "../src/utils/runtimeAuthClient";

afterEach(() => cleanup());

const SIGNED_IN: RuntimeAuthView = {
  status: { collectedAt: "2026-11-16T10:00:00.000Z", runtimes: { claude: { kind: "logged_in" } } },
  availability: "ok",
  runtimes: ["claude", "codex"],
  logoutRuntimes: ["claude", "codex"],
  canAct: true,
};
const OFFERED: RuntimeAuthView = { ...SIGNED_IN, runtimeUpgrade: true, upgradableRuntimes: ["claude"] };

function fakeClient(view: RuntimeAuthView, upgrade: () => Promise<{ result: RuntimeUpgradeResult }>) {
  const posts: string[] = [];
  const http = {
    get: async <T,>() => view as T,
    post: async <T,>(url: string) => {
      posts.push(url);
      return (await upgrade()) as T;
    },
  };
  const socket = { current: () => null, onReplaced: () => () => {} };
  return { posts, client: new RuntimeAuthClient(http, socket) };
}

test("offered only with the server's say-so, to a viewer who may act, for a runtime the Computer can upgrade", () => {
  assert.equal(runtimeUpgradeOffered(OFFERED, "claude"), true);
  assert.equal(runtimeUpgradeOffered(OFFERED, "codex"), false, "the Computer did not report codex upgradable");
  assert.equal(runtimeUpgradeOffered(SIGNED_IN, "claude"), false, "no runtime_upgrade_button, or an older server");
  assert.equal(runtimeUpgradeOffered({ ...OFFERED, canAct: false }, "claude"), false);
  assert.equal(runtimeUpgradeOffered(null, "claude"), false);
});

function card(upgrade: SurfaceAuth["upgrade"], options: { update?: RuntimeUpdateCheck | null; status?: RuntimeAuthStatus; runtimeVersion?: string } = {}) {
  const auth: SurfaceAuth = {
    runtime: "claude",
    status: options.status ?? { kind: "logged_in" },
    view: OFFERED,
    onSignIn: () => {},
    onSignOut: () => {},
    onConnectProvider: () => {},
    onSignOutProvider: () => {},
    upgrade,
    update: options.update ?? null,
  };
  render(
    <TestIntlProvider>
      <RuntimeUsageSurface
        runtimeId="claude"
        runtimeVersion={options.runtimeVersion}
        provider={null}
        result={null}
        loading={false}
        loadError={false}
        refreshState="idle"
        cooldownLeftMs={0}
        onRefresh={() => {}}
        auth={auth}
        runtimeName="Claude Code"
        limitReset={null}
        note={null}
      />
    </TestIntlProvider>,
  );
}

const CHECKED_AT = "2026-11-18T10:00:00.000Z";

test("the card offers Upgrade only where the Computer's update check found a newer version", () => {
  card({ state: { kind: "idle" }, onUpgrade: () => {} }, { runtimeVersion: "1.5.10", update: { kind: "ok", installed: "1.5.10", latest: "1.5.11", updateAvailable: true, checkedAt: CHECKED_AT } });
  assert.equal(screen.getByTestId("runtime-update-check").textContent, "1.5.10 → 1.5.11 available");
  assert.ok(screen.queryByTestId("runtime-upgrade-action") !== null);
  cleanup();

  card({ state: { kind: "idle" }, onUpgrade: () => {} }, { runtimeVersion: "1.5.11", update: { kind: "ok", installed: "1.5.11", latest: "1.5.11", updateAvailable: false, checkedAt: CHECKED_AT } });
  assert.equal(screen.getByTestId("runtime-update-check").textContent, "1.5.11 · Latest");
  assert.ok(screen.queryByTestId("runtime-upgrade-action") === null, "nothing newer: no button to press just to ask");
  cleanup();

  card({ state: { kind: "idle" }, onUpgrade: () => {} }, { runtimeVersion: "1.5.10", update: { kind: "unavailable", reason: "lookup_failed", checkedAt: CHECKED_AT } });
  assert.equal(screen.getByTestId("runtime-update-check").textContent, "1.5.10 · Couldn't check for updates");
  assert.ok(screen.queryByTestId("runtime-upgrade-action") === null);
  cleanup();

  // An older Computer or server reports no check: the bare version and Upgrade, as before.
  card({ state: { kind: "idle" }, onUpgrade: () => {} }, { runtimeVersion: "1.5.10" });
  assert.ok(screen.queryByTestId("runtime-update-check") === null);
  assert.equal(screen.getByTestId("runtime-version-claude").textContent, "1.5.10");
  assert.ok(screen.queryByTestId("runtime-upgrade-action") !== null);
  cleanup();

  // A CLI too old to sign in keeps Upgrade whatever the check said; an Upgrade's outcome stays once the check says latest.
  card({ state: { kind: "idle" }, onUpgrade: () => {} }, { status: { kind: "unavailable", reason: "version_unsupported" }, update: { kind: "unavailable", reason: "package_manager", checkedAt: CHECKED_AT } });
  assert.ok(screen.queryByTestId("runtime-upgrade-action") !== null);
  cleanup();
  card({ state: { kind: "done", result: { kind: "upgraded", from: "1.5.10", to: "1.5.11" } }, onUpgrade: () => {} }, { update: { kind: "ok", installed: "1.5.11", latest: "1.5.11", updateAvailable: false, checkedAt: CHECKED_AT } });
  assert.ok(screen.queryByTestId("runtime-upgrade-action") === null);
  assert.equal(screen.getByTestId("runtime-upgrade-outcome").textContent, "Upgraded Claude Code from 1.5.10 to 1.5.11.");
});

test("the update check is read only for a runtime Upgrade is offered for, and only while it is under a day old", () => {
  const now = Date.parse(CHECKED_AT) + 60_000;
  const update: RuntimeUpdateCheck = { kind: "ok", installed: "2.0.5", latest: "2.0.5", updateAvailable: false, checkedAt: CHECKED_AT };
  const view: RuntimeAuthView = { ...OFFERED, runtimeUpdates: { claude: update, codex: update } };
  assert.deepEqual(runtimeUpdateOf(view, "claude", now), update);
  assert.equal(runtimeUpdateOf(view, "codex", now), null, "codex is not offered");
  assert.equal(runtimeUpdateOf(OFFERED, "claude", now), null, "no check reported");
  assert.equal(runtimeUpdateOf({ ...view, canAct: false }, "claude", now), null);
  const dayMs = 24 * 60 * 60_000;
  assert.deepEqual(runtimeUpdateOf(view, "claude", Date.parse(CHECKED_AT) + dayMs), update);
  assert.equal(runtimeUpdateOf(view, "claude", Date.parse(CHECKED_AT) + dayMs + 1), null, "a stale \"Latest\" counts as no answer: Upgrade as before");
});

test("updates managed outside Raft are said so, not as a failed check, and offer no Upgrade", () => {
  for (const reason of ["package_manager", "updates_disabled", "unmanaged_installation", "unsupported_installation"] as const) {
    card({ state: { kind: "idle" }, onUpgrade: () => {} }, { runtimeVersion: "2.0.5", update: { kind: "unavailable", reason, checkedAt: CHECKED_AT } });
    assert.equal(screen.getByTestId("runtime-update-check").textContent, "2.0.5 · Updates are managed outside Raft", reason);
    assert.ok(screen.queryByTestId("runtime-upgrade-action") === null, reason);
    cleanup();
  }
  card({ state: { kind: "idle" }, onUpgrade: () => {} }, { update: { kind: "unavailable", reason: "version_unreadable", checkedAt: CHECKED_AT } });
  assert.equal(screen.getByTestId("runtime-update-check").textContent, "Couldn't check for updates");
});

test("with no update check reported (an older Computer), the card offers Upgrade for an upgradable runtime that is signed in, and says what happened", () => {
  let pressed = 0;
  card({ state: { kind: "idle" }, onUpgrade: () => { pressed += 1; } });
  fireEvent.click(screen.getByTestId("runtime-upgrade-action"));
  assert.equal(pressed, 1);
  cleanup();

  card({ state: { kind: "done", result: { kind: "current", version: "2.0.5" } }, onUpgrade: () => {} });
  assert.equal(screen.getByTestId("runtime-upgrade-outcome").textContent, "Claude Code 2.0.5 is already the latest version.");
  cleanup();

  card(null);
  assert.ok(screen.queryByTestId("runtime-upgrade-action") === null, "no Upgrade where it is not offered");
});

const OUTDATED = { status: "unavailable" as const, reason: "runtime_outdated", retryable: true };

function sourceLine(client: RuntimeAuthClient, onRetrySource?: (sourceId: string) => void) {
  render(
    <TestIntlProvider>
      <RuntimeUpgradeTargetContext.Provider value={{ serverId: "s1", machineId: "m1", runtimeId: "claude", client }}>
        <RuntimeFormV2SourceStatusLine status={OUTDATED} sourceId="models" testId="model" retrying={false} onRetrySource={onRetrySource} />
      </RuntimeUpgradeTargetContext.Provider>
    </TestIntlProvider>,
  );
}

test("the agent form's runtime_outdated line keeps \"Update it there.\" where Upgrade is not offered", async () => {
  const { client, posts } = fakeClient({ ...OFFERED, upgradableRuntimes: [] }, async () => assert.fail("never upgrades on its own"));
  sourceLine(client);
  await act(async () => {});
  assert.match(screen.getByTestId("model-status").textContent ?? "", /too old to list the options\. Update it there\./);
  assert.ok(screen.queryByTestId("runtime-upgrade-action") === null);
  assert.deepEqual(posts, []);
});

test("the agent form's runtime_outdated line offers Upgrade instead, keeps its Retry, runs it once while busy, then says what happened", async () => {
  let finish!: (answer: { result: RuntimeUpgradeResult }) => void;
  const { client, posts } = fakeClient(OFFERED, () => new Promise((resolve) => { finish = resolve; }));
  const retried: string[] = [];
  sourceLine(client, (sourceId) => retried.push(sourceId));
  const button = await screen.findByTestId("runtime-upgrade-action");
  const line = screen.getByTestId("model-status").textContent ?? "";
  assert.match(line, /too old to list the options\./);
  assert.doesNotMatch(line, /Update it there/, "the button replaces the guidance");
  fireEvent.click(screen.getByTestId("model-retry"));
  assert.deepEqual(retried, ["models"], "Retry stays beside Upgrade");

  fireEvent.click(button);
  assert.ok((await screen.findAllByText("Upgrading…")).length > 0);
  fireEvent.click(screen.getByTestId("runtime-upgrade-action"));
  assert.deepEqual(posts, ["/servers/s1/machines/m1/runtimes/claude/upgrade"], "a busy button does not run it twice");

  await act(async () => finish({ result: { kind: "upgraded", from: "2.0.1", to: "2.0.5" } }));
  assert.equal((await screen.findByTestId("runtime-upgrade-outcome")).textContent, "Upgraded Claude Code from 2.0.1 to 2.0.5.");
});

test("a request that fails without the server's answer says to try again, never that it may still finish", async () => {
  const { client } = fakeClient(OFFERED, async () => { throw new Error("Network Error"); });
  sourceLine(client);
  fireEvent.click(await screen.findByTestId("runtime-upgrade-action"));
  assert.equal((await screen.findByTestId("runtime-upgrade-outcome")).textContent, "Couldn't upgrade Claude Code. Try again.");
});

test("a Computer too old for Upgrade is told to update the Computer first", async () => {
  const refused = Object.assign(new Error("409"), { response: { status: 409, data: { code: "computer_upgrade_required" } } });
  const { client } = fakeClient(OFFERED, async () => { throw refused; });
  sourceLine(client);
  fireEvent.click(await screen.findByTestId("runtime-upgrade-action"));
  assert.equal(
    (await screen.findByTestId("runtime-upgrade-outcome")).textContent,
    "This Computer is too old to upgrade runtimes from here. Update the Computer first.",
  );
});

test("the picker's too-old notice offers Upgrade for an upgradable runtime in place of its guidance", async () => {
  const tooOld: RuntimeAuthView = { ...OFFERED, status: { collectedAt: "2026-11-16T10:00:00.000Z", runtimes: { claude: { kind: "unavailable", reason: "version_unsupported" } } } };
  const { client } = fakeClient(tooOld, async () => ({ result: { kind: "current", version: "2.0.5" } }));
  render(
    <TestIntlProvider>
      <RuntimeSignInNotice serverId="s1" machineId="m1" machineName="studio" runtimeId="claude" enabled client={client} />
    </TestIntlProvider>,
  );
  await screen.findByTestId("runtime-upgrade-action");
  const notice = screen.getByTestId("runtime-picker-cli-unavailable").textContent ?? "";
  assert.match(notice, /Claude Code on studio is too old to sign in from here\./);
  assert.doesNotMatch(notice, /Rescan runtimes/);
});

test("one plain sentence per outcome", () => {
  const cases: Array<[RuntimeUpgradeState, string, "success" | "warning"]> = [
    [{ kind: "done", result: { kind: "upgraded", from: "1.0.0", to: "1.1.0" } }, "machine.runtimeUpgrade.upgradedFromTo", "success"],
    [{ kind: "done", result: { kind: "upgraded" } }, "machine.runtimeUpgrade.upgraded", "success"],
    [{ kind: "done", result: { kind: "current", version: "1.1.0" } }, "machine.runtimeUpgrade.currentVersion", "success"],
    [{ kind: "done", result: { kind: "unchanged", version: "1.0.0" } }, "machine.runtimeUpgrade.unchanged", "warning"],
    [{ kind: "done", result: { kind: "failed", exitCode: 1 } }, "machine.runtimeUpgrade.failed", "warning"],
    [{ kind: "done", result: { kind: "unsupported", reason: "unsupported_installation" } }, "machine.runtimeUpgrade.unsupportedInstallation", "warning"],
    [{ kind: "done", result: { kind: "unsupported", reason: "requires_terminal" } }, "machine.runtimeUpgrade.requiresTerminal", "warning"],
    [{ kind: "done", result: { kind: "not_installed" } }, "machine.runtimeAuth.error.notInstalled", "warning"],
    [{ kind: "done", result: { kind: "error", code: "in_progress" } }, "machine.runtimeUpgrade.inProgress", "warning"],
    [{ kind: "refused", reason: "computer_upgrade_required" }, "machine.runtimeUpgrade.computerTooOld", "warning"],
    [{ kind: "refused", reason: "computer_timeout" }, "machine.runtimeUpgrade.timeout", "warning"],
    [{ kind: "refused", reason: "failed" }, "machine.runtimeUpgrade.error", "warning"],
  ];
  for (const [state, id, tone] of cases) {
    const copy = runtimeUpgradeCopy(state);
    assert.equal(copy?.id, id);
    assert.equal(copy?.tone, tone, id);
  }
  assert.equal(runtimeUpgradeCopy({ kind: "running" }), null, "nothing is said while it runs");
});
