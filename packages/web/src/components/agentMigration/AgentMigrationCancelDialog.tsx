import { useCallback } from "react";
import { useIntl } from "react-intl";
import api from "../../api/client";
import ConfirmDialog from "../ConfirmDialog";
import type { Machine } from "../../store/machineStore";
import { migrationSupportRef, migrationTargetLabel } from "./presentation";
import type { AgentMigrationNotice, AgentMigrationStatusResponse } from "./realtime";
import { canCancelMigration, isHostedMigration } from "./state";
import { MigrationReference } from "./MigrationReference";

// A running migration bumps its revision at every step, so the revision the
// dialog opened with is often already stale when the user confirms. A stale
// rejection re-reads the status and retries for the same migration while it
// is still cancellable; anything else is surfaced as before.
const MAX_CANCEL_ATTEMPTS = 3;

function migrationErrorCode(error: unknown): string | undefined {
  return (error as { response?: { data?: { code?: string } } }).response?.data?.code;
}

export function AgentMigrationCancelDialog({
  agentId,
  notice,
  machines,
  onClose,
  onRefresh,
}: {
  agentId: string;
  notice: AgentMigrationNotice;
  machines: Machine[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const source = migrationTargetLabel(formatMessage, machines, notice.sourceMachineId);
  const target = migrationTargetLabel(formatMessage, machines, notice.targetMachineId);
  const ref = migrationSupportRef(notice);
  // A move to the cloud is canceled only before the switch, and only the source computer has to confirm.
  const hosted = isHostedMigration(notice);

  const submit = useCallback(async () => {
    if (!canCancelMigration(notice)) return;
    let expectedRevision = notice.revision;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await api.post(`/agents/${agentId}/migration/cancel`, {
          migrationRef: ref,
          expectedRevision,
        });
        await onRefresh();
        return;
      } catch (nextError: unknown) {
        const code = migrationErrorCode(nextError);
        if (code === "MIGRATION_REVISION_STALE" && attempt < MAX_CANCEL_ATTEMPTS) {
          const latest = await api.get<AgentMigrationStatusResponse>(`/agents/${agentId}/migration`)
            .then(({ data }) => data.migration)
            .catch(() => null);
          if (latest && latest.migrationRef === ref && canCancelMigration(latest)) {
            expectedRevision = latest.revision;
            continue;
          }
        }
        await onRefresh();
        const message = code === "MIGRATION_REVISION_STALE" || code === "MIGRATION_CONCURRENT_UPDATE"
          ? formatMessage({ id: "agent.migration.cancelDialogStaleError" })
          : formatMessage({ id: "agent.migration.cancelDialogGenericError" });
        const technicalCode = code && /^[A-Za-z][A-Za-z0-9_-]{1,127}$/.test(code) ? code : null;
        throw new Error(technicalCode ? `${message} (${technicalCode})` : message);
      }
    }
  }, [agentId, formatMessage, notice, onRefresh, ref]);

  return (
    <ConfirmDialog
      title={formatMessage({ id: "agent.migration.cancelDialogTitle" })}
      confirmLabel={formatMessage({ id: "agent.migration.cancelDialogConfirm" })}
      loadingLabel={formatMessage({ id: "agent.migration.cancelDialogRequesting" })}
      cancelLabel={formatMessage({ id: "agent.migration.cancelDialogKeepAction" })}
      confirmVariant="warning"
      confirmDisabled={!canCancelMigration(notice)}
      maxWidthClass="max-w-md"
      plainMessage
      chromeLocale="active"
      onClose={onClose}
      onConfirm={submit}
      message={
        <div className="stack-y-3">
          {hosted ? (
            <>
              <p>{formatMessage({ id: "agent.migration.hosted.cancelDialogSafeMessage" }, { source })}</p>
              <p>{formatMessage({ id: "agent.migration.hosted.cancelDialogExplanation" }, { source })}</p>
            </>
          ) : (
            <p>{formatMessage({ id: "agent.migration.cancelDialogMessage" }, { source, target })}</p>
          )}
          <MigrationReference notice={notice} />
        </div>
      }
    />
  );
}
