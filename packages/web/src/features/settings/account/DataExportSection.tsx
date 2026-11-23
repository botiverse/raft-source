/**
 * Settings › Account › Data & privacy (#triage:#512 design v7 §4, §6, §8):
 * "Share usage data" and Export My Data in one section. Shown only while
 * data export is on for the person: the list route answers 404 while
 * data_export_v0 is off (the server's own evaluation, so the web never
 * disagrees with it), and then the section is the usage data switch alone,
 * as before.
 *
 * Export My Data: what's included, Export (a dialog: all servers or some,
 * the person's files or not, and other people's messages only when one of
 * the chosen servers' owners allows it: the list's `contextServerIds`), the
 * proof the server asks for (dataExport/DataExportRequestDialog.tsx), and the
 * exports (dataExport/DataExportRow.tsx). The emailed link
 * (`/?data_export=<id>`, App.tsx) opens this page on the section with that
 * export marked.
 */
import { Button, Checkbox, DialogDescription, Field, FieldDescription, FieldError, FieldItem, FieldLabel, ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle, RadioGroup, RadioGroupItem } from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import type { PersonalDataExportScope } from "@botiverse/raft-shared";
import { useCallback, useId, useMemo, useState } from "react";
import { useIntl } from "react-intl";

import { UsageDataSettingsCard } from "../../../components/settings/UsageDataSettings";
import { useServerStore } from "../../../store/serverStore";
import { PERSONAL_DATA_EXPORTS } from "../dataExport/dataExportApi";
import type { DataExportItem } from "../dataExport/dataExportApi";
import { cooldownUntil, useDataExportList, useDay, useLinkedDataExport, useNow } from "../dataExport/dataExportHooks";
import { DataExportRequestDialog } from "../dataExport/DataExportRequestDialog";
import { DataExportRow } from "../dataExport/DataExportRow";

/** The section's anchor (`/settings/account#data-export`). */
const DATA_EXPORT_SECTION_ID = "data-export";

/** Settings › Account: the usage data switch, and Export My Data beside it while data export is on. */
export function DataPrivacySection() {
  const { formatMessage } = useIntl();
  const { load, reload } = useDataExportList(PERSONAL_DATA_EXPORTS);
  if (load.state !== "on") return <UsageDataSettingsCard />;
  return (
    <UsageDataSettingsCard label={formatMessage({ id: "dataExport.sectionLabel" })}>
      <DataExportCard exports={load.exports} nextAllowedAt={load.nextAllowedAt} contextServerIds={load.contextServerIds} reload={reload} />
    </UsageDataSettingsCard>
  );
}

function DataExportCard({ exports, nextAllowedAt, contextServerIds, reload }: { exports: DataExportItem[]; nextAllowedAt: string | null; contextServerIds: string[]; reload: () => Promise<void> }) {
  const { formatMessage } = useIntl();
  const linked = useLinkedDataExport();
  const day = useDay();
  const titleId = useId();
  const [asking, setAsking] = useState(false);
  const now = useNow();

  const open = useCallback(() => setAsking(true), []);
  const close = useCallback(() => setAsking(false), []);
  const created = useCallback(() => {
    setAsking(false);
    void reload();
  }, [reload]);
  const inFlight = exports.some((item) => item.status === "queued" || item.status === "running");
  const until = cooldownUntil(nextAllowedAt, now);
  const shown = exports.filter((item) => item.status !== "deleted");

  return (
    <div id={DATA_EXPORT_SECTION_ID} className="mt-3 grid gap-3" data-testid="data-export-section">
      <ListRowGroup>
        <ListRow variant="plain" interactive={false}>
          <ListRowBody>
            <ListRowTitle id={titleId}>{formatMessage({ id: "dataExport.title" })}</ListRowTitle>
            <ListRowDescription wrap>{formatMessage({ id: "dataExport.description" })}</ListRowDescription>
            {until && !inFlight ? (
              <ListRowDescription wrap data-testid="data-export-cooldown">
                {formatMessage({ id: "dataExport.cooldownUntil" }, { date: day(until.toISOString()) })}
              </ListRowDescription>
            ) : null}
          </ListRowBody>
          <Button
            variant="outline"
            onClick={open}
            disabled={inFlight || until !== null}
            aria-describedby={titleId}
            data-testid="data-export-request"
          >
            {formatMessage({ id: "dataExport.request" })}
          </Button>
        </ListRow>
        {shown.map((item) => <DataExportRow key={item.id} mount={PERSONAL_DATA_EXPORTS} item={item} linked={item.id === linked} reload={reload} />)}
      </ListRowGroup>
      {asking ? (
        <PersonalRequestDialog contextServerIds={contextServerIds} onClose={close} onCreated={created} />
      ) : null}
    </div>
  );
}

