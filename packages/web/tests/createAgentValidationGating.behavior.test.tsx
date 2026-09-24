import "./helpers/domSetup";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
 * When the Create Agent form is allowed to say a field is wrong, and where it
 * says it.
 *
 * All four assertions here come from one acceptance pass by @cindyz on the
 * onboarding preview (2026-08-26, #wg-design-exp:33f7a8cd), and each one guards a
 * distinct defect that shipped together:
 *
 *   1. the form opened already in red, reporting fields the user had not reached
 *   2. Chrome's own `required` bubble was the Name field's only error surface —
 *      an orange popup no stylesheet of ours can reach
 *   3. Create Agent was disabled *because* of those errors, so "validate on
 *      click" could never fire: the click was unreachable
 *   4. each error was a conditionally-rendered `<p>`, so showing or clearing one
 *      moved every field below it
 *
 * These live in the dom suite rather than the visual one deliberately. The visual
 * suite is local-only — no CI job runs it (Hosted: NOT COVERED) — and this
 * behaviour is exactly the kind that regresses silently in a refactor. The one
 * thing the dom suite cannot see is computed geometry, so the padding tooth below
 * asserts the class contract instead and says so.
 */

function render(ui: ReactElement, options: RenderOptions & { locale?: Locale } = {}) {
  const { locale = "en", ...renderOptions } = options;
  return rtlRender(<TestIntlProvider locale={locale}>{ui}</TestIntlProvider>, renderOptions);
}

const originalGet = api.get;
const originalPost = api.post;

function createRuntimeOption(runtimeId: string, available: boolean): RuntimeSelectionOption {
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

function stubCreateAgentGet(modelPayload: unknown) {
  api.get = (async (url: string) => {
    if (url.endsWith("/runtime-options")) {
      const machineId = url.split("/").at(-2) ?? null;
      const installed = new Set(
        useMachineStore.getState().machines.find((machine) => machine.id === machineId)?.runtimes ?? [],
      );
      return {
        data: {
          context: "new_agent",
          machineId,
          options: getCreatableRuntimeOptions()
            .filter((runtime) => runtime.id !== "grok")
            .map((runtime) => createRuntimeOption(runtime.id, installed.has(runtime.id))),
        },
      } as never;
    }
    return { data: modelPayload } as never;
  }) as typeof api.get;
}

/**
 * A runtime with nothing ENVIRONMENTAL left to object to, so what these tests
 * measure is the validation gate and not an unrelated blocker.
 *
 * Cursor with a reported model leaves no runtime blocker.
 */
function stubSubmittableRuntime() {
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({ ...machine, runtimes: ["cursor"] })),
  }));
  stubCreateAgentGet({ models: [{ id: "auto", label: "Auto" }] });
}

/** Every test below opens on the same runtime; wait for it before asserting, or
 *  the assertion races the runtime-options fetch. */
async function openDialogOnSubmittableRuntime() {
  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog onClose={() => undefined} />
    </MemoryRouter>,
  );
  await waitFor(() => assert.equal(
    screen.getAllByRole("combobox").some((select) => select.textContent?.trim() === "Cursor CLI"),
    true,
  ));
}

function seedStores() {
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Launch",
      slug: "launch",
      avatarUrl: null,
      ownerId: "owner-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-14T00:00:00.000Z",
    },
    billing: null,
    loadBilling: async () => undefined,
  } as never);
  useMachineStore.setState({
    machines: [{
      id: "machine-1",
      name: "Mac",
      description: null,
      status: "online",
      statusVersion: 1,
      apiKeyPrefix: null,
      runtimes: ["codex", "claude"],
      hostname: "mac.local",
      os: "darwin",
      daemonVersion: "0.72.6",
      lastHeartbeat: "2026-07-14T00:00:00.000Z",
      createdAt: "2026-07-14T00:00:00.000Z",
    }],
  } as never);
  useChannelStore.setState({ channels: [] } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
}

const NAME_REQUIRED = "Agent name is required";
/** A name that is PRESENT but malformed — the state that keeps Create Agent
 *  clickable so the click has something to report. "1-agent" fails the leading
 *  character rule; `validateAgentNameReason` returns `{ code: "pattern" }`. */
const MALFORMED_NAME = "1-agent";
const NAME_PATTERN_ERROR = "Start with a letter, then letters, numbers, - or _";

/**
 * Resolve an ARIA id-reference list to the text it actually announces.
 *
 * Comparing raw ids proves nothing — they are generated, and an id pointing at a
 * missing node reads as "no description" to a user while looking populated in a
 * diff. Resolving to text is what makes "the Select is described as required"
 * falsifiable.
 */
function ariaText(el: Element, attr: "aria-labelledby" | "aria-describedby"): string {
  const ids = el.getAttribute(attr);
  if (!ids) return "";
  return ids.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
}

function createButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  api.get = originalGet;
  api.post = originalPost;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

