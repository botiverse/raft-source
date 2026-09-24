import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { RUNTIME_ACCOUNT_USAGE_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageSnapshot } from "@botiverse/raft-shared";

import api from "../src/api/client";
import RuntimeAccountUsageChip, {
  RuntimeAccountUsageGateChip,
} from "../src/components/machine/RuntimeAccountUsageChip";
import { useServerStore } from "../src/store/serverStore";
import {
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import {
  RuntimeAccountUsageClient,
} from "../src/utils/runtimeAccountUsageClient";
import type { RuntimeAccountUsageReadResult } from "../src/utils/runtimeAccountUsageClient";
import { renderWithIntl as render } from "./helpers/intl";

window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

globalThis.requestAnimationFrame ??= ((callback: FrameRequestCallback) =>
  setTimeout(() => callback(Date.now()), 0) as unknown as number);
globalThis.cancelAnimationFrame ??= ((handle: number) => clearTimeout(handle));

const originalPost = api.post;
const initialServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  api.post = originalPost;
  resetServerFeatureFlagsForTests();
  useServerStore.setState(initialServerState, true);
});

function snapshot(
  health: RuntimeAccountUsageSnapshot["accounts"][number]["health"] = "ok",
): RuntimeAccountUsageSnapshot {
  return {
    protocolVersion: 2,
    provider: "codex",
    collectedAt: "2026-08-02T01:00:00.000Z",
    staleAfter: "2026-08-02T01:15:00.000Z",
    collectorVersion: "test",
    sourceVersion: "codex-test",
    accounts: [{
      accountKey: "a".repeat(64),
      maskedLabel: "tea****r@example.com",
      planLabel: "Team",
      health,
      windows: [{
        id: "five-hour",
        label: "5 hours",
        status: "ok",
        usedRatio: 0.75,
        resetsAt: "2026-08-02T02:00:00.000Z",
      }],
    }],
  };
}

function clientFor(
  read: () => Promise<RuntimeAccountUsageReadResult>,
  refresh: () => Promise<{ accepted: boolean; state: "requested" | "cooldown" | "computer_offline" }>,
) {
  return new RuntimeAccountUsageClient(async () => read(), async () => refresh());
}

test("gate-off or non-owner runtime chips remain inert RUI badges with zero usage requests", () => {
  let reads = 0;
  let refreshes = 0;
  const client = clientFor(
    async () => { reads += 1; return { state: "fresh", snapshot: snapshot() }; },
    async () => { refreshes += 1; return { accepted: true, state: "requested" }; },
  );

  const view = render(
    <RuntimeAccountUsageGateChip
      enabled={false}
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageGateChip>,
  );

  const chip = screen.getByText("Codex");
  fireEvent.mouseEnter(chip);
  fireEvent.focus(chip);
  assert.equal(chip.tagName, "SPAN");
  assert.equal(chip.getAttribute("data-slot"), "badge", "inert runtime chips use the RUI Badge primitive");
  assert.equal(reads, 0);
  assert.equal(refreshes, 0);

  view.rerender(
    <RuntimeAccountUsageGateChip
      enabled
      runtimeId="codex"
      serverId={null}
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageGateChip>,
  );
  assert.equal(screen.getByText("Codex").tagName, "SPAN");
  assert.equal(reads, 0);
});

test("runtime usage health indicator uses the RUI Status primitive with a circular, centered dot", async () => {
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: snapshot() }),
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );

  await waitFor(() => assert.ok(screen.getByLabelText("Usage healthy")));
  const trigger = screen.getByRole("button", { name: "Codex" });
  const indicator = screen.getByTestId("runtime-usage-health-codex");
  assert.equal(trigger.getAttribute("data-slot"), "badge", "interactive runtime chips use the RUI Badge primitive");
  assert.equal(indicator.getAttribute("data-slot"), "status", "usage health uses the RUI Status primitive");
  assert.equal(indicator.getAttribute("data-size"), "sm", "usage health owns the RUI Status size prop");
  assert.match(indicator.className, /rounded-full/, "the usage dot is circular");
  assert.match(indicator.className, /size-2/, "the usage dot uses the larger size");
  assert.match(trigger.className, /items-center/, "the badge aligns its text and dot on the cross axis");
  assert.match(indicator.className, /items-center|inline-block/, "the status indicator stays inline with the badge label");
});

