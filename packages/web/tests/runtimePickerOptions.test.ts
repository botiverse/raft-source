import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { mergedMessages } from "../src/i18n/messages";
import { flatRuntimePickerOptions, groupRuntimePickerRows } from "../src/components/agent/runtimePickerOptions";
import type { RuntimePickerRow } from "../src/components/agent/runtimePickerOptions";

const intl = createIntl({ locale: "en", messages: mergedMessages("en") });
const formatMessage = intl.formatMessage as Parameters<typeof groupRuntimePickerRows>[1]["formatMessage"];

const ROWS: RuntimePickerRow[] = [
  { value: "claude", label: "Claude Code", disabled: false, capabilityStatus: "available" },
  { value: "codex", label: "Codex CLI", availabilitySuffix: " (not installed)", disabled: true, capabilityStatus: "not_installed" },
  { value: "builtin", label: "Built-in Pi", availabilitySuffix: " (update required)", disabled: true, capabilityStatus: "update_required" },
  { value: "kimi-sdk", label: "Kimi Code", disabled: false, capabilityStatus: "available" },
];

function grouped(rows: RuntimePickerRow[], showAll: boolean, selectedValue = "claude") {
  return groupRuntimePickerRows(rows, { showAll, selectedValue, formatMessage });
}

test("create: ready first, then needs a Raft Computer update; not installed only on request", () => {
  const hidden = grouped(ROWS, false);
  assert.deepEqual(hidden.options.map((option) => [option.group, option.value, option.disabled]), [
    ["Ready on this computer", "claude", false],
    ["Ready on this computer", "kimi-sdk", false],
    ["Needs a Raft Computer update", "builtin", true],
  ]);
  assert.equal(hidden.canToggle, true);

  const all = grouped(ROWS, true);
  // The group heading says it: no "(not installed)" / "(update required)" on its
  // rows in the list. The closed field has no heading, so the suffix is kept for it.
  assert.deepEqual(all.options.at(-1), {
    value: "codex",
    label: "Codex CLI",
    disabled: true,
    availabilitySuffix: " (not installed)",
    availabilitySuffixInList: false,
    group: "Not installed on this computer",
  });
  const builtin = all.options.find((option) => option.value === "builtin");
  assert.deepEqual([builtin?.label, builtin?.availabilitySuffix, builtin?.availabilitySuffixInList], ["Built-in Pi", " (update required)", false]);
});

test("onboarding's flat list keeps each row's availability suffix and Experimental flag", () => {
  const rows: RuntimePickerRow[] = [
    ...ROWS,
    { value: "qoder", label: "Qoder", availabilitySuffix: " (not installed)", experimental: true, disabled: true, capabilityStatus: "not_installed" },
  ];
  assert.deepEqual(flatRuntimePickerOptions(rows).map((option) => [option.label, option.availabilitySuffix, option.availabilitySuffixInList, option.experimental ?? false]), [
    ["Claude Code", undefined, undefined, false],
    ["Codex CLI", " (not installed)", undefined, false],
    ["Built-in Pi", " (update required)", undefined, false],
    ["Kimi Code", undefined, undefined, false],
    ["Qoder", " (not installed)", undefined, true],
  ]);
});

test("an experimental runtime keeps its Experimental flag in every group, its label plain", () => {
  const rows: RuntimePickerRow[] = [
    ...ROWS,
    { value: "qoder", label: "Qoder", availabilitySuffix: " (not installed)", experimental: true, disabled: true, capabilityStatus: "not_installed" },
  ];
  const qoder = grouped(rows, true).options.find((option) => option.value === "qoder");
  assert.deepEqual(qoder, {
    value: "qoder",
    label: "Qoder",
    disabled: true,
    experimental: true,
    availabilitySuffix: " (not installed)",
    availabilitySuffixInList: false,
    group: "Not installed on this computer",
  });
});

test("switch: the current runtime is pinned first in its own group, even when it is not installed", () => {
  const rows: RuntimePickerRow[] = [
    ...ROWS,
    { value: "copilot", label: "Copilot CLI (deprecated)", availabilitySuffix: " (not installed)", disabled: true, capabilityStatus: "not_installed", current: true },
  ];
  const { options } = grouped(rows, false, "copilot");
  assert.deepEqual(options[0], {
    value: "copilot",
    label: "Copilot CLI (deprecated)",
    disabled: true,
    // Outside the Not installed group the row still says it, in the list too.
    availabilitySuffix: " (not installed)",
    group: "Current runtime",
  });
  assert.ok(!options.some((option) => option.value === "codex"));
});