/**
 * TOOTH 1 — the form does not open in red.
 *
 * RED when `inlineNameError` goes back to reporting `validationAttempted`-free
 * state, i.e. any revision that shows a "required" error before the user has
 * asked for the form to be checked.
 */
test("Create Agent opens silent: an untouched required field reports nothing", async () => {
  seedStores();
  stubSubmittableRuntime();
  await openDialogOnSubmittableRuntime();
  // Compare a BOOLEAN, not the element. `assert.equal(node, null)` makes
  // node:assert serialise the matched DOM node into the failure message, and a
  // rendered dialog is large and self-referential enough that formatting it
  // takes tens of seconds — so this tooth's RED arrived as an unexplained
  // file-level timeout instead of a readable assertion. A tooth that cannot say
  // why it failed is only half a tooth.
  assert.equal(
    screen.queryByText(NAME_REQUIRED) === null,
    true,
    "the Name field must not report `required` before a submit attempt — an untouched field is not a mistake",
  );
  // The denominator: assert the field is actually RENDERED and merely silent,
  // rather than the query passing because the dialog never mounted.
  assert.ok(screen.getByPlaceholderText("e.g. Alice"), "Name input must exist");
});

/**
 * TOOTH 2 — empty and malformed are different states.
 *
 * The rule Cindy locked (2026-08-26): a mandatory field left EMPTY disables
 * Create Agent and reports nothing — the disabled button is the message. A field
 * that HAS a value but a bad one keeps the button clickable, so the click can
 * report it.
 *
 * RED in both directions: if an empty field stops disabling the button (an
 * untouched form would then be submittable), or if a malformed value starts
 * disabling it (the click that reports it becomes unreachable, which is the
 * defect that produced this whole thread).
 */
test("an empty mandatory field disables Create Agent silently; a malformed one leaves it clickable", async () => {
  seedStores();
  stubSubmittableRuntime();
  await openDialogOnSubmittableRuntime();

  const nameInput = screen.getByPlaceholderText("e.g. Alice") as HTMLInputElement;
  assert.equal(nameInput.value, "", "precondition: the Name field is empty");
  assert.equal(
    createButton().disabled,
    true,
    "a mandatory field left empty must disable Create Agent",
  );
  assert.equal(
    screen.queryByText(NAME_REQUIRED) === null,
    true,
    "...and must do so SILENTLY — the disabled button is the message, not a red line on a field the user has not filled in",
  );

  fireEvent.change(nameInput, { target: { value: MALFORMED_NAME } });
  assert.equal(
    createButton().disabled,
    false,
    "a name that is present but malformed must leave Create Agent clickable — otherwise the click that reports it can never happen",
  );
});

/**
 * TOOTH 3 — the click validates, in OUR slot, without submitting.
 *
 * RED three separate ways: if the click submits anyway; if the message is missing
 * because the browser's native bubble was left to carry it (`noValidate` removed —
 * jsdom does not draw the bubble, but it does block submit, so the handler never
 * runs and the assertion fails); or if the message is rendered outside the field's
 * description slot.
 */
test("clicking Create Agent reports a malformed Name in the field's own error slot and does not submit", async () => {
  seedStores();
  stubSubmittableRuntime();
  let createAttempts = 0;
  api.post = (async (url: string) => {
    if (url.includes("/agents")) createAttempts += 1;
    return { data: {} } as never;
  }) as typeof api.post;

  await openDialogOnSubmittableRuntime();
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: MALFORMED_NAME } });
  assert.equal(
    screen.queryByText(NAME_PATTERN_ERROR) === null,
    true,
    "typing alone must not trigger the report — it is the click that validates",
  );
  fireEvent.click(createButton());

  const message = await screen.findByText(NAME_PATTERN_ERROR);
  assert.equal(createAttempts, 0, "a failed validation must not reach the create API");

  // WHERE it renders, not just that it renders. A dialog-level banner or a
  // hand-rolled `<p>` beside the control would satisfy `findByText` while being
  // exactly the defect under test, so anchor to the library's description slot —
  // the same slot every other field's message uses.
  assert.ok(
    message.closest('[data-slot="field-description"]'),
    "the error must render in the field's standard description/error slot, not a bespoke element or a dialog banner",
  );

  // And that the slot belongs to the NAME field specifically, rather than any
  // field that happens to carry a message.
  const nameField = (screen.getByPlaceholderText("e.g. Alice") as HTMLElement).closest('[data-slot="field"]');
  assert.ok(nameField, "the Name input must sit inside a Field");
  assert.ok(
    nameField.contains(message),
    "the message must belong to the Name field, not to some other field's slot",
  );
});

/**
 * TOOTH 4 — the message row is reserved, so speaking does not move the form.
 *
 * RED when an error goes back to being a conditionally-rendered sibling of the
 * control: the row would then not exist while the field is silent, and the field's
 * height would change the moment it spoke. This is the jump Cindy recorded —
 * typing the first character of an API key pulled MODEL up by a line.
 *
 * Measured as "same box before and after", not as a pixel literal: jsdom has no
 * layout, so the assertion is that the field's rendered structure is unchanged
 * apart from the text, which is the property that keeps the height stable.
 */
