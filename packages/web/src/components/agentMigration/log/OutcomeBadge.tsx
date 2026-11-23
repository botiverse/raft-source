import { useIntl } from "react-intl";
import { TriangleAlert } from "lucide-react";
import { Badge } from "@botiverse/raft-ui";
import type { AgentMigrationLogEntry } from "@botiverse/raft-shared";
import { OUTCOME_LABEL } from "./model";

/**
 * A move's result as a badge: failed in warning, canceled muted. A list of
 * moves leaves successes unmarked; the table, where every row has a result,
 * shows them too (`all`), and a move still running.
 */
export function OutcomeBadge({ outcome, all = false }: { outcome: AgentMigrationLogEntry["outcome"]; all?: boolean }) {
  const { formatMessage: t } = useIntl();
  if (outcome === "failed") return <Badge appearance="soft" variant="warning"><TriangleAlert aria-hidden />{t({ id: OUTCOME_LABEL.failed })}</Badge>;
  if (outcome === "canceled") return <Badge appearance="soft" variant="muted">{t({ id: OUTCOME_LABEL.canceled })}</Badge>;
  if (!all) return null;
  if (outcome === "in_progress") return <Badge appearance="soft" variant="information">{t({ id: "agent.migrationLog.outcome.inProgress" })}</Badge>;
  return <Badge appearance="soft" variant="success">{t({ id: OUTCOME_LABEL.completed })}</Badge>;
}