test("a picked runtime stays listed after it disappears from the computer", () => {
  const { options } = grouped(ROWS, false, "codex");
  assert.ok(options.some((option) => option.value === "codex" && option.group === "Not installed on this computer"));
});

test("with nothing else to offer, not-installed rows show without the toggle", () => {
  const rows = ROWS.filter((row) => row.capabilityStatus === "not_installed");
  const result = grouped(rows, false, "");
  assert.deepEqual(result.options.map((option) => option.value), ["codex"]);
  assert.equal(result.canToggle, false);
});

test("only a runtime this server does not offer besides not-installed ones: the not-installed rows show without the toggle", () => {
  const rows: RuntimePickerRow[] = [
    ...ROWS.filter((row) => row.capabilityStatus === "not_installed"),
    { value: "qwen", label: "Qwen Code", experimental: true, disabled: true, selectable: false, capabilityStatus: "available" },
  ];
  const result = grouped(rows, false, "");
  assert.deepEqual(result.options.map((option) => option.value), ["codex"], "not an empty list behind a toggle");
  assert.equal(result.canToggle, false);
});

test("a runtime the computer has but this server does not let you pick is not listed", () => {
  const rows: RuntimePickerRow[] = [
    ...ROWS,
    { value: "qwen", label: "Qwen Code", experimental: true, disabled: true, selectable: false, capabilityStatus: "available" },
  ];
  const { options } = grouped(rows, false, "");
  assert.equal(options.find((option) => option.value === "qwen"), undefined);
  assert.deepEqual(options.map((option) => option.value), ["claude", "kimi-sdk", "builtin"]);
});

test("a runtime the computer has and this server lets you pick is listed under Ready, a revived deprecated one too", () => {
  // Antigravity is deprecated in the bundled catalog; a server with
  // `agent_runtime_oar_antigravity` on offers it again (canSelectInThisContext).
  const rows: RuntimePickerRow[] = [
    ...ROWS,
    { value: "qwen", label: "Qwen Code", experimental: true, disabled: false, selectable: true, capabilityStatus: "available" },
    { value: "antigravity", label: "Antigravity CLI", disabled: false, selectable: true, capabilityStatus: "available" },
  ];
  const { options } = grouped(rows, false, "");
  assert.deepEqual(options.find((option) => option.value === "qwen"), { value: "qwen", label: "Qwen Code", disabled: false, experimental: true, group: "Ready on this computer" });
  assert.deepEqual(options.find((option) => option.value === "antigravity"), { value: "antigravity", label: "Antigravity CLI", disabled: false, group: "Ready on this computer" });
  assert.deepEqual(options.map((option) => option.value), ["claude", "kimi-sdk", "qwen", "antigravity", "builtin"]);
});

test("as the field's value, a runtime this server does not let you pick shows under Not available, not Ready", () => {
  const rows: RuntimePickerRow[] = [
    ...ROWS,
    { value: "qwen", label: "Qwen Code", experimental: true, disabled: true, selectable: false, capabilityStatus: "available" },
  ];
  const { options } = grouped(rows, false, "qwen");
  const qwen = options.find((option) => option.value === "qwen");
  assert.deepEqual(qwen, { value: "qwen", label: "Qwen Code", disabled: true, experimental: true, group: "Not available on this server" });
  assert.deepEqual(options.map((option) => option.value), ["claude", "kimi-sdk", "qwen", "builtin"], "after Ready, before the rest");
});

test("a runtime briefly disabled while its form loads stays under Ready", () => {
  const rows: RuntimePickerRow[] = [
    { value: "kimi-sdk", label: "Kimi Code", disabled: true, selectable: true, capabilityStatus: "available" },
  ];
  assert.equal(grouped(rows, false, "").options[0].group, "Ready on this computer");
});

test("a row the person can pick is never hidden, whatever its capability says", () => {
  const rows: RuntimePickerRow[] = [
    ...ROWS,
    { value: "cursor", label: "Cursor CLI", disabled: false, capabilityStatus: "not_installed" },
  ];
  const { options } = grouped(rows, false);
  assert.ok(options.some((option) => option.value === "cursor" && option.group === "Ready on this computer"));
});