test("a field's message row is reserved, so showing an error does not restructure the field", async () => {
  seedStores();
  stubSubmittableRuntime();
  await openDialogOnSubmittableRuntime();
  const nameField = (screen.getByPlaceholderText("e.g. Alice") as HTMLElement)
    .closest('[data-slot="field"]') as HTMLElement;
  assert.ok(nameField, "the Name input must sit inside a Field");

  const rowsWhileSilent = nameField.querySelectorAll('[data-slot="field-description"]').length;
  assert.equal(
    rowsWhileSilent,
    1,
    "the message row must exist while the field has nothing to say — that is what reserves the space",
  );

  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: MALFORMED_NAME } });
  fireEvent.click(createButton());
  await screen.findByText(NAME_PATTERN_ERROR);

  assert.equal(
    nameField.querySelectorAll('[data-slot="field-description"]').length,
    rowsWhileSilent,
    "showing an error must reuse the reserved row, not add a new element — adding one is what moves every field below it",
  );
});

/**
 * TOOTH 5 — the retry action is inline, not a small button.
 *
 * RED when `FieldAction`'s link tone goes back to `size="sm"` (or any control
 * size): those variants carry `h-7` and `px-2.5`, which is the 28px box with side
 * padding Cindy flagged. Asserted as the class contract rather than computed
 * geometry because jsdom applies no stylesheet — stated plainly so this is not
 * mistaken for a measurement.
 *
 * The structural half matters just as much: no button size can sit a control
 * inline behind a BLOCK `<p>`, so the action must also be inside the sentence.
 */
test("the retry action renders inline inside the status sentence, without control padding", async () => {
  seedStores();
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({ ...machine, runtimes: ["kimi-sdk"] })),
  }));
  stubCreateAgentGet({ kind: "missing_config", recovery: "kimi_login" });

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog onClose={() => undefined} />
    </MemoryRouter>,
  );

  // Wait for the RUNTIME to settle, not just for a status element to exist. The
  // retry is only offered for a machine-backed source in a retryable state, so
  // querying before the runtime resolves finds a status that legitimately has no
  // action — and the test would then fail for a reason unrelated to layout.
  await waitFor(() => assert.equal(
    screen.getAllByRole("combobox").some((select) => select.textContent?.trim() === "Kimi Code"),
    true,
  ));
  const status = await screen.findByTestId("runtime-model-source-status");
  const retry = screen.getByRole("button", { name: "Retry" });

  // Structural: the action is a child of the status SENTENCE, not a sibling
  // parked under it. A block-level `<p>` before it forces a line break no matter
  // what size the button is, so this half cannot be skipped.
  const sentence = status.querySelector("p");
  assert.ok(sentence, "the status must render its message in a paragraph");
  assert.ok(
    sentence.contains(retry),
    "the retry must sit inside the status sentence — a sibling of a block paragraph is on its own line by construction",
  );

  // Metric: raft-ui's `inline` size zeroes the control box; `sm`/`md` do not.
  const cls = retry.className;
  assert.match(cls, /(^|\s)p-0(\s|$)/, "an inline action must carry no control padding (raft-ui size=\"inline\")");
  assert.match(cls, /(^|\s)h-auto(\s|$)/, "an inline action must not impose a control height");
  assert.match(cls, /align-baseline/, "an inline action must sit on the text baseline");
  assert.doesNotMatch(cls, /(^|\s)h-7(\s|$)/, "`size=\"sm\"` (h-7) is the 28px box that read as unnecessary padding");
  assert.doesNotMatch(cls, /(^|\s)px-2\.5(\s|$)/, "`size=\"sm\"` (px-2.5) is the side padding Cindy flagged");
  assert.doesNotMatch(cls, /(^|\s)mt-1(\s|$)/, "a top margin forces an inline action onto its own row");
});

/**
 * TOOTH 6 — native constraint validation stays off.
 *
 * Cindy's second finding was Chrome's own `required` bubble: an orange popup our
 * stylesheet cannot reach, drawn instead of the field's error. `noValidate` is
 * what stops the browser from both drawing it and blocking submit before our
 * handler runs.
 *
 * Guarded as an ATTRIBUTE rather than through a driven scenario, and worth being
 * plain about why. Under the current rule an empty field disables the button, so
 * the `required` bubble is unreachable from this suite — the live case is a
 * malformed value in an `input type="url"` (the custom-provider API URL), which
 * needs a provider/runtime combination this file does not set up. An attribute
 * assertion cannot prove the bubble is gone, but it does fail the moment
 * `noValidate` is dropped, which is the regression that would bring it back.
 * Without this, nothing in the suite holds that attribute down: it was green in
 * a mutation run with `noValidate` removed, which is how the gap was found.
 */
