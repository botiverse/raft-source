import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { getCreatableRuntimeOptions } from "@botiverse/raft-shared";
import CreateAgentDialog from "../src/components/agent/CreateAgentDialog";
import api from "../src/api/client";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

/**
 * Every Banner this dialog can render must be a raft-ui Banner.
 *
 * `CreateAgentDialog` renders FOUR: a capacity banner and a submit-error banner,
 * once in the dialog shell and once in the onboarding shell. The visual tooth in
 * #7052 drove only the dialog-shell capacity one, so @Dozy could revert either
 * onboarding banner or the dialog submit-error banner to the hand-rolled
 * component and Playwright, lint and the billing contract all stayed green —
 * three of the four could silently regress.
 *
 * These live in the DOM suite deliberately: it runs in CI on every PR, whereas
 * the browser suite is local-only (Hosted: NOT COVERED). The theme axis still
 * needs a real browser, so the two-theme colour assertion stays in
 * createAgentBannerTheme.spec.ts; what belongs here is "is it the component at
 * all", which is exactly what the mutation broke.
 *
 * The onboarding shell is driven with `onboardingShell="step"`, which is what
 * production actually renders: `ServerSetupProjectionGate` and the setup preview
 * page both pass it, and the only other caller passes `onboarding` from a store
 * flag that nothing ever sets true. The visual harness omits the prop and so
 * renders a shape production cannot reach (@cindyz spotted this).
 */

const BILLING_AT_CAP = {
  plan: "free", displayName: "Free", serverPlan: "free", source: "server" as const,
  capacity: { maxHumans: -1, maxAgents: 3, maxUniversalSeats: -1 },
  usage: { humans: 1, agents: 3, universalSeats: 0 },
  provisioned: { humans: 0, agents: 0, proPackQuantity: 0, trialFreePackQuantity: 0 },
  price: null, subscription: null, stripeConfigured: false,
  permissions: { canReadBillingSummary: true, canManageBilling: true },
};

const originalGet = api.get;
const originalPost = api.post;

function seed({ atCapacity }: { atCapacity: boolean }) {
  useServerStore.setState({
    current: { id: "server-1", name: "Launch", slug: "launch", avatarUrl: null, ownerId: "owner-1", onboardingAgentId: null, hideHumansFromMembers: false, plan: "free", planDowngradedAt: null, role: "owner", createdAt: "2026-07-14T00:00:00.000Z" },
    billing: atCapacity ? BILLING_AT_CAP : null,
    loadBilling: async () => undefined,
  } as never);
  useMachineStore.setState({
    machines: [{ id: "machine-1", name: "Mac", description: null, status: "online", statusVersion: 1, apiKeyPrefix: null, runtimes: ["cursor"], hostname: "mac.local", os: "darwin", daemonVersion: "0.72.6", lastHeartbeat: "2026-07-14T00:00:00.000Z", createdAt: "2026-07-14T00:00:00.000Z" }],
  } as never);
  useChannelStore.setState({ channels: [] } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
  // A reported Cursor model keeps the runtime ready so this tests the banner gate.
  api.get = (async (url: string) => url.endsWith("/runtime-options")
    ? { data: { context: "new_agent", machineId: "machine-1", options: getCreatableRuntimeOptions().filter((r) => r.id !== "grok").map((r) => ({ runtimeId: r.id, capabilityStatus: r.id === "cursor" ? "available" : "not_installed", admissionStatus: "available_for_new", admissionReason: null, current: false, availableForNew: true, manageableForCurrentAgent: false, canSelectInThisContext: r.id === "cursor" })) } }
    : { data: { models: [{ id: "auto", label: "Auto" }] } }) as never;
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useAgentStore.setState({ agents: [], loading: false } as never);
  useServerStore.setState({ current: null, billing: null } as never);
});

function renderDialog(onboarding: boolean) {
  return render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <TestIntlProvider locale="en">
        {onboarding
          ? <CreateAgentDialog onboarding onboardingShell="step" onClose={() => undefined} />
          // The dialog shell requires a name; the onboarding shell generates one,
          // which is why only this branch needs it seeded.
          : <CreateAgentDialog prefilledName="qa-bot" onClose={() => undefined} />}
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

/** The assertion the mutation broke: it is the component, not a look-alike div. */
async function assertRuiWarningBanner(surface: string, expected: RegExp) {
  const banner = await waitFor(() => {
    const found = [...document.querySelectorAll('[data-slot="banner"]')]
      .find((el) => expected.test(el.textContent ?? ""));
    assert.ok(
      found,
      `${surface}: expected a raft-ui Banner matching ${expected}. A hand-rolled div renders the same text with no [data-slot], which is exactly the reverted state.`,
    );
    return found;
  });
  assert.equal(
    banner.getAttribute("data-status"),
    "warning",
    `${surface}: must carry the warning status — that is what selects orange rather than the yellow "busy" surface`,
  );
  assert.equal(
    banner.querySelector('[data-slot="banner-description"]') === null,
    false,
    `${surface}: the message must sit in the Banner's description slot`,
  );
}

for (const onboarding of [false, true]) {
  const shell = onboarding ? "onboarding shell" : "dialog shell";

  test(`${shell}: the capacity banner is a raft-ui Banner`, async () => {
    seed({ atCapacity: true });
    renderDialog(onboarding);
    await assertRuiWarningBanner(`${shell} capacity`, /agent limit reached/i);
  });

  test(`${shell}: the submit-error banner is a raft-ui Banner`, async () => {
    seed({ atCapacity: false });
    api.post = (async () => {
      throw { response: { data: { error: "Something went wrong creating this agent." } } };
    }) as never;
    renderDialog(onboarding);

    const submit = await waitFor(() => {
      const button = screen.getAllByRole("button")
        .find((el) => /create (agent|cindy)/i.test(el.textContent ?? "") && !(el as HTMLButtonElement).disabled);
      if (!button) {
        const all = screen.getAllByRole("button").map((el) => `${(el.textContent ?? "").trim().slice(0,18)}${(el as HTMLButtonElement).disabled ? "[disabled]" : ""}`);
        assert.fail(`${shell}: no enabled submit. buttons: ${all.join(" | ")}`);
      }
      return button;
    });
    fireEvent.click(submit);

    await assertRuiWarningBanner(`${shell} submit error`, /something went wrong/i);
  });
}
