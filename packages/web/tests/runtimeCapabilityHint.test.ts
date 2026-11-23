import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { RUNTIME_RAFT_CAPABILITIES, RUNTIMES } from "@botiverse/raft-shared";
import { mergedMessages } from "../src/i18n/messages";
import { isLimitedRuntime, runtimeCapabilityHintId, runtimePickerGuidance } from "../src/utils/runtimeCapabilityHint";
import { flatRuntimePickerOptions, groupRuntimePickerRows } from "../src/components/agent/runtimePickerOptions";

const intl = createIntl({ locale: "en", messages: mergedMessages("en") });
const formatMessage = intl.formatMessage as Parameters<typeof runtimePickerGuidance>[2];

// Every runtime a picker offers, and what it says beside the name (cindyz, #triage:#524).
const EXPECTED: Record<string, { recommended: true } | { limited?: true; hint: string } | Record<string, never>> = {
  claude: { recommended: true },
  codex: { recommended: true },
  "kimi-sdk": {},
  pi: { hint: "runtime.capabilityHint.noSubagents" },
  builtin: { hint: "runtime.capabilityHint.noSubagents" },
  qoder: { hint: "runtime.capabilityHint.compactionUnreported" },
  grok: { hint: "runtime.capabilityHint.noSubagentsCompactionUnreported" },
  antigravity: { hint: "runtime.capabilityHint.noSubagentsCompactionUnreported" },
  qwen: { limited: true, hint: "runtime.capabilityHint.noSteeringCompactionUnreported" },
  cursor: { limited: true, hint: "runtime.capabilityHint.noSteeringNoSubagents" },
  opencode: { limited: true, hint: "runtime.capabilityHint.noSteeringNoSubagentsCompactionUnreported" },
  dsh: { hint: "runtime.capabilityHint.noSubagentsCompactionUnreported" },
};

test("every non-deprecated runtime gets Recommended, or Limited and/or its expected hint, or nothing", () => {
  const offered = RUNTIMES.filter((runtime) => runtime.supported && !runtime.deprecated).map((runtime) => runtime.id);
  // A new runtime needs a line here, and copy if it lacks a capability.
  assert.deepEqual([...offered].sort(), Object.keys(EXPECTED).sort());
  for (const id of offered) {
    const expected = EXPECTED[id]!;
    const hintId = "hint" in expected ? expected.hint : null;
    if (!("recommended" in expected)) assert.equal(runtimeCapabilityHintId(id), hintId, id);
    const guidance = runtimePickerGuidance(id, false, formatMessage);
    assert.deepEqual(
      guidance,
      "recommended" in expected
        ? { recommended: true }
        : {
            ...("limited" in expected ? { limited: true } : {}),
            ...(hintId ? { hint: formatMessage({ id: hintId as never }) } : {}),
          },
      id,
    );
  }
});

test("Limited is exactly the runtimes without mid-turn steering; never a recommended one, nor one Raft doesn't know", () => {
  const limited = Object.keys(RUNTIME_RAFT_CAPABILITIES).filter(isLimitedRuntime).sort();
  assert.deepEqual(limited, ["copilot", "cursor", "gemini", "opencode", "qwen"]);
  assert.equal(isLimitedRuntime("claude"), false);
  assert.equal(isLimitedRuntime("codex"), false);
  assert.equal(isLimitedRuntime("no-such-runtime"), false);
  assert.equal(isLimitedRuntime(""), false);
  assert.equal(runtimePickerGuidance("cursor", false, formatMessage).limited, true);
  assert.equal(runtimePickerGuidance("claude", false, formatMessage).limited, undefined);
  assert.equal(formatMessage({ id: "runtime.picker.limited" }), "Limited");
});

test("the hints are the approved English copy", () => {
  assert.equal(
    runtimePickerGuidance("cursor", false, formatMessage).hint,
    "May be harder to correct in Raft: it can't take new instructions mid-task or split work into parallel tasks.",
  );
  assert.equal(
    runtimePickerGuidance("pi", false, formatMessage).hint,
    "May take longer on complex tasks in Raft, because it can't split work into parallel tasks.",
  );
});

test("a runtime the server lists as deprecated keeps its deprecated label alone", () => {
  assert.deepEqual(runtimePickerGuidance("cursor", true, formatMessage), {});
  assert.deepEqual(runtimePickerGuidance("claude", true, formatMessage), {});
  assert.deepEqual(runtimePickerGuidance("copilot", true, formatMessage), {}, "no Limited either");
});

test("picker options carry Recommended, Limited and the hint (for the field's description, not the option's) in grouped and flat lists", () => {
  const rows = [
    { value: "claude", label: "Claude Code", disabled: false, capabilityStatus: "available" as const, ...runtimePickerGuidance("claude", false, formatMessage) },
    { value: "cursor", label: "Cursor CLI", disabled: false, capabilityStatus: "available" as const, ...runtimePickerGuidance("cursor", false, formatMessage) },
  ];
  const cursorHint = runtimePickerGuidance("cursor", false, formatMessage).hint;
  for (const options of [groupRuntimePickerRows(rows, { showAll: false, selectedValue: "claude", formatMessage }).options, flatRuntimePickerOptions(rows)]) {
    assert.deepEqual(options.map((option) => [option.value, option.recommended ?? false, option.limited ?? false, option.hint, option.description]), [
      ["claude", true, false, undefined, undefined],
      ["cursor", false, true, cursorHint, undefined],
    ]);
  }
});
