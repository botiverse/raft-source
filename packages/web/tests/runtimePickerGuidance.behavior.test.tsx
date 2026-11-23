import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { createIntl } from "react-intl";
import { mergedMessages } from "../src/i18n/messages";
import RuntimeConfigFields from "../src/components/agent/RuntimeConfigFields";
import { groupRuntimePickerRows } from "../src/components/agent/runtimePickerOptions";
import type { RuntimePickerRow } from "../src/components/agent/runtimePickerOptions";
import { runtimePickerGuidance } from "../src/utils/runtimeCapabilityHint";
import { TestIntlProvider } from "./helpers/intl";

// The Create agent and Edit runtime config pickers (#triage:#524): the list
// shows each runtime's name, with Recommended after Claude Code's, Limited
// after Cursor's (no mid-turn steering) and no Experimental badge; the chosen runtime's hint is the field's description,
// under the select, and the trigger's accessible description.

afterEach(() => cleanup());

const intl = createIntl({ locale: "en", messages: mergedMessages("en") });
const formatMessage = intl.formatMessage as Parameters<typeof runtimePickerGuidance>[2];

const CURSOR_HINT = "May be harder to correct in Raft: it can't take new instructions mid-task or split work into parallel tasks.";

function row(value: string, label: string): RuntimePickerRow {
  return { value, label, disabled: false, capabilityStatus: "available", ...runtimePickerGuidance(value, false, formatMessage) };
}

const { options } = groupRuntimePickerRows([row("claude", "Claude Code"), row("cursor", "Cursor CLI"), row("qoder", "Qoder")], {
  showAll: false,
  selectedValue: "claude",
  formatMessage,
});

function Picker() {
  const [runtime, setRuntime] = useState("claude");
  return <RuntimeConfigFields runtime={runtime} onRuntimeChange={setRuntime} runtimeOptions={options} />;
}

/** The trigger's accessible description, as the ids it names resolve. */
function describedText(element: HTMLElement): string {
  return (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ").trim();
}

test("the list shows names, Recommended and Limited only; once Cursor is chosen its hint is under the select", () => {
  render(<TestIntlProvider><Picker /></TestIntlProvider>);
  const trigger = screen.getByRole("combobox");
  assert.equal(trigger.textContent?.includes("Recommended"), false, "the closed field names the runtime only");
  assert.equal(describedText(trigger), "", "Claude Code has no hint");

  fireEvent.click(trigger);
  const claude = screen.getByRole("option", { name: "Claude Code Recommended" });
  assert.ok(within(claude).getByText("Recommended"));
  assert.ok(within(claude).queryByText("Limited") === null, "never both");
  const cursor = screen.getByRole("option", { name: "Cursor CLI Limited" });
  assert.ok(within(cursor).getByText("Limited"));
  assert.equal(cursor.getAttribute("aria-describedby"), null, "no description in the list");
  assert.ok(screen.getByRole("option", { name: "Qoder" }), "Qoder is its plain name");
  assert.ok(screen.queryByText(CURSOR_HINT) === null, "no hint in the list");
  assert.ok(screen.queryByText("Experimental") === null, "no Experimental badge");

  fireEvent.pointerDown(cursor, { pointerType: "mouse" });
  fireEvent.click(cursor);
  const description = screen.getByText(CURSOR_HINT);
  assert.equal(description.closest("[data-slot='field-description']") !== null, true, "the hint is the field's description");
  assert.equal(describedText(screen.getByRole("combobox")), CURSOR_HINT, "and the trigger's accessible description");
  assert.equal(screen.getByRole("combobox").textContent?.includes("Limited"), false, "the closed field names the runtime only");
});
