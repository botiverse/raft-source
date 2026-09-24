import "./helpers/domSetup";

import assert from "node:assert/strict";

import { afterEach, test } from "node:test";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { getCreatableRuntimeOptions } from "@botiverse/raft-shared";
import type { RuntimeSelectionOption } from "@botiverse/raft-shared";
import CreateAgentDialog from "../src/components/agent/CreateAgentDialog";
import api from "../src/api/client";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { Locale } from "../src/i18n/locale";
import { TestIntlProvider } from "./helpers/intl";

/**
 * The runtime-config choice cards, driven through the REAL dialog.
 *
 * An earlier version of this file built its own `ChoiceCard` and asserted
 * against that. It was worthless: deleting `adopt={false}` from the production
 * Fast mode field, and deleting the production `aria-labelledby`, both left it
 * 4/4 GREEN (@Dozy, review of H=70e443cd). A tooth that composes its own correct
 * markup cannot fail when a callsite regresses — it is asserting about itself.
 *
 * What these guard is a bug that every other check missed: the cards LOOKED
 * right in both themes and behaved correctly, while the control was announced by
 * the wrong name. Appearance and state were covered; identity was not.
 *
 *   - StableField adopts the single interactive child, and a `Card` counts as
 *     one — so the field's id/aria landed on the Card's own `<label>`, colliding
 *     with the id Base UI gives the checkbox's hidden input.
 *   - The checkbox inherits its accessible name from the enclosing Field
 *     context, so it announced as the FIELD's label ("Mode") rather than the
 *     option's ("Fast mode").
 *
 * Whole-card click is asserted too, because the tempting wrong fix — dropping
 * the `<label>` wrapper — corrects the naming and silently removes it.
 */

function render(ui: ReactElement, options: RenderOptions & { locale?: Locale } = {}) {
  const { locale = "en", ...renderOptions } = options;
  return rtlRender(<TestIntlProvider locale={locale}>{ui}</TestIntlProvider>, renderOptions);
}

const originalGet = api.get;
const originalPost = api.post;

function runtimeOption(runtimeId: string, available: boolean): RuntimeSelectionOption {
  return {
    runtimeId,
    capabilityStatus: available ? "available" : "not_installed",
    admissionStatus: "available_for_new",
    admissionReason: null,
    current: false,
    availableForNew: true,
    manageableForCurrentAgent: false,
    canSelectInThisContext: available,
  };
}

/** Fast mode renders only for a runtime that supports it (claude / codex). */
function stubClaudeRuntime() {
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({ ...machine, runtimes: ["claude"] })),
  }));
  api.get = (async (url: string) => {
    if (url.endsWith("/runtime-options")) {
      const machineId = url.split("/").at(-2) ?? null;
      const installed = new Set(
        useMachineStore.getState().machines.find((m) => m.id === machineId)?.runtimes ?? [],
      );
      return {
        data: {
          context: "new_agent",
          machineId,
          options: getCreatableRuntimeOptions()
            .filter((r) => r.id !== "grok")
            .map((r) => runtimeOption(r.id, installed.has(r.id))),
        },
      } as never;
    }
    return { data: { kind: "unsupported" } } as never;
  }) as typeof api.get;
}

function seedStores() {
  useServerStore.setState({
    current: {
      id: "server-1", name: "Launch", slug: "launch", avatarUrl: null, ownerId: "owner-1",
      onboardingAgentId: null, hideHumansFromMembers: false, plan: "free",
      planDowngradedAt: null, role: "owner", createdAt: "2026-07-14T00:00:00.000Z",
    },
    billing: null,
    loadBilling: async () => undefined,
  } as never);
  useMachineStore.setState({
    machines: [{
      id: "machine-1", name: "Mac", description: null, status: "online", statusVersion: 1,
      apiKeyPrefix: null, runtimes: ["claude"], hostname: "mac.local", os: "darwin",
      daemonVersion: "0.72.6", lastHeartbeat: "2026-07-14T00:00:00.000Z",
      createdAt: "2026-07-14T00:00:00.000Z",
    }],
  } as never);
  useChannelStore.setState({ channels: [] } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
}

const FIELD_LABEL = "Mode";
const OPTION_LABEL = "Fast mode";

/** Resolve an aria id-reference list to the text it announces. Comparing ids
 *  proves nothing — they are generated, and an id pointing at a missing element
 *  reads as "no name" to a user while looking populated in a diff. */
function ariaName(el: Element): string {
  const ids = el.getAttribute("aria-labelledby");
  if (!ids) return el.getAttribute("aria-label") ?? "";
  return ids.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
}

/** Open the real dialog and reveal the Fast mode field, which lives behind the
 *  "More" disclosure. */
async function openFastMode() {
  seedStores();
  stubClaudeRuntime();
  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog onClose={() => undefined} />
    </MemoryRouter>,
  );
  await waitFor(() => assert.equal(
    screen.getAllByRole("combobox").some((s) => s.textContent?.trim() === "Claude Code"),
    true,
  ));
  const more = screen.getAllByRole("button").find((b) => /more/i.test(b.textContent ?? ""));
  assert.ok(more, "the More disclosure must exist");
  fireEvent.click(more);
  const card = await screen.findByText(OPTION_LABEL);
  return card;
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("the real Fast mode checkbox is announced by its OPTION name, not the field's group label", async () => {
  await openFastMode();
  const checkbox = document.querySelector('[role="checkbox"]');
  assert.ok(checkbox, "the Fast mode option must render a checkbox");
  assert.equal(
    ariaName(checkbox),
    OPTION_LABEL,
    `a screen reader must hear "${OPTION_LABEL}". It heard "${FIELD_LABEL}" — the field's own label — because the checkbox takes its name from the enclosing Field context unless pointed at the card title`,
  );
});

test("the real Fast mode field declines adoption, and its ids stay unique", async () => {
  // Back to `adopt={false}` (@cindyz, 2026-09-03). The option's name lives on
  // the card again, so the field's own label is MODE and its content is a Card
  // rather than a single interactive control — which is exactly the case that
  // escape hatch exists for. What is NOT back is the old chrome: the card is
  // `variant="option"`, so it sits at control elevation with a field-scale
  // title instead of floating a step above the form at 18px.
  await openFastMode();
  const title = document.querySelector("#runtime-fast-mode-title");
  assert.ok(title, "the option's own title must render");
  const field = title.closest('[data-slot="field"]');
  assert.ok(field, "the option must live inside a field");
  assert.equal(
    field.querySelector('[data-slot="field-control"]'),
    null,
    "the field must not adopt: its content is a Card, and adopting one stamps the field's id and aria onto the card's own label",
  );

  const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
  assert.equal(new Set(ids).size, ids.length, "ids must stay unique");
});

test("clicking the real Fast mode CARD toggles it", async () => {
  // The card renders as a <label>, so the whole box is the hit target — which is
  // what the pre-Card-removal version of this test protected, and what removing
  // the Card cost. It is back, and this pins it: with the card as the label the
  // target is the whole option, not the ~18px box.
  const card = await openFastMode();
  const box = () => document.querySelector('[role="checkbox"]');
  assert.ok(box(), "the Fast mode option must render a checkbox");
  assert.equal(box()?.getAttribute("aria-checked"), "false");

  fireEvent.click(card);
  await waitFor(() => assert.equal(
    box()?.getAttribute("aria-checked"),
    "true",
    "clicking the option card must toggle it — the Card renders as a <label> so the whole card is the hit target",
  ));
});
