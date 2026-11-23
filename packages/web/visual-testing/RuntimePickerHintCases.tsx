import { getCreatableRuntimeOptions } from "@botiverse/raft-shared";
import { useMemo } from "react";
import type { CSSProperties } from "react";
import { useIntl } from "react-intl";
import RuntimeConfigFields from "../src/components/agent/RuntimeConfigFields";
import { groupRuntimePickerRows } from "../src/components/agent/runtimePickerOptions";
import type { RuntimePickerRow } from "../src/components/agent/runtimePickerOptions";
import { runtimePickerGuidance } from "../src/utils/runtimeCapabilityHint";

// The runtime field of Create agent and Edit runtime config (#triage:#524):
// every runtime offered for a new agent, all ready on this computer. The open
// list shows names only, Claude Code and Codex marked Recommended, the runtimes
// without mid-turn steering (Cursor CLI, OpenCode, Qwen Code) Limited; the chosen
// runtime's hint (web runtimeCapabilityHint.ts) is the field's description,
// under the closed select. The open cases' capture interaction opens the list,
// which opens scrolled to the chosen runtime: .hints at the top, .hints-end
// on Qoder at the bottom (the case is tall enough for the list). .hints-selected
// stays closed, on Cursor CLI, cropped to the field.

export const RUNTIME_PICKER_HINTS_CASES: Readonly<Record<string, { selected: string; listOpen: boolean }>> = {
  "components.agent.runtime-picker.hints": { selected: "claude", listOpen: true },
  "components.agent.runtime-picker.hints-end": { selected: "qoder", listOpen: true },
  "components.agent.runtime-picker.hints-selected": { selected: "cursor", listOpen: false },
};

export function isRuntimePickerHintsCase(caseId: string): boolean {
  return Object.hasOwn(RUNTIME_PICKER_HINTS_CASES, caseId);
}

const noop = () => undefined;
const FALLBACK_CASE = { selected: "claude", listOpen: true };
const FRAME: CSSProperties = { width: 480, padding: 16, boxSizing: "border-box", background: "var(--layer-canvas)" };
/** Tall enough for the open list. */
const FRAME_LIST_OPEN: CSSProperties = { ...FRAME, height: 560 };

export function RuntimePickerHintsCase({ caseId }: { caseId: string }) {
  const { selected, listOpen } = RUNTIME_PICKER_HINTS_CASES[caseId] ?? FALLBACK_CASE;
  const { formatMessage } = useIntl();
  const options = useMemo(() => {
    const rows: RuntimePickerRow[] = getCreatableRuntimeOptions().map((runtime) => ({
      value: runtime.id,
      label: runtime.displayName,
      ...runtimePickerGuidance(runtime.id, false, formatMessage),
      disabled: false,
      capabilityStatus: "available",
    }));
    return groupRuntimePickerRows(rows, { showAll: true, selectedValue: selected, formatMessage }).options;
  }, [formatMessage, selected]);
  return (
    <main className="min-h-screen bg-layer-canvas font-display text-foreground">
      <div data-visual-case={caseId} data-testid="runtime-picker-hints" style={listOpen ? FRAME_LIST_OPEN : FRAME}>
        <RuntimeConfigFields runtime={selected} onRuntimeChange={noop} runtimeOptions={options} reserveRuntimeMessage={false} />
      </div>
    </main>
  );
}
