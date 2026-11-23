/**
 * One export in a data export list (personal or server, by its mount):
 * preparing, ready (Download each part, the day it's deleted), failed or
 * expired, each with Delete (confirmed). Marked when the emailed link named it.
 */
import { Button, ListRow, ListRowBody, ListRowDescription, ListRowTitle } from "@botiverse/raft-ui";
import { useCallback, useId, useState } from "react";
import { useIntl } from "react-intl";

import ConfirmDialog from "../../../components/ConfirmDialog";
import Banner from "../../../components/ui/Banner";
import { formatFileSizeBytes } from "../../../utils/fileSizePresentation";
import { dataExportFileName, dataExportRefusalOf, deleteDataExport, downloadDataExportVolume } from "./dataExportApi";
import type { DataExportItem, DataExportMount } from "./dataExportApi";
import { useDay } from "./dataExportHooks";

export function DataExportRow({ mount, item, linked, reload }: { mount: DataExportMount; item: DataExportItem; linked: boolean; reload: () => Promise<void> }) {
  const { formatMessage } = useIntl();
  const day = useDay();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const titleId = useId();

  const status = (() => {
    switch (item.status) {
      case "queued":
      case "running":
        return formatMessage({ id: "dataExport.status.preparing" });
      case "ready":
        return formatMessage({ id: "dataExport.status.ready" }, { size: formatFileSizeBytes(item.sizeBytes ?? 0, formatMessage), date: day(item.expiresAt) });
      case "failed":
        return formatMessage({ id: mount.kind === "server" ? "serverDataExport.status.failed" : "dataExport.status.failed" });
      default:
        return formatMessage({ id: "dataExport.status.expired" });
    }
  })();

  const download = useCallback((volume: number) => {
    setBusy(volume);
    setFailure(null);
    void downloadDataExportVolume(mount, item.id, volume, dataExportFileName(mount, item, volume))
      .catch((err: unknown) => setFailure(formatMessage({
        // A sign-in under a day old may not download (the create flow's rule too).
        id: dataExportRefusalOf(err).kind === "session_too_new" ? "dataExport.downloadSessionTooNew" : "dataExport.downloadFailed",
      })))
      .finally(() => setBusy(null));
  }, [formatMessage, item, mount]);
  const askDelete = useCallback(() => setConfirming(true), []);
  const closeDelete = useCallback(() => setConfirming(false), []);
  const confirmDelete = useCallback(async () => {
    try {
      await deleteDataExport(mount, item.id);
    } catch {
      setFailure(formatMessage({ id: "dataExport.deleteFailed" }));
    }
    await reload();
  }, [formatMessage, item.id, mount, reload]);

  return (
    <ListRow id={`data-export-${item.id}`} variant="plain" interactive={false} selected={linked} aria-current={linked ? "true" : undefined} data-testid={`data-export-row-${item.id}`}>
      <ListRowBody>
        <ListRowTitle id={titleId}>{formatMessage({ id: "dataExport.rowTitle" }, { date: day(item.createdAt) })}</ListRowTitle>
        <ListRowDescription wrap>{status}</ListRowDescription>
        {failure ? <Banner intent="warning" density="sm">{failure}</Banner> : null}
      </ListRowBody>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {item.status === "ready" ? item.volumes.map((volume) => (
          <DownloadButton key={volume.index} exportId={item.id} volume={volume.index} parts={item.volumes.length} busy={busy === volume.index} describedBy={titleId} onDownload={download} />
        )) : null}
        <Button variant="ghost" size="sm" onClick={askDelete} aria-describedby={titleId} data-testid={`data-export-delete-${item.id}`}>
          {formatMessage({ id: "dataExport.delete" })}
        </Button>
      </div>
      {confirming ? (
        <ConfirmDialog
          title={formatMessage({ id: "dataExport.deleteTitle" })}
          message={formatMessage({ id: "dataExport.deleteMessage" })}
          confirmLabel={formatMessage({ id: "dataExport.delete" })}
          confirmVariant="danger"
          confirmTestId="data-export-delete-confirm"
          onConfirm={confirmDelete}
          onClose={closeDelete}
        />
      ) : null}
    </ListRow>
  );
}

/** Download, or Part n of several; described by its export's title, so "Download" says which. */
function DownloadButton({ exportId, volume, parts, busy, describedBy, onDownload }: { exportId: string; volume: number; parts: number; busy: boolean; describedBy: string; onDownload: (volume: number) => void }) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onDownload(volume), [onDownload, volume]);
  return (
    <Button variant="outline" size="sm" loading={busy} onClick={handleClick} aria-describedby={describedBy} data-testid={`data-export-download-${exportId}-${volume}`}>
      {parts > 1 ? formatMessage({ id: "dataExport.downloadPart" }, { n: volume }) : formatMessage({ id: "dataExport.download" })}
    </Button>
  );
}