test("the form disables native constraint validation, so the browser cannot draw its own error", async () => {
  seedStores();
  stubSubmittableRuntime();
  await openDialogOnSubmittableRuntime();

  const form = (screen.getByPlaceholderText("e.g. Alice") as HTMLElement).closest("form");
  assert.ok(form, "the Name input must sit inside a form");
  assert.equal(
    form.noValidate,
    true,
    "the form must set noValidate — otherwise the browser's native bubble pre-empts the field's own error slot and blocks submit before handleSubmit runs",
  );

  // The `required` SEMANTICS stay: turning the browser's UI off is not the same
  // as telling assistive technology the field is optional.
  assert.equal(
    (screen.getByPlaceholderText("e.g. Alice") as HTMLInputElement).required,
    true,
    "`required` must remain on the control — noValidate suppresses the browser's UI, not the field's meaning",
  );
});

/**
 * TOOTH 7 — an invalid field ANNOUNCES that it is invalid.
 *
 * The teeth above proved the message is visible and in the right slot. All of
 * them were blind to whether the control itself is marked invalid, so a field
 * could show red text while telling assistive technology it was fine — which is
 * exactly what shipped on H=`f2e49193` and what @Dozy caught in review.
 *
 * Red text is also the single cue a colour-blind user is least likely to get, so
 * this is not only a screen-reader concern.
 *
 * `aria-invalid` is asserted on the ADOPTED CONTROL rather than on the wrapper:
 * the wrapper is not what a screen reader announces when focus lands on the
 * input. It must also be ABSENT while the field is silent — an input permanently
 * marked invalid is as useless as one never marked at all.
 */
test("a field showing an error marks its control invalid, and drops the mark when corrected", async () => {
  seedStores();
  stubSubmittableRuntime();
  await openDialogOnSubmittableRuntime();

  const nameInput = () => screen.getByPlaceholderText("e.g. Alice") as HTMLInputElement;
  assert.equal(
    nameInput().getAttribute("aria-invalid"),
    null,
    "a field with nothing to say must not claim to be invalid",
  );

  fireEvent.change(nameInput(), { target: { value: MALFORMED_NAME } });
  fireEvent.click(createButton());
  await screen.findByText(NAME_PATTERN_ERROR);

  assert.equal(
    nameInput().getAttribute("aria-invalid"),
    "true",
    "a field showing an error must mark its control aria-invalid — visible red text alone does not reach a screen reader",
  );
  // Two hooks, two places, asserted separately because they come from different
  // mechanisms and each can be lost without the other noticing:
  //
  //   control  `data-invalid` — stamped by StableField onto the adopted element.
  //            raft-ui's Input derives BOTH its `data-invalid:` styling variants
  //            and `aria-invalid` from this one prop, so the assertion above is
  //            really guarding this stamp.
  //   root     `data-invalid` — from Base UI, via `invalid` on the Field root.
  //            Base UI puts it ONLY here, never on the control, which is why the
  //            control needs its own stamp at all.
  //
  // Asserting only the control left the root's `invalid` prop deletable with the
  // suite still green (found by mutation, not by reading).
  assert.ok(
    nameInput().hasAttribute("data-invalid"),
    "the adopted control must carry data-invalid — raft-ui's Input styles its invalid state from this prop, and Base UI does not set it on the control",
  );
  const root = nameInput().closest('[data-slot="field"]');
  assert.ok(root, "the Name input must sit inside a Field");
  assert.ok(
    root.hasAttribute("data-invalid"),
    "the field ROOT must be marked invalid too — it is the `group/field` styling hook, and it is what carries the state in the library's own model",
  );

  // BOUNDARY, stated rather than implied: this drives an <Input>. The same stamp
  // is applied to any adopted control, but a Select trigger's invalid styling is
  // not exercised here — no case in this file puts a select into an error state.

  fireEvent.change(nameInput(), { target: { value: "Alice" } });
  await waitFor(() => assert.equal(
    screen.queryByText(NAME_PATTERN_ERROR) === null,
    true,
    "correcting the value clears the message",
  ));
  assert.equal(
    nameInput().getAttribute("aria-invalid"),
    null,
    "...and clears the mark with it — a control left permanently invalid is as useless as one never marked",
  );
});

/**
 * TOOTH 8 — in a two-control field, the VALUE control is the one marked invalid.
 *
 * Model in custom mode has a Select that picks the mode and an Input that holds
 * the value. On H=`b396d486` the field adopted the Select — the Input was nested
 * in a spacing `<div>` and so was not even a candidate — so the error marked the
 * mode picker while the box the user actually had to fill announced itself as
 * fine. Tooth 7 was blind to it: it drives the Name field, which has exactly one
 * control, so the wrong-control case could not arise there (@Dozy, task #20).
 *
 * Rendered directly rather than through the whole dialog: reaching custom-model
 * mode needs a runtime/provider combination the dialog fixtures here do not set
 * up, and the defect is in StableField's adoption, which this exercises exactly.
 * Stated plainly so this is not read as end-to-end coverage of that dialog state.
 */
