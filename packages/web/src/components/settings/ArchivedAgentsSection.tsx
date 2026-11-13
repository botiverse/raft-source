import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Archive } from "lucide-react";
import { Button, Card, TextLink } from "@botiverse/raft-ui";

import api from "../../api/client";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useAgentStore } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import AvatarSlot from "../ui/AvatarSlot";
import SectionHeader from "../ui/SectionHeader";

/** One row of `GET /agents/archived`. */
export interface ArchivedAgentEntry {
  agentId: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  creatorType: "user" | "agent" | null;
  creatorId: string | null;
  createdAt: string;
  archivedAt: string;
  archivedByUserId: string | null;
  workspaceState: "on_computer" | "deleted" | "unknown";
  pendingOp: "delete" | null;
  machineName: string | null;
}

function ArchivedAgentRow({ entry, metadata }: { entry: ArchivedAgentEntry; metadata: string }) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const name = entry.displayName || entry.name;
  const openAgent = useCallback(() => nav.toAgent(entry.agentId), [entry.agentId, nav]);
  const openWorkspace = useCallback(() => nav.toAgentWorkspace(entry.agentId), [entry.agentId, nav]);
  const browsable = entry.workspaceState === "on_computer";
  return (
    <div
      className="flex flex-col gap-3 px-4 py-3 sm:min-h-11 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`archived-agent-row-${entry.agentId}`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <AvatarSlot context="list-row" type="agent" agentAvatarUrl={entry.avatarUrl} className="shrink-0 grayscale opacity-dimmed" />
        <div className="min-w-0 flex-1">
          <TextLink
            className="block max-w-full truncate text-left text-subhead"
            aria-label={formatMessage({ id: "settings.archivedAgents.openAriaLabel" }, { name })}
            onClick={openAgent}
          >
            {name}
          </TextLink>
          <div className="mt-0.5 truncate text-footnote text-foreground-muted">{metadata}</div>
        </div>
      </div>
      {browsable && (
        <Button
          variant="outline"
          size="md"
          type="button"
          className="shrink-0"
          aria-label={formatMessage({ id: "settings.archivedAgents.viewWorkspaceAriaLabel" }, { name })}
          onClick={openWorkspace}
          data-testid={`archived-agent-workspace-${entry.agentId}`}
        >
          {formatMessage({ id: "settings.archivedAgents.viewWorkspace" })}
        </Button>
      )}
    </div>
  );
}

/**
 * Archived agents of this server, laid out like the archived channels above
 * it: name (opens the read-only profile), archive date and where the
 * workspace is, and a button to browse the workspace.
 */
function ArchivedAgentsSectionContent() {
  const { formatMessage } = useIntl();
  const { formatMediumDateTime } = useTimeFormatter();
  const agents = useAgentStore((state) => state.agents);
  // Re-read when an agent is archived in this session.
  const archivedCount = useMemo(() => agents.filter((agent) => agent.deletedAt).length, [agents]);
  const [entries, setEntries] = useState<ArchivedAgentEntry[]>([]);

  useEffect(() => {
    let canceled = false;
    // Advisory list: any failure (or an unexpected response) leaves it hidden.
    Promise.resolve()
      .then(() => api.get<{ agents: ArchivedAgentEntry[] }>("/agents/archived"))
      .then((response) => {
        const list = response?.data?.agents;
        if (!canceled && Array.isArray(list)) setEntries(list);
      })
      .catch(() => {});
    return () => { canceled = true; };
  }, [archivedCount]);

  if (entries.length === 0) return null;

  return (
    <section className="mb-6" data-testid="archived-agents-section">
      <SectionHeader
        className="mb-3"
        icon={<Archive size={16} />}
        label={formatMessage({ id: "settings.archivedAgents.title" })}
        count={entries.length}
      />
      <Card className="rule-y rule-line-hairline">
        {entries.map((entry) => {
          const workspace = entry.pendingOp
            ? formatMessage({ id: "settings.archivedAgents.workspaceDeleting" })
            : entry.workspaceState === "on_computer"
              ? formatMessage({ id: "settings.archivedAgents.workspaceOnComputer" }, { computer: entry.machineName ?? "" })
              : entry.workspaceState === "deleted"
                ? formatMessage({ id: "settings.archivedAgents.workspaceDeleted" })
                : formatMessage({ id: "settings.archivedAgents.workspaceUnknown" });
          return <ArchivedAgentRow key={entry.agentId} entry={entry} metadata={formatMessage({ id: "settings.archivedAgents.metadata" }, { date: formatMediumDateTime(entry.archivedAt), workspace })} />;
        })}
      </Card>
    </section>
  );
}

export default function ArchivedAgentsSection() {
  const serverId = useServerStore((state) => state.current?.id ?? null);
  return <ArchivedAgentsSectionContent key={serverId} />;
}