function PersonalRequestDialog({ contextServerIds, onClose, onCreated }: { contextServerIds: string[]; onClose: () => void; onCreated: () => void }) {
  const { formatMessage } = useIntl();
  const servers = useServerStore((state) => state.servers);
  const [which, setWhich] = useState<"all" | "chosen">("all");
  const [chosen, setChosen] = useState<string[]>([]);
  const [includeFiles, setIncludeFiles] = useState(false);
  const [includeContext, setIncludeContext] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);

  // Context is offered only when a server in scope allows it (the server refuses it otherwise).
  const contextOffered = which === "all" ? contextServerIds.length > 0 : chosen.some((id) => contextServerIds.includes(id));
  const scope = useMemo((): PersonalDataExportScope => ({
    serverIds: which === "all" ? "all" : [...chosen].sort(),
    includeContext: contextOffered && includeContext,
    includeFiles,
  }), [chosen, contextOffered, includeContext, includeFiles, which]);

  const validate = useCallback(() => {
    if (which === "chosen" && chosen.length === 0) {
      setScopeError(formatMessage({ id: "dataExport.chooseServer" }));
      return false;
    }
    return true;
  }, [chosen.length, formatMessage, which]);

  const chooseServers = useCallback((next: string[]) => {
    setScopeError(null);
    setChosen(next);
  }, []);
  const serverItems = useMemo<ChoiceListItem[]>(() => servers.map((server) => ({ value: server.id, label: server.name })), [servers]);
  const whichLabelId = useId();
  const serversLabelId = useId();
  const filesId = useId();
  const contextId = useId();
  const chooseWhich = useCallback((value: unknown) => {
    setScopeError(null);
    setWhich(value === "chosen" ? "chosen" : "all");
  }, []);
  const toggleFiles = useCallback((on: boolean) => setIncludeFiles(on), []);
  const toggleContext = useCallback((on: boolean) => setIncludeContext(on), []);

  const scopeStep = useCallback((busy: boolean) => (
    <>
      <DialogDescription>{formatMessage({ id: "dataExport.dialogDescription" })}</DialogDescription>
      <DialogDescription>{formatMessage({ id: "dataExport.notIncluded" })}</DialogDescription>
      {/* DS RadioGroup: each answer a <label> row (items-start, gap-2) under the group's FieldLabel. */}
      <Field>
        <FieldLabel id={whichLabelId}>{formatMessage({ id: "dataExport.scopeLabel" })}</FieldLabel>
        <RadioGroup value={which} onValueChange={chooseWhich} aria-labelledby={whichLabelId} disabled={busy} className="gap-1">
          <label className="flex items-start gap-2 text-callout text-foreground">
            <RadioGroupItem value="all" data-testid="data-export-scope-all" />
            <span className="min-w-0">{formatMessage({ id: "dataExport.scopeAll" })}</span>
          </label>
          <label className="flex items-start gap-2 text-callout text-foreground">
            <RadioGroupItem value="chosen" data-testid="data-export-scope-chosen" />
            <span className="min-w-0">{formatMessage({ id: "dataExport.scopeChosen" })}</span>
          </label>
        </RadioGroup>
      </Field>
      {which === "chosen" ? (
        <Field invalid={scopeError !== null} data-testid="data-export-servers">
          <FieldLabel id={serversLabelId}>{formatMessage({ id: "dataExport.serversLabel" })}</FieldLabel>
          <ChoiceList
            multiple
            aria-labelledby={serversLabelId}
            items={serverItems}
            value={chosen}
            onValueChange={chooseServers}
            disabled={busy}
            searchLabel={formatMessage({ id: "dataExport.serversSearch" })}
            searchPlaceholder={formatMessage({ id: "dataExport.serversSearch" })}
            clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
            noMatchLabel={formatMessage({ id: "ui.selectionPopover.emptyLabel" })}
          />
          {scopeError ? <FieldError match>{scopeError}</FieldError> : null}
        </Field>
      ) : null}
      <Field>
        <FieldItem>
          <Checkbox id={filesId} checked={includeFiles} onCheckedChange={toggleFiles} disabled={busy} data-testid="data-export-include-files" />
          <div className="min-w-0">
            <FieldLabel htmlFor={filesId}>{formatMessage({ id: "dataExport.includeFiles" })}</FieldLabel>
            <FieldDescription>{formatMessage({ id: "dataExport.includeFilesHint" })}</FieldDescription>
          </div>
        </FieldItem>
      </Field>
      {contextOffered ? (
        <Field>
          <FieldItem>
            <Checkbox id={contextId} checked={includeContext} onCheckedChange={toggleContext} disabled={busy} data-testid="data-export-include-context" />
            <div className="min-w-0">
              <FieldLabel htmlFor={contextId}>{formatMessage({ id: "dataExport.includeContext" })}</FieldLabel>
              <FieldDescription>{formatMessage({ id: "dataExport.includeContextHint" })}</FieldDescription>
            </div>
          </FieldItem>
        </Field>
      ) : null}
    </>
  ), [chooseServers, chooseWhich, chosen, contextId, contextOffered, filesId, formatMessage, includeContext, includeFiles, scopeError, serverItems, serversLabelId, toggleContext, toggleFiles, which, whichLabelId]);

  return (
    <DataExportRequestDialog
      mount={PERSONAL_DATA_EXPORTS}
      title={formatMessage({ id: "dataExport.title" })}
      scope={scope}
      validate={validate}
      scopeStep={scopeStep}
      onClose={onClose}
      onCreated={onCreated}
    />
  );
}