test("a field with a mode Select and a value Input marks the INPUT invalid, not the Select", async () => {
  const { Input: RuiInput, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } = await import("raft-ui");
  const StableField = (await import("../src/components/agent/StableField")).default;

  rtlRender(
    <TestIntlProvider locale="en">
      <StableField label="Model" required error="Model is required">
        <Select value="custom">
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="custom">Custom…</SelectItem></SelectContent>
        </Select>
        <RuiInput data-field-adopt className="mt-2" placeholder="model-id" />
      </StableField>
    </TestIntlProvider>,
  );

  const valueInput = screen.getByPlaceholderText("model-id");
  assert.equal(
    valueInput.getAttribute("aria-invalid"),
    "true",
    "the VALUE control must carry the invalid state — it is the box the error is about",
  );
  assert.ok(
    valueInput.hasAttribute("data-invalid"),
    "...and its styling hook, or the input the user must fix renders with no error styling at all",
  );

  // THE OTHER HALF, and the reason this test existed with a misleading name for a
  // round: the title said "not the Select" while nothing checked the Select. It
  // was marked too — Base UI's `invalid` prop is a CONTEXT value that reaches
  // every field-aware control under the root, so the first fix widened the bug
  // from "wrong control marked" to "right AND wrong control marked" (@Dozy,
  // task #21). A valid choice announced as a mistake is worse than silence.
  const modeSelect = document.querySelector('[data-slot="button"][role="combobox"]');
  assert.ok(modeSelect, "the mode Select must render");
  assert.equal(
    modeSelect.getAttribute("aria-invalid"),
    null,
    "the mode Select holds a VALID value and must not announce itself invalid — marking it tells a screen-reader user their correct choice is a mistake",
  );
  assert.equal(
    modeSelect.hasAttribute("data-invalid"),
    false,
    "...and must not pick up the error styling either",
  );

  // The associations tooth 8 still did not read, which is why it stayed green
  // through a second round of this same bug (@Dozy, task #22). Clearing
  // `aria-invalid` does not make an error DESCRIPTION on a valid control true:
  // focusing the mode Select still read out the Input's required-error.
  assert.match(
    ariaText(modeSelect, "aria-labelledby"),
    /Model/,
    "the mode Select must keep its accessible name — removing the error description must not cost it its label",
  );
  assert.equal(
    ariaText(modeSelect, "aria-describedby"),
    "",
    "the mode Select must NOT be described by the value control's error — a screen reader would read \"Model is required\" at a control whose value is valid",
  );
  assert.match(
    ariaText(valueInput, "aria-describedby"),
    /required/i,
    "...while the value Input keeps it: the message has to reach exactly one control, not zero",
  );

  // The field must not ALSO have failed closed: two interactive children with no
  // declaration is a construction error, and the marker is what resolves it.
  const root = valueInput.closest('[data-slot="field"]');
  assert.ok(root, "the Input must sit inside a Field");
  assert.equal(
    root.getAttribute("data-field-config-error"),
    null,
    "declaring the control must resolve the two-control case, not leave the field failing closed",
  );
});

/**
 * TOOTH 9 — the custom-model Input stays a DECLARED, DIRECT child.
 *
 * The defect was structural: that Input sat inside a spacing `<div>`, so adoption
 * never saw it. Two consequences — in custom mode the field adopted the Select
 * instead (tooth 8), and in built-in-gateway mode, where the Select renders as
 * `null`, the field saw ZERO controls and silently failed closed as misconfigured
 * (`data-field-config-error="0"`): permanently invalid and unwired. That second
 * one predates this ticket and had no coverage.
 *
 * Guarded as SOURCE SHAPE, and worth being explicit about why. My first attempt
 * built the fixed markup by hand in a render, which could not fail for the reason
 * it claimed: re-wrapping the real callsite in a `<div>` left it green, because it
 * was asserting against its own JSX rather than the component's. Reaching
 * built-in-gateway mode through the dialog needs a runtime/provider fixture this
 * file does not set up, so this pins the callsite form instead — the same
 * technique `runtimeConfigUiReuse.test.ts` uses deliberately elsewhere in this
 * repo. It cannot prove the rendered result; it does fail the moment the wrapper
 * or the declaration comes back.
 */
