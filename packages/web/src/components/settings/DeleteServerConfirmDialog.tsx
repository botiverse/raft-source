import { useCallback, useState } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import ConfirmDialog from "../ConfirmDialog";
import SlugInput from "../ui/SlugInput";
import { useServerDataExportOffered } from "../../features/settings/dataExport/dataExportHooks";
import { useServerStore } from "../../store/serverStore";
import { requestServerSelection } from "../../utils/serverSelectionRequest";

/**
 * The one delete-server confirmation (type the slug to confirm), shared by the
 * Settings danger zone and the blocking server-setup footer so both doors to
 * the same irreversible action ask the same question. While this owner may
 * export the server (data export on for them and it), it points them to
 * Settings › Administration › Data & privacy to export before closing: no page
 * reaches a closed server, so its full-history export is the API's only for
 * now (#triage:#512 §5).
 */
export default function DeleteServerConfirmDialog({ onClose, layer }: { onClose: () => void; layer?: number }) {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const deleteServer = useServerStore((s) => s.deleteServer);
  const [confirmSlug, setConfirmSlug] = useState("");
  const exportOffered = useServerDataExportOffered(server ?? null);

  const handleDelete = useCallback(async () => {
    requestServerSelection();
    await deleteServer();
  }, [deleteServer]);
  const handleConfirmSlugChange = useCallback((e: ChangeEvent<HTMLInputElement>) => setConfirmSlug(e.target.value), []);

  if (!server) return null;
  return (
    <ConfirmDialog
      chromeLocale="active"
      layer={layer}
      title={formatMessage({ id: "settings.dangerZone.deleteServerTitle" })}
      message={(
        <div className="stack-y-4">
          <p>
            {formatMessage({ id: "settings.dangerZone.deleteWarningPrefix" })}<span className="font-semibold text-foreground">{server.name}</span>{formatMessage({ id: "settings.dangerZone.deleteWarningSuffix" })}
          </p>
          {exportOffered ? <p data-testid="server-delete-export-hint">{formatMessage({ id: "settings.dangerZone.deleteExportHint" })}</p> : null}
          <div>
            <p className="mb-2 text-footnote font-semibold text-foreground">
              {formatMessage({ id: "settings.dangerZone.typeToConfirmPrefix" })}<code className="rounded-sticker bg-fill-muted px-1 font-mono text-mono-code text-foreground">{server.slug}</code>{formatMessage({ id: "settings.dangerZone.typeToConfirmSuffix" })}
            </p>
            <SlugInput
              data-testid="server-delete-slug-input"
              type="text"
              value={confirmSlug}
              onChange={handleConfirmSlugChange}
              inputClassName="font-mono"
              placeholder={server.slug}
              autoFocus
            />
          </div>
        </div>
      )}
      confirmLabel={formatMessage({ id: "settings.dangerZone.deleteServer" })}
      loadingLabel={formatMessage({ id: "settings.dangerZone.deleting" })}
      confirmDisabled={confirmSlug !== server.slug}
      confirmTestId="server-delete-confirm-button"
      onConfirm={handleDelete}
      onClose={onClose}
    />
  );
}
