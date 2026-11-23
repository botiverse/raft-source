import { ScrollArea } from "@botiverse/raft-ui";
import { useCallback, useMemo, useState } from "react";
import { applyRuntimeFormV2Change, initialRuntimeFormV2Values, parseRuntimeFormV2 } from "@botiverse/raft-runtime-form";
import type { RuntimeFormV2Sources, RuntimeFormV2Value, RuntimeFormV2Values } from "@botiverse/raft-runtime-form";
import visualCases from "@botiverse/raft-runtime-form/fixtures/visual-cases.v3.json";
import { RuntimeFormV2Fields } from "../src/components/agent/RuntimeConfigFields";

// Runtime form visual cases (packages/runtime-form/fixtures/visual-cases.v3.json):
// the generated kitchen sink (every field kind in every state) and each
// runtime's real v3 create form, rendered by the production field renderer
// straight from the shared fixtures, with no API. Mobile renders the same
// files, so a difference between the captures is a renderer difference.

type VisualCaseEntry = {
  caseId: string;
  runtimeId: string;
  form: string;
  sources: Record<string, string>;
  state?: string;
};

type CaseState = {
  values: RuntimeFormV2Values;
  retryingSourceIds: string[];
  showValidationErrors: boolean;
  editing: boolean;
};

// The generated list is typed once here (JSON imports infer per-entry literal shapes).
const ENTRIES = (visualCases as unknown as { cases: VisualCaseEntry[] }).cases;
const FIXTURES = import.meta.glob<unknown>("../../runtime-form/fixtures/*.json", { eager: true, import: "default" });

export const RUNTIME_FORM_CASE_IDS: readonly string[] = ENTRIES.map((entry) => entry.caseId);

function fixture(name: string): unknown {
  const body = FIXTURES[`../../runtime-form/fixtures/${name}`];
  if (body === undefined) throw new Error(`runtime form fixture ${name} is missing`);
  return body;
}

function load(entry: VisualCaseEntry) {
  const form = parseRuntimeFormV2(fixture(entry.form));
  if (!form) throw new Error(`${entry.form} is not a runtime form`);
  const sources = Object.fromEntries(
    Object.entries(entry.sources).map(([sourceId, file]) => [sourceId, fixture(file)]),
  ) as RuntimeFormV2Sources;
  const state = entry.state ? (fixture(entry.state) as Partial<CaseState>) : {};
  return {
    form,
    sources,
    values: { ...initialRuntimeFormV2Values(form, sources), ...state.values },
    retryingSourceIds: state.retryingSourceIds ?? [],
    showValidationErrors: state.showValidationErrors ?? false,
    editing: state.editing ?? false,
  };
}

const ignoreRetry = () => undefined;

export function RuntimeFormCase({ caseId }: { caseId: string }) {
  const loaded = useMemo(() => {
    const entry = ENTRIES.find((candidate) => candidate.caseId === caseId);
    if (!entry) throw new Error(`unknown runtime form case ${caseId}`);
    return load(entry);
  }, [caseId]);
  const [values, setValues] = useState(loaded.values);
  const handleChange = useCallback((key: string, value: RuntimeFormV2Value) => {
    setValues((current) => applyRuntimeFormV2Change(loaded.form, loaded.sources, current, key, value));
  }, [loaded]);
  return (
    <main className="min-h-screen bg-layer-canvas font-display text-foreground">
      {/* The case root keeps the inline viewport height full-length capture grows; the form scrolls inside it. */}
      <div data-visual-case={caseId} style={{ width: 390, height: 844, background: "var(--layer-canvas)" }}>
        <ScrollArea className="h-full" contentClassName="stack-y-3 p-4">
          <RuntimeFormV2Fields
            form={loaded.form}
            sources={loaded.sources}
            values={values}
            onChange={handleChange}
            showValidationErrors={loaded.showValidationErrors}
            editing={loaded.editing}
            onRetrySource={ignoreRetry}
            retryingSourceIds={loaded.retryingSourceIds}
          />
        </ScrollArea>
      </div>
    </main>
  );
}
