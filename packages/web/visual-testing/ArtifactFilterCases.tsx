import { useState } from "react";
import type { ReactNode } from "react";
import { MessageSquare, Search, UserRound } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@botiverse/raft-ui";
import { ArtifactFilterCombobox } from "../src/apps/artifacts/ArtifactFilterCombobox";
import { DashboardToolbar, SortPicker, ViewToggle } from "../src/apps/artifacts/ArtifactDashboardToolbar";
import { DASHBOARD_SEARCH_CLASS } from "../src/apps/artifacts/artifactDashboardToolbarLayout";

// #proj-raft-ui:#210: the Artifacts home's phone filter row with a filter set,
// so a geometry spec (packages/visual-testing/tests/artifactFilterClearHitArea.spec.ts)
// can check that the ×'s touch hit area stays clear of the next control.
// `conversation-set`: Conversation set, then the unset Author button.
// `both-set`: both set, then the row's Clear (✕).
// `toolbar-row.desktop` / `toolbar-row.mid` (#proj-workspace:dc3c9fc9): the wide
// toolbar as the page draws it (search, filters, sort, grid/list), 1100px wide
// and 771px (the page's column in an 820px window), for
// packages/visual-testing/tests/toolbarRowAlignment.spec.ts.

export const ARTIFACT_FILTER_CASE_IDS = [
  "components.artifacts.filter-row.conversation-set",
  "components.artifacts.filter-row.both-set",
  "components.artifacts.toolbar-row.desktop",
  "components.artifacts.toolbar-row.mid",
] as const;

const NO_ITEMS: readonly string[] = [];
const labelOf = (value: string) => value;
function noop() {}

function Filter({ testId, name, set, icon }: { testId: string; name: string; set: string | null; icon: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  return (
    <ArtifactFilterCombobox
      testId={testId}
      icon={icon}
      name={name}
      value={set}
      valueLabel={set}
      appliedLabel={set === null ? null : `${name}: ${set}`}
      clearLabel={`Clear ${name}`}
      // A fixed value: the spec measures the row, it doesn't clear it.
      onValue={noop}
      items={NO_ITEMS}
      answer={null}
      labelOf={labelOf}
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQuery={setQuery}
      searchLabel={name}
      searchPlaceholder={name}
      footer={null}
    >
      {null}
    </ArtifactFilterCombobox>
  );
}

function WideToolbarRow({ caseId, width }: { caseId: string; width: number }) {
  return (
    <main data-visual-case={caseId} className="min-h-screen bg-layer-canvas font-display text-foreground">
      <div style={{ width }}>
        <DashboardToolbar
          phone={false}
          clear={null}
          sort={<SortPicker sort="opened" onChange={noop} />}
          view={<ViewToggle view="list" onChange={noop} />}
          search={(
            <div role="search" className={DASHBOARD_SEARCH_CLASS}>
              <InputGroup size="md">
                <InputGroupAddon>
                  <Search aria-hidden size={14} />
                </InputGroupAddon>
                <InputGroupInput type="search" readOnly value="" placeholder="Search" aria-label="Search" />
              </InputGroup>
            </div>
          )}
          filters={(
            <>
              <Filter testId="artifacts-filter-conversation" name="Conversation" set={null} icon={<MessageSquare aria-hidden className="size-3.5" />} />
              <Filter testId="artifacts-filter-author" name="Author" set={null} icon={<UserRound aria-hidden className="size-3.5" />} />
            </>
          )}
        />
      </div>
    </main>
  );
}

export function ArtifactFilterCase({ caseId }: { caseId: string }) {
  if (caseId.endsWith(".toolbar-row.desktop")) return <WideToolbarRow caseId={caseId} width={1100} />;
  if (caseId.endsWith(".toolbar-row.mid")) return <WideToolbarRow caseId={caseId} width={771} />;
  const both = caseId.endsWith(".both-set");
  return (
    <main data-visual-case={caseId} className="min-h-screen bg-layer-canvas font-display text-foreground">
      <DashboardToolbar
        phone
        search={null}
        sort={null}
        view={null}
        clear={both ? noop : null}
        filters={(
          <>
            <Filter testId="artifacts-filter-conversation" name="Conversation" set="#design" icon={<MessageSquare aria-hidden className="size-3.5" />} />
            <Filter testId="artifacts-filter-author" name="Author" set={both ? "Remy" : null} icon={<UserRound aria-hidden className="size-3.5" />} />
          </>
        )}
      />
    </main>
  );
}
