/**
 * Settings › Administration › Data & privacy (#triage:#512 design v7 §4 "Owner
 * 的开关", §5): owners only (exportServerData), shown only when
 * GET /api/servers/:id/data-exports answers for the caller (404 while
 * data_export_v0 is off for them or this server; `available` false for
 * anyone but an owner), so the web follows the server's own evaluation.
 *
 * - "Allow members to export this server's context": the owner's switch
 *   (GET/PATCH /servers/:id/data-export-settings), off by default.
 * - Export server data: what's included, Export (a dialog: the summary of
 *   what the export would hold, the files or not, then the same proof steps
 *   as the personal export), and the server's exports (the same rows). A
 *   closed server asks for its full history (the only export it accepts).
 *
 * Its anchor is `#server-data-export`; a server export's emailed link
 * (`/?data_export=<id>&data_export_server=<server id>`) lands here.
 */
import { Button, Checkbox, DialogDescription, Field, FieldDescription, FieldItem, FieldLabel, ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle, Switch } from "@botiverse/raft-ui";
import type { ServerDataExportScope, ServerDataExportSettings, ServerDataExportSummary } from "@botiverse/raft-shared";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useIntl } from "react-intl";

import Banner from "../../../components/ui/Banner";
import { WorkspaceProductAnalyticsSection } from "../../../components/settings/UsageDataSettings";
import { useServerStore } from "../../../store/serverStore";
import { formatFileSizeBytes } from "../../../utils/fileSizePresentation";
import { getServerDataExportSettings, getServerDataExportSummary, serverDataExports, setServerMemberContextExport } from "../dataExport/dataExportApi";
import type { DataExportItem, DataExportMount } from "../dataExport/dataExportApi";
import { cooldownUntil, useDataExportList, useDay, useLinkedDataExport, useNow } from "../dataExport/dataExportHooks";
import { DataExportRequestDialog } from "../dataExport/DataExportRequestDialog";
import { DataExportRow } from "../dataExport/DataExportRow";

/** The section's anchor (`/settings/administration#server-data-export`). */
const SERVER_DATA_EXPORT_SECTION_ID = "server-data-export";

/**
 * Settings › Administration (owners: exportServerData, which comes with
 * editServerSettings): the product analytics switch, and the server's data
 * export beside it while data export is on, the two as one Data & privacy
 * section (cindyz, #triage:#512), as Account's. Otherwise Product analytics
 * alone, as an admin sees it.
 */
export function ServerDataPrivacySection() {
  const { formatMessage } = useIntl();
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const mount = useMemo(() => (serverId && serverSlug ? serverDataExports({ id: serverId, slug: serverSlug }) : null), [serverId, serverSlug]);
  const { load, reload } = useDataExportList(mount);
  if (!mount || !serverId || load.state !== "on") return <WorkspaceProductAnalyticsSection />;
  return (
    <WorkspaceProductAnalyticsSection label={formatMessage({ id: "serverDataExport.sectionLabel" })}>
      <div id={SERVER_DATA_EXPORT_SECTION_ID} className="mt-3" data-testid="server-data-export-section">
        <ContextSwitch serverId={serverId} />
        <ExportCard mount={mount} exports={load.exports} nextAllowedAt={load.nextAllowedAt} closed={load.closed} reload={reload} />
      </div>
    </WorkspaceProductAnalyticsSection>
  );
}

/** DS ListRow › a setting row, as the product analytics switch beside it; a save failure under the group. */
function ContextSwitch({ serverId }: { serverId: string }) {
  const { formatMessage } = useIntl();
  const idPrefix = useId();
  const [settings, setSettings] = useState<ServerDataExportSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getServerDataExportSettings(serverId).then((read) => {
      if (!cancelled) setSettings(read);
    }, () => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [serverId]);
  const handleChange = useCallback((checked: boolean) => {
    setSaving(true);
    setFailed(false);
    void setServerMemberContextExport(serverId, checked)
      .then(setSettings, () => setFailed(true))
      .finally(() => setSaving(false));
  }, [serverId]);
  return (
    <div className="mb-3">
      <ListRowGroup>
        <ListRow variant="plain" interactive={false}>
          <ListRowBody>
            <ListRowTitle id={`${idPrefix}-label`}>{formatMessage({ id: "serverDataExport.contextTitle" })}</ListRowTitle>
            <ListRowDescription id={`${idPrefix}-description`} wrap>{formatMessage({ id: "serverDataExport.contextDescription" })}</ListRowDescription>
          </ListRowBody>
          <Switch
            checked={settings?.memberContextExportEnabled ?? false}
            disabled={saving || settings === null || !settings.canManage}
            onCheckedChange={handleChange}
            aria-labelledby={`${idPrefix}-label`}
            aria-describedby={`${idPrefix}-description`}
            data-testid="server-data-export-context-switch"
          />
        </ListRow>
      </ListRowGroup>
      {failed ? <div className="mt-3"><Banner intent="warning" density="sm">{formatMessage({ id: "serverDataExport.contextSaveFailed" })}</Banner></div> : null}
    </div>
  );
}