test("the custom-model Input is declared as the field's control and not re-wrapped", () => {
  const source = readFileSync(
    new URL("../src/components/agent/RuntimeConfigFields.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /\{customModelSupported && customModelInputMode && \(\s*(?:\/\*[\s\S]*?\*\/\s*)?<Input\s+data-field-adopt/,
    "the custom-model Input must be a DIRECT child carrying data-field-adopt — wrapped in an element it is invisible to adoption, which adopts the mode Select instead (custom mode) or nothing at all (gateway mode, where the Select is null)",
  );
});

/**
 * TOOTH 10 — a select-only field still announces its error.
 *
 * The counterweight to tooth 8. Stopping `invalid` from propagating through Field
 * context fixes the two-control case, but it also removes the only thing that was
 * marking a select in a ONE-control field — several fields here (schema Model in
 * non-gateway mode, for one) have a Select as their sole control and a real error
 * state. Fixing the first bug silently introduced this one; it was caught by
 * probing both shapes rather than by any assertion, which is why it gets its own.
 *
 * The mark has to survive two hops the compiler cannot check: StableField hands
 * `data-invalid` to `RuntimeSelectControl`, which must explicitly accept and
 * forward it to `SelectTrigger`. A component silently drops unknown props, so a
 * missing forward is invisible until something asserts the end of the chain.
 */
test("a field whose only control is a select still marks that select invalid", async () => {
  const StableField = (await import("../src/components/agent/StableField")).default;
  const { RuntimeSelectControlForTest } = await import("../src/components/agent/RuntimeConfigFields");

  rtlRender(
    <TestIntlProvider locale="en">
      <StableField label="Model" required error="Model is required">
        <RuntimeSelectControlForTest
          value="a"
          onValueChange={() => undefined}
          options={[{ value: "a", label: "A" }]}
          placeholder="Model"
          selectChrome="field"
        />
      </StableField>
    </TestIntlProvider>,
  );

  // `[role="combobox"]`, not `[data-slot="select-trigger"]`: the trigger renders
  // through Button, which overwrites the slot with "button". Selecting by the
  // slot silently matches nothing, and a `querySelector` that finds nothing makes
  // every following assertion unreachable rather than false.
  const trigger = document.querySelector('[role="combobox"]');
  assert.ok(trigger, "the select trigger must render");
  assert.equal(
    trigger.getAttribute("aria-invalid"),
    "true",
    "a select that IS the field's control must announce the error — otherwise fixing the two-control case silently un-marks every select-only field",
  );
  assert.ok(
    trigger.hasAttribute("data-invalid"),
    "...and must carry the styling hook, which lives on the trigger, not the Select root",
  );
  // The description has to make the same two hops. Scoping the message to the
  // adopted control means a select that IS the control gets it only if
  // RuntimeSelectControl forwards it — and a component swallows props it does not
  // declare. This was caught by the visual suite's "every field's control is
  // wired" check rather than by any tooth here, so it gets one.
  assert.match(
    ariaText(trigger, "aria-describedby"),
    /required/i,
    "a select that is its field's control must be described by the field's message — scoping the description must not leave select-only fields describing nothing",
  );
});

/**
 * TOOTH 11 — built-in-gateway, driven for real.
 *
 * Tooth 9 pins the callsite's SOURCE shape and says so; this renders the actual
 * `RuntimeConfigFields` in built-in-gateway mode and reads the result, which is
 * what @Dozy asked for and what a source assertion genuinely cannot give.
 *
 * In this mode the Model field's Select renders as `null`, leaving the declared
 * Input as the only control. Before the fix that Input was wrapped, the field
 * counted ZERO controls, and it failed closed as misconfigured — permanently
 * invalid and unwired.
 */
test("built-in-gateway renders a wired Model field whose Input carries the error", async () => {
  const { default: RuntimeConfigFields } = await import("../src/components/agent/RuntimeConfigFields");
  const { BUILTIN_RUNTIME_GATEWAY_PROVIDER_IDS } = await import("../src/utils/runtimeConfigForm");
  const gatewayProvider = BUILTIN_RUNTIME_GATEWAY_PROVIDER_IDS[0];
  assert.ok(gatewayProvider, "there must be at least one gateway provider to drive");

  rtlRender(
    <TestIntlProvider locale="en">
      <RuntimeConfigFields
        selectChrome="field"
        showValidationErrors
        runtime="builtin"
        onRuntimeChange={() => undefined}
        runtimeOptions={[{ value: "builtin", label: "Built-in" }]}
        model=""
        onModelChange={() => undefined}
        customModelMode={false}
        onCustomModelModeChange={() => undefined}
        modelOptions={[]}
        runtimeModels={{ source: { kind: "unsupported" }, models: [], loading: false, rescan: () => undefined }}
        providerMode="default"
        onProviderModeChange={() => undefined}
        providerApiUrl=""
        onProviderApiUrlChange={() => undefined}
        providerApiKey=""
        onProviderApiKeyChange={() => undefined}
        builtInProviderMode={gatewayProvider}
        onBuiltInProviderModeChange={() => undefined}
        builtInProviderApiKey="sk-set"
        onBuiltInProviderApiKeyChange={() => undefined}
        builtInProviderBaseUrl="https://gateway.example.com/v1"
        onBuiltInProviderBaseUrlChange={() => undefined}
        builtInProviderSupportsImageInput={false}
        onBuiltInProviderSupportsImageInputChange={() => undefined}
        piProviderMode="configured"
        onPiProviderModeChange={() => undefined}
        piProviderApiKey=""
        onPiProviderApiKeyChange={() => undefined}
        reasoningEffort={null}
        onReasoningEffortChange={() => undefined}
        command=""
        onCommandChange={() => undefined}
        envVarEntries={[]}
        onEnvVarEntriesChange={() => undefined}
      />
    </TestIntlProvider>,
  );

  const modelInput = screen.getByPlaceholderText(/model/i);
  const field = modelInput.closest('[data-slot="field"]');
  assert.ok(field, "the gateway model Input must sit inside a Field");
  assert.equal(
    field.getAttribute("data-field-config-error"),
    null,
    "the field must be WIRED — a null Select plus a wrapped Input left it counting zero controls and failing closed",
  );
  assert.equal(
    modelInput.getAttribute("aria-invalid"),
    "true",
    "an empty required gateway model must mark its Input invalid",
  );
});

test("no-schema Kimi fields do not advertise an unmanaged reasoning capability", async () => {
  const { default: RuntimeConfigFields } = await import("../src/components/agent/RuntimeConfigFields");

  rtlRender(
    <TestIntlProvider locale="en">
      <RuntimeConfigFields
        selectChrome="field"
        runtime="kimi-sdk"
        onRuntimeChange={() => undefined}
        runtimeOptions={[{ value: "kimi-sdk", label: "Kimi Code" }]}
        model="kimi-code/kimi-for-coding"
        onModelChange={() => undefined}
        customModelMode={false}
        onCustomModelModeChange={() => undefined}
        modelOptions={[{ value: "kimi-code/kimi-for-coding", label: "Kimi for Coding" }]}
        runtimeModels={{ source: { kind: "live" }, models: [], loading: false, rescan: () => undefined }}
        providerMode="default"
        onProviderModeChange={() => undefined}
        providerApiUrl=""
        onProviderApiUrlChange={() => undefined}
        providerApiKey=""
        onProviderApiKeyChange={() => undefined}
        builtInProviderMode="deepseek"
        onBuiltInProviderModeChange={() => undefined}
        piProviderMode="configured"
        onPiProviderModeChange={() => undefined}
        piProviderApiKey=""
        onPiProviderApiKeyChange={() => undefined}
        reasoningEffort="balanced-plus"
        onReasoningEffortChange={() => undefined}
        command=""
        onCommandChange={() => undefined}
        envVarEntries={[]}
        onEnvVarEntriesChange={() => undefined}
        schemaBacked={false}
      />
    </TestIntlProvider>,
  );

  assert.equal(
    screen.queryByTestId("runtime-reasoning-select") === null,
    true,
    "without a schema ref the client must neither show nor synthesize Kimi effort support",
  );
});

/**
 * TOOTH 12 — the real custom-model branch, all four properties at once.
 *
 * Tooth 8 composes the two-control shape by hand; this drives the actual
 * `RuntimeConfigFields` in custom-model mode, which is what @Dozy asked for after
 * two rounds where a hand-built fixture agreed with a broken component.
 *
 * All four assertions live in ONE test deliberately. Split across tests they can
 * pass in combinations that are individually true and jointly wrong — "Select not
 * described" is satisfied by a field that describes nothing at all, and "Input
 * described" by one that describes everything. The property is the SPLIT.
 */
test("real custom-model: the Input is invalid and described, the Select is clean, named, and not described", async () => {
  const { default: RuntimeConfigFields } = await import("../src/components/agent/RuntimeConfigFields");

  rtlRender(
    <TestIntlProvider locale="en">
      <RuntimeConfigFields
        selectChrome="field"
        showValidationErrors
        runtime="claude"
        onRuntimeChange={() => undefined}
        runtimeOptions={[{ value: "claude", label: "Claude Code" }]}
        model=""
        onModelChange={() => undefined}
        customModelMode
        onCustomModelModeChange={() => undefined}
        modelOptions={[]}
        runtimeModels={{ source: { kind: "unsupported" }, models: [], loading: false, rescan: () => undefined }}
        providerMode="default"
        onProviderModeChange={() => undefined}
        providerApiUrl=""
        onProviderApiUrlChange={() => undefined}
        providerApiKey=""
        onProviderApiKeyChange={() => undefined}
        builtInProviderMode="deepseek"
        onBuiltInProviderModeChange={() => undefined}
        builtInProviderApiKey=""
        onBuiltInProviderApiKeyChange={() => undefined}
        builtInProviderBaseUrl=""
        onBuiltInProviderBaseUrlChange={() => undefined}
        builtInProviderSupportsImageInput={false}
        onBuiltInProviderSupportsImageInputChange={() => undefined}
        piProviderMode="configured"
        onPiProviderModeChange={() => undefined}
        piProviderApiKey=""
        onPiProviderApiKeyChange={() => undefined}
        reasoningEffort={null}
        onReasoningEffortChange={() => undefined}
        command=""
        onCommandChange={() => undefined}
        envVarEntries={[]}
        onEnvVarEntriesChange={() => undefined}
      />
    </TestIntlProvider>,
  );

  const valueInput = screen.getByPlaceholderText(/custom model|model name|model id/i);
  const field = valueInput.closest('[data-slot="field"]');
  assert.ok(field, "the custom-model Input must sit inside a Field");
  const modeSelect = field.querySelector('[role="combobox"]');
  assert.ok(modeSelect, "the mode Select must render beside it — this is the two-control shape");

  assert.equal(valueInput.getAttribute("aria-invalid"), "true", "the value Input is the invalid one");
  assert.match(ariaText(valueInput, "aria-describedby"), /required/i, "the value Input carries the error description");

  assert.equal(modeSelect.getAttribute("aria-invalid"), null, "the mode Select holds a valid value and must not be marked invalid");
  assert.equal(modeSelect.hasAttribute("data-invalid"), false, "...nor styled invalid");
  assert.match(ariaText(modeSelect, "aria-labelledby"), /Model/, "...but must keep its accessible name");
  assert.equal(
    ariaText(modeSelect, "aria-describedby"),
    "",
    "...and must not be described by the value control's required-error",
  );
});

/**
 * TOOTH 13 — the direct-Select branch is wired, in the real dialog.
 *
 * Computer and Provider Connection pass a raft-ui `Select` straight to
 * StableField. That root renders no DOM, so everything adoption hands it
 * evaporates; `FieldSelectTrigger` is what pulls the field's message id and
 * invalid state out of context instead. Nothing committed covered that path —
 * swapping it back to a plain `SelectTrigger` left the DOM suite 23/23 green and
 * went red only in the local visual suite, which no CI job runs (@Dozy, task #23).
 * My commit message claimed both forwarding gaps were covered by teeth. Tooth 10
 * covers RuntimeSelectControl and tooth 12 the custom-model branch; this one was
 * missing, and the claim was wrong.
 *
 * Driven through the REAL dialog, not a hand-built StableField + Select. A
 * synthetic shape would prove `FieldSelectTrigger` works while staying green if a
 * callsite stopped using it — which is the regression at issue, and the same
 * mistake tooth 9's first version made.
 *
 * The Computer field has no error, so this asserts the ASSOCIATION exists at all:
 * the control points at its own field's message row. That is the property the
 * wiring provides, and it is absent the moment the trigger stops reading context.
 */
test("the Computer field's select is wired to its own message row", async () => {
  seedStores();
  stubSubmittableRuntime();
  await openDialogOnSubmittableRuntime();

  const computerLabel = screen.getByText(/^Computer/);
  const field = computerLabel.closest('[data-slot="field"]');
  assert.ok(field, "the Computer label must sit inside a Field");

  const trigger = field.querySelector('[role="combobox"]');
  assert.ok(trigger, "the Computer field must render a select trigger");

  const describedBy = trigger.getAttribute("aria-describedby");
  assert.ok(
    describedBy,
    "the Computer select must point at its field's message row — a raft-ui Select root renders no DOM, so without FieldSelectTrigger reading context the association silently disappears",
  );

  // ...and point at THIS field's row, not some other field's. An id that
  // resolves to nothing, or to a neighbour, reads as wired in a diff and is not.
  const row = field.querySelector('[data-slot="field-description"]');
  assert.ok(row, "the field must render its reserved message row");
  assert.ok(
    describedBy.split(/\s+/).includes(row.id),
    "the association must resolve to this field's own row",
  );
});

/**
 * TOOTH 14 — Create Agent's runtime-config selects stay on the field chrome.
 *
 * The mirror of `agentRuntimeConnectionFields`' assertion for Edit Agent, and it
 * exists because of an asymmetry worth naming: when the legacy chrome was
 * retired, reverting `chrome` to `"default"` turned Edit Agent's dom tooth red
 * but left every Create Agent dom tooth green — Create Agent's only guard was in
 * the browser suite, which no CI job runs. So a regression here would have been
 * caught locally and shipped by CI.
 *
 * Asserted on the trigger, not the Select root: raft-ui's root renders no DOM, so
 * `chrome` never appears as an attribute anywhere.
 */
test("Create Agent's runtime-config selects render on the field chrome", async () => {
  seedStores();
  stubSubmittableRuntime();
  await openDialogOnSubmittableRuntime();

  const triggers = [...document.querySelectorAll('[role="combobox"]')] as HTMLElement[];
  assert.ok(triggers.length > 0, "the dialog must render select triggers");

  for (const trigger of triggers) {
    assert.match(
      trigger.className,
      /(?:^| )text-field(?: |$)/,
      "every trigger must carry the field type contract — default chrome is BUTTON metrics (h-8/text-sm/font-bold), the look the retired legacy arm used to pin with !important",
    );
    assert.match(
      trigger.className,
      /(?:^| )font-field(?: |$)/,
      "…including weight",
    );
  }
});
