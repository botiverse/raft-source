import { TextLink } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { useServerStore } from "../../store/serverStore";
import { useAppNavigate } from "../../hooks/useAppNavigate";

/** The server's migration log opened on this computer (owners and admins). */
export function ComputerMigrationLogLink({ machineId }: { machineId: string }) {
  const { formatMessage } = useIntl();
  const role = useServerStore((s) => s.current?.role);
  const nav = useAppNavigate();
  const openLog = useCallback(() => nav.toMigrationLog({ computer: machineId }), [nav, machineId]);
  if (role !== "owner" && role !== "admin") return null;
  return (
    <TextLink className="w-fit text-caption" onClick={openLog} data-testid="machine-migration-log-link">
      {formatMessage({ id: "agent.migrationLog.viewLog" })}
    </TextLink>
  );
}