test("feature-flag unresolved or off runtime chips stay inert even when local eligibility allows usage", async () => {
  let reads = 0;
  let refreshes = 0;
  api.post = (async () => new Promise<never>(() => undefined)) as typeof api.post;
  useServerStore.setState({
    current: { id: "server-1", slug: "acme", name: "Acme", role: "admin" },
  } as never);
  const client = clientFor(
    async () => { reads += 1; return { state: "fresh", snapshot: snapshot() }; },
    async () => { refreshes += 1; return { accepted: true, state: "requested" }; },
  );

  const view = render(
    <RuntimeAccountUsageGateChip
      enabled
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageGateChip>,
  );

  let chip = screen.getByText("Codex");
  assert.equal(chip.tagName, "SPAN", "unresolved feature flag keeps a locally eligible chip inert");
  fireEvent.mouseEnter(chip);
  fireEvent.focus(chip);
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(reads, 0);
  assert.equal(refreshes, 0);

  act(() => {
    setServerFeatureFlagForTests("server-1", RUNTIME_ACCOUNT_USAGE_FEATURE_FLAG_KEY, false);
  });
  await waitFor(() => {
    chip = screen.getByText("Codex");
    assert.equal(chip.tagName, "SPAN", "resolved feature flag off keeps a locally eligible chip inert");
  });
  fireEvent.mouseEnter(chip);
  fireEvent.focus(chip);
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(reads, 0);
  assert.equal(refreshes, 0);

  act(() => {
    setServerFeatureFlagForTests("server-1", RUNTIME_ACCOUNT_USAGE_FEATURE_FLAG_KEY, true);
  });
  const enabledChip = await screen.findByRole("button", { name: "Codex" });
  await waitFor(() => assert.equal(reads, 1));
  fireEvent.focus(enabledChip);
  await waitFor(() => assert.ok(screen.getByRole("dialog", { name: "Codex runtime account usage" })));
  assert.equal(refreshes, 0);

  view.unmount();
});

test("focus opens a cache-only usage surface and repeated opens share the read cache", async () => {
  let reads = 0;
  const client = clientFor(
    async () => { reads += 1; return { state: "fresh", snapshot: snapshot() }; },
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );

  const trigger = screen.getByRole("button", { name: "Codex" });
  fireEvent.focus(trigger);
  await waitFor(() => assert.ok(screen.getByText("Team")));
  assert.ok(screen.getByText("tea****r@example.com"), "the sanitized account label is visible in the mounted usage surface");
  assert.ok(screen.getByText(/75% used/));
  assert.ok(screen.getByLabelText("Usage healthy"));
  assert.equal(reads, 1);
  assert.doesNotMatch(document.body.textContent ?? "", /a{64}/, "opaque account keys never render");

  fireEvent.focus(trigger);
  await waitFor(() => assert.equal(reads, 1));
});

test("Codex, Claude, and Kimi usage surfaces show their current runtime version", async () => {
  const cases = [
    { runtimeId: "codex", label: "Codex", version: "0.75.1", provider: "codex" },
    { runtimeId: "claude", label: "Claude", version: "1.0.83", provider: "claude" },
    { runtimeId: "kimi-sdk", label: "Kimi", version: "0.34.0-botiverse.0", provider: "kimi" },
  ] as const;

  for (const runtime of cases) {
    const client = clientFor(
      async () => ({ state: "fresh", snapshot: snapshot() }),
      async () => { throw new Error("refresh should not run for a fresh snapshot"); },
    );
    const view = render(
      <RuntimeAccountUsageChip
        runtimeId={runtime.runtimeId}
        runtimeVersion={runtime.version}
        serverId="server-1"
        machineId="machine-1"
        className="runtime-chip"
        client={client}
      >
        {runtime.label}
      </RuntimeAccountUsageChip>,
    );

    fireEvent.focus(screen.getByRole("button", { name: runtime.label }));
    await waitFor(() => assert.equal(
      screen.getByTestId(`runtime-version-${runtime.provider}`).textContent,
      `Version ${runtime.version}`,
    ));
    view.unmount();
  }
});