function ExportCard({ mount, exports, nextAllowedAt, closed, reload }: { mount: DataExportMount; exports: DataExportItem[]; nextAllowedAt: string | null; closed: boolean; reload: () => Promise<void> }) {
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
    <>
      <ListRowGroup>
        <ListRow variant="plain" interactive={false}>
          <ListRowBody>
            <ListRowTitle id={titleId}>{formatMessage({ id: "serverDataExport.title" })}</ListRowTitle>
            <ListRowDescription wrap>{formatMessage({ id: closed ? "serverDataExport.closedDescription" : "serverDataExport.description" })}</ListRowDescription>
            {until && !inFlight ? (
              <ListRowDescription wrap data-testid="server-data-export-cooldown">
                {formatMessage({ id: "serverDataExport.cooldownUntil" }, { date: day(until.toISOString()) })}
              </ListRowDescription>
            ) : null}
          </ListRowBody>
          <Button variant="outline" onClick={open} disabled={inFlight || until !== null} aria-describedby={titleId} data-testid="server-data-export-request">
            {formatMessage({ id: "dataExport.request" })}
          </Button>
        </ListRow>
        {shown.map((item) => <DataExportRow key={item.id} mount={mount} item={item} linked={item.id === linked} reload={reload} />)}
      </ListRowGroup>
      {asking ? <ServerRequestDialog mount={mount} closed={closed} onClose={close} onCreated={created} /> : null}
    </>
  );
}

type SummaryLoad = { state: "loading" } | { state: "failed" } | { state: "ready"; summary: ServerDataExportSummary };

function ServerRequestDialog({ mount, closed, onClose, onCreated }: { mount: DataExportMount; closed: boolean; onClose: () => void; onCreated: () => void }) {
  const { formatMessage, formatNumber } = useIntl();
  const day = useDay();
  const [includeFiles, setIncludeFiles] = useState(false);
  const [summary, setSummary] = useState<SummaryLoad>({ state: "loading" });
  const filesId = useId();
  useEffect(() => {
    let cancelled = false;
    getServerDataExportSummary(mount).then((read) => {
      if (!cancelled) setSummary({ state: "ready", summary: read });
    }, () => {
      if (!cancelled) setSummary({ state: "failed" });
    });
    return () => {
      cancelled = true;
    };
  }, [mount]);
  const scope = useMemo((): ServerDataExportScope => ({ includeFiles, fullHistoryAfterClose: closed }), [closed, includeFiles]);
  const toggleFiles = useCallback((on: boolean) => setIncludeFiles(on), []);

  const summaryLines = useMemo(() => {
    if (summary.state === "loading") return [formatMessage({ id: "serverDataExport.summaryLoading" })];
    if (summary.state === "failed") return [formatMessage({ id: "serverDataExport.summaryFailed" })];
    const read = summary.summary;
    const counted = (n: number, capped: boolean) => `${formatNumber(n)}${capped ? "+" : ""}`;
    return [
      formatMessage({ id: "serverDataExport.summary" }, {
        channels: read.publicChannels,
        messages: counted(read.messages, read.messagesCapped),
        files: counted(read.files, read.filesCapped),
        size: formatFileSizeBytes(read.fileBytes, formatMessage),
      }),
      read.historyFrom
        ? formatMessage({ id: "serverDataExport.summaryHistoryFrom" }, { date: day(read.historyFrom) })
        : formatMessage({ id: "serverDataExport.summaryFullHistory" }),
    ];
  }, [day, formatMessage, formatNumber, summary]);

  const scopeStep = useCallback((busy: boolean) => (
    <>
      <DialogDescription>{formatMessage({ id: closed ? "serverDataExport.closedDescription" : "serverDataExport.dialogDescription" })}</DialogDescription>
      <DialogDescription>{formatMessage({ id: "serverDataExport.notIncluded" })}</DialogDescription>
      <div className="grid gap-1 text-callout text-foreground" data-testid="server-data-export-summary">
        {summaryLines.map((line) => <p key={line}>{line}</p>)}
      </div>
      <Field>
        <FieldItem>
          <Checkbox id={filesId} checked={includeFiles} onCheckedChange={toggleFiles} disabled={busy} data-testid="server-data-export-include-files" />
          <div className="min-w-0">
            <FieldLabel htmlFor={filesId}>{formatMessage({ id: "serverDataExport.includeFiles" })}</FieldLabel>
            <FieldDescription>{formatMessage({ id: "serverDataExport.includeFilesHint" })}</FieldDescription>
          </div>
        </FieldItem>
      </Field>
    </>
  ), [closed, filesId, formatMessage, includeFiles, summaryLines, toggleFiles]);

  return (
    <DataExportRequestDialog
      mount={mount}
      title={formatMessage({ id: "serverDataExport.title" })}
      scope={scope}
      scopeStep={scopeStep}
      onClose={onClose}
      onCreated={onCreated}
    />
  );
}
