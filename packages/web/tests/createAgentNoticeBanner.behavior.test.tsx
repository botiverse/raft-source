import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CreateAgentDialog from "../src/components/agent/CreateAgentDialog";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

/**
 * The "connect a computer first" notice, in BOTH shells.
 *
 * An earlier version of this file drove only the dialog shell. @Dozy's CHANGES
 * on #7056 showed what that cost: flipping the onboarding notice's status to
 * `warning`, or unwrapping its Banner back to a plain div, left every suite
 * green. That is the same one-of-two gap I shipped in #7052 — twins get tested
 * together, or the untested twin is where the regression lands.
 *
 * The onboarding shell is driven with `onboardingShell="step"`, which is what
 * production renders (`ServerSetupProjectionGate` and the setup preview page
 * both pass it; the only other caller feeds `onboarding` from a store flag
 * nothing sets true).
 */

function seedNoMachines() {
  useServerStore.setState({
    current: { id: "server-1", name: "Launch", slug: "launch", avatarUrl: null, ownerId: "owner-1", onboardingAgentId: null, hideHumansFromMembers: false, plan: "free", planDowngradedAt: null, role: "owner", createdAt: "2026-07-14T00:00:00.000Z" },
    billing: null, loadBilling: async () => undefined,
  } as never);
  useMachineStore.setState({ machines: [] } as never);
  useChannelStore.setState({ channels: [] } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
}

afterEach(() => {
  cleanup();
  useMachineStore.setState({ machines: [] } as never);
  useServerStore.setState({ current: null } as never);
});

function renderShell(onboarding: boolean) {
  return render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <TestIntlProvider locale="en">
        {onboarding
          ? <CreateAgentDialog onboarding onboardingShell="step" onClose={() => undefined} />
          : <CreateAgentDialog onClose={() => undefined} />}
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

for (const onboarding of [false, true]) {
  const shell = onboarding ? "onboarding shell" : "dialog shell";

  test(`${shell}: the connect-a-computer notice is a raft-ui info Banner`, async () => {
    seedNoMachines();
    renderShell(onboarding);

    const title = await waitFor(() => {
      const found = screen.getByText("Connect a computer first");
      assert.ok(found, `${shell}: the notice must render`);
      return found;
    });

    assert.equal(
      title.getAttribute("data-slot"),
      "banner-title",
      `${shell}: the title must be the Banner's own slot, not a loose element`,
    );

    const banner = title.closest('[data-slot="banner"]');
    assert.equal(
      banner === null,
      false,
      `${shell}: must be a raft-ui Banner. The hand-rolled div it replaced was built from raw utilities the elegant patch layer cannot reach, so it rendered brutal chrome inside a soft card.`,
    );
    assert.equal(
      banner?.getAttribute("data-status"),
      "info",
      `${shell}: prerequisite notices are info — yellow in brutal, blue in elegant under @cindyz's four-state model. warning would read as a validation failure.`,
    );
    assert.equal(
      banner?.querySelector('[data-slot="banner-description"]') === null,
      false,
      `${shell}: the body must be a BannerDescription`,
    );

    // NOT a heading: BannerTitle renders a div on purpose. A banner's title
    // labels the banner; forcing an h3 injects a phantom entry into the document
    // outline (@cindyz — "banner title 不需要 h3, not a bug"). I had forced one
    // here and she reversed it, so this pins the corrected semantic.
    assert.equal(
      title.tagName,
      "DIV",
      `${shell}: the title must stay a div, got <${title.tagName.toLowerCase()}>`,
    );
    assert.equal(
      screen.queryAllByRole("heading", { name: /connect a computer first/i }).length,
      0,
      `${shell}: the notice title must not be exposed as a heading`,
    );
  });
}