test("runtime usage surface says when the runtime version is unavailable", async () => {
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: snapshot() }),
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );
  render(
    <RuntimeAccountUsageChip
      runtimeId="claude"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Claude
    </RuntimeAccountUsageChip>,
  );

  fireEvent.focus(screen.getByRole("button", { name: "Claude" }));
  await waitFor(() => assert.equal(screen.getByTestId("runtime-version-claude").textContent, "Version unavailable"));
});

test("a usable percent remains visible when only reset metadata is unavailable", async () => {
  const partial = snapshot();
  delete partial.accounts[0]!.windows[0]!.resetsAt;
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: partial }),
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="claude"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Claude
    </RuntimeAccountUsageChip>,
  );

  fireEvent.focus(screen.getByRole("button", { name: "Claude" }));
  await waitFor(() => assert.ok(screen.getByText("75% used · reset time unavailable")));
  assert.equal(screen.queryByText("Usage format unavailable"), null);
  assert.ok(document.querySelector('[style="width: 75%;"]'));
});

test("mount silently refreshes a missing snapshot and follows through until the result is visible", async () => {
  let reads = 0;
  let refreshes = 0;
  const client = clientFor(
    async () => {
      reads += 1;
      return reads === 1
        ? { state: "missing", snapshot: null }
        : { state: "fresh", snapshot: snapshot() };
    },
    async () => { refreshes += 1; return { accepted: true, state: "requested" }; },
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );

  await waitFor(() => assert.equal(refreshes, 1));
  await waitFor(() => assert.ok(screen.getByLabelText("Usage healthy")), { timeout: 3_000 });
  assert.equal(reads, 2);
  assert.equal(screen.queryByText("No snapshot yet"), null);
  assert.equal(screen.queryByLabelText("Usage needs attention"), null);
});

test("poll exhaustion is explicit instead of impersonating a server cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  let refreshes = 0;
  const client = clientFor(
    async () => { reads += 1; return { state: "missing", snapshot: null }; },
    async () => { refreshes += 1; return { accepted: true, state: "requested" }; },
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Codex" }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(refreshes, 1);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await act(async () => {
      t.mock.timers.tick(1_200);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  assert.equal(reads, 9);
  assert.ok(screen.getByText("Refresh sent, but no update was observed"));
  assert.equal(screen.queryByText("Refresh cooling down"), null);
});

test("a server cooldown still follows an earlier in-flight refresh to fresh", async () => {
  let reads = 0;
  const client = clientFor(
    async () => {
      reads += 1;
      return reads === 1
        ? { state: "missing", snapshot: null }
        : { state: "fresh", snapshot: snapshot() };
    },
    async () => ({ accepted: false, state: "cooldown" }),
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );

  await waitFor(() => assert.ok(screen.getByLabelText("Usage healthy")), { timeout: 3_000 });
  assert.equal(reads, 2);
});

test("click pins the desktop usage surface until explicit close or outside click", async () => {
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: snapshot() }),
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );

  const trigger = screen.getByRole("button", { name: "Codex" });
  fireEvent.click(trigger);
  await waitFor(() => assert.ok(screen.getByRole("dialog", { name: "Codex runtime account usage" })));

  fireEvent.mouseLeave(trigger);
  fireEvent.blur(trigger);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
  assert.ok(screen.getByRole("dialog", { name: "Codex runtime account usage" }));

  fireEvent.pointerDown(document.body);
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Codex runtime account usage" }), null));
});

test("stale state downgrades the whole snapshot and reauth hides last-known percentages", async () => {
  const staleClient = clientFor(
    async () => ({ state: "stale", snapshot: snapshot() }),
    async () => ({ accepted: false, state: "cooldown" }),
  );
  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={staleClient}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );
  fireEvent.focus(screen.getByRole("button", { name: "Codex" }));
  await waitFor(() => assert.ok(screen.getByText(/Stale snapshot/)));
  const staleIndicator = screen.getByTestId("runtime-usage-health-codex");
  assert.ok(screen.getByLabelText("Usage needs attention"));
  assert.equal(staleIndicator.getAttribute("data-variant"), "warning");
  assert.notEqual(staleIndicator.getAttribute("data-variant"), "success");

  cleanup();
  const reauthClient = clientFor(
    async () => ({ state: "fresh", snapshot: snapshot("reauth_required") }),
    async () => ({ accepted: false, state: "cooldown" }),
  );
  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={reauthClient}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );
  fireEvent.focus(screen.getByRole("button", { name: "Codex" }));
  await waitFor(() => assert.ok(screen.getByText(/Sign in again/)));
  const reauthIndicator = screen.getByTestId("runtime-usage-health-codex");
  assert.ok(screen.getByLabelText("Usage needs attention"));
  assert.equal(reauthIndicator.getAttribute("data-variant"), "warning");
  assert.notEqual(reauthIndicator.getAttribute("data-variant"), "success");
  assert.equal(screen.queryByText(/75% used/), null);
});

for (const { provider, label } of [
  { provider: "codex" as const, label: "Codex" },
  { provider: "claude" as const, label: "Claude" },
  { provider: "kimi" as const, label: "Kimi" },
  { provider: "grok" as const, label: "Grok" },
]) {
  test(`${label} unsupported OAR readings do not claim an API endpoint or healthy usage`, async () => {
    const endpointSnapshot: RuntimeAccountUsageSnapshot = {
      protocolVersion: 2,
      provider,
      collectedAt: "2026-08-10T06:30:00.000Z",
      staleAfter: "2026-08-10T06:35:00.000Z",
      collectorVersion: "test",
      accounts: [{
        accountKey: "c".repeat(64),
        health: "unsupported",
        windows: [],
      }],
    };
    const client = clientFor(
      async () => ({ state: "fresh", snapshot: endpointSnapshot }),
      async () => ({ accepted: false, state: "cooldown" }),
    );

    render(
      <RuntimeAccountUsageChip
        runtimeId={provider}
        serverId="server-1"
        machineId="machine-1"
        className="runtime-chip"
        client={client}
      >
        {label}
      </RuntimeAccountUsageChip>,
    );

    await waitFor(() => assert.ok(screen.getByLabelText("Usage needs attention")));
    assert.equal(screen.queryByLabelText("Usage healthy"), null);
    fireEvent.focus(screen.getByRole("button", { name: label }));
    await waitFor(() => assert.ok(screen.getByText("unsupported")));
    assert.ok(screen.getByText("Account usage is unavailable for this runtime or sign-in method."));
    assert.equal(screen.queryByText("api endpoint"), null);
  });
}

test("Kimi OAR failures remain visible errors", async () => {
  const kimiSnapshot: RuntimeAccountUsageSnapshot = {
    protocolVersion: 2,
    provider: "kimi",
    collectedAt: "2026-08-10T06:30:00.000Z",
    staleAfter: "2026-08-10T06:35:00.000Z",
    collectorVersion: "test",
    accounts: [{
      accountKey: "b".repeat(64),
      health: "error",
      windows: [],
    }],
  };
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: kimiSnapshot }),
    async () => ({ accepted: false, state: "cooldown" }),
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="kimi"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Kimi
    </RuntimeAccountUsageChip>,
  );

  await waitFor(() => assert.ok(screen.getByLabelText("Usage needs attention")));
  assert.equal(screen.queryByLabelText("Usage healthy"), null);
  fireEvent.focus(screen.getByRole("button", { name: "Kimi" }));
  await waitFor(() => assert.ok(screen.getByText("error")));
  assert.equal(screen.queryByText("unable to detect"), null);
});
