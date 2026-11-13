/**
 * One agent row of Delete Account (v7, accountDeletionAgentGroups.ts): the
 * person's agents on one of their computers, or on one server otherwise, and
 * what becomes of them. They go to the server's owner (the personal assistant
 * is archived); nothing here holds up the deletion (other members' agents on
 * the computer do: they are Needs action rows, OthersAgentsOnComputers). On the person's own
 * computer, which is deleted on the deletion date, the new owner runs them
 * on another computer, so the row also offers, optionally:
 *
 * - Move to Another Computer: the existing dialog (AgentMigrationDialog), only
 *   where the server's plan can move agents (Pro: the check the Computers rack
 *   and the agent's migration section make; an unknown plan doesn't hide it,
 *   the server decides). It reads the agent and the target computers from the
 *   current server's stores, so on another server it opens Delete Account
 *   there, with the dialog (`?move=<agentId>`).
 * - Archive: the DELETE every Archive sends, confirmed as Archive confirms.
 *
 * With more than one of the person's agents on it, each action is a menu of
 * them. Either reads the list again.
 */
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemLabel,
  DropdownMenuTrigger,
} from "@botiverse/raft-ui";
import { Archive, Bot, ChevronDown, Monitor } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Link, useNavigate } from "react-router-dom";

import { AgentMigrationDialog } from "../../../components/agentMigration/AgentMigrationDialog";
import { agentMigrationRequiresUpgrade } from "../../../components/agentMigration/billing";
import { useHostedMigrationAvailable } from "../../../components/agentMigration/useHostedMigrationAvailable";
import { archiveRequestErrorMessage } from "../../../components/agentArchive/archiveApi";
import ConfirmDialog from "../../../components/ConfirmDialog";
import { useAgentStore } from "../../../store/agentStore";
import type { Agent } from "../../../store/agentStore";
import { useMachineStore } from "../../../store/machineStore";
import { useServerStore } from "../../../store/serverStore";
import { openUpgradeDialog } from "../../../store/upgradeDialogStore";
import { archiveAgentForDeletion } from "./accountDeletionApi";
import type { AccountDeletionAgentGroup } from "./accountDeletionAgentGroups";
import { AccountDeletionChecklistRow, AccountDeletionRowNote } from "./AccountDeletionChecklistRow";
import { moveAgentElsewhereHref } from "./accountDeletionMove";

/** Agent names shown in a row before "and N more". */
const NAMES_SHOWN = 5;

/** The existing Move to Another Computer dialog for an agent on the current server; a started move reads the list again. */
function MoveAgentDialog({ agent, onClose, onStarted }: { agent: Agent; onClose: () => void; onStarted: () => void }) {
  const machines = useMachineStore((state) => state.machines);
  const loadBilling = useServerStore((state) => state.loadBilling);
  const hostedAvailable = useHostedMigrationAvailable(true);
  const handleProRequired = useCallback(() => {
    onClose();
    openUpgradeDialog("agent_migration", { unprompted: true });
    void loadBilling();
  }, [loadBilling, onClose]);
  const handleStarted = useCallback(async () => {
    onClose();
    onStarted();
  }, [onClose, onStarted]);
  return (
    <AgentMigrationDialog
      agent={agent}
      machines={machines}
      sourceMachineId={agent.machineId ?? null}
      hostedAvailable={hostedAvailable}
      onClose={onClose}
      onProRequired={handleProRequired}
      onStarted={handleStarted}
    />
  );
}

type RowAgent = { id: string; name: string };

const NO_AGENTS: RowAgent[] = [];

function AgentMenuItem({ agent, testId, onChoose }: { agent: RowAgent; testId: string; onChoose: (agent: RowAgent) => void }) {
  const handleClick = useCallback(() => onChoose(agent), [agent, onChoose]);
  return (
    <DropdownMenuItem onClick={handleClick} data-testid={testId}>
      <Bot />
      <DropdownMenuItemLabel>{agent.name}</DropdownMenuItemLabel>
    </DropdownMenuItem>
  );
}

/**
 * One optional action: a button for a single agent, else a menu of them.
 * `hrefFor` makes an agent's choice a navigation (Move on another server).
 */
function AgentAction({ agents, icon, label, badge, testId, onChoose, hrefFor }: {
  agents: RowAgent[];
  icon: ReactNode;
  label: string;
  /** After the label, in the button. */
  badge?: ReactNode;
  testId: string;
  onChoose: (agent: RowAgent) => void;
  hrefFor?: (agent: RowAgent) => string;
}) {
  const navigate = useNavigate();
  const choose = useCallback((agent: RowAgent) => {
    const href = hrefFor?.(agent);
    if (href) navigate(href);
    else onChoose(agent);
  }, [hrefFor, navigate, onChoose]);
  const only = agents.length === 1 ? agents[0]! : null;
  const handleOnly = useCallback(() => { if (only) onChoose(only); }, [onChoose, only]);
  if (only) {
    const href = hrefFor?.(only);
    // A navigation to another server's page: a link, drawn as a button.
    return href ? (
      <Button variant="outline" nativeButton={false} role="link" render={<Link to={href} />} data-testid={testId}>{icon}{label}{badge}</Button>
    ) : (
      <Button type="button" variant="outline" onClick={handleOnly} data-testid={testId}>{icon}{label}{badge}</Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" variant="outline" data-testid={testId} />}>
        {icon}{label}{badge}<ChevronDown aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label={label}>
        {agents.map((agent) => <AgentMenuItem key={agent.id} agent={agent} testId={`${testId}-${agent.id}`} onChoose={choose} />)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AccountDeletionAgentRow({ group, autoMoveAgentId, onAutoMoveHandled, onChanged }: {
  group: AccountDeletionAgentGroup;
  /** An agent whose Move to Another Computer opens on arrival (`?move=`), if it is in this row. */
  autoMoveAgentId: string | null;
  onAutoMoveHandled: () => void;
  /** An agent moved or archived: read the list again. */
  onChanged: () => void;
}) {
  const { formatMessage, formatList } = useIntl();
  const { server, computer, agents, owner, handedOver, hasAssistant } = group;
  const currentServerId = useServerStore((state) => state.current?.id ?? null);
  const onCurrentServer = currentServerId === server.id;
  const plan = useServerStore((state) => (onCurrentServer ? state.billing?.plan : undefined)
    ?? state.servers.find((entry) => entry.id === server.id)?.plan);
  const moveOffered = !agentMigrationRequiresUpgrade(plan);
  const storeAgents = useAgentStore((state) => state.agents);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<RowAgent | null>(null);

  const storeAgent = useCallback(
    (agentId: string) => (onCurrentServer ? storeAgents.find((agent) => agent.id === agentId && !agent.deletedAt) ?? null : null),
    [onCurrentServer, storeAgents],
  );

  // Arrived from another server's row (`?move=`): its move is open while the
  // query names one of the person's agents here, once that agent has loaded.
  const autoMoveId = computer && autoMoveAgentId && agents.some((agent) => agent.id === autoMoveAgentId) ? autoMoveAgentId : null;
  const movingAgentId = movingId ?? autoMoveId;
  const moving: Agent | null = movingAgentId && moveOffered ? storeAgent(movingAgentId) : null;

  const closeMove = useCallback(() => {
    setMovingId(null);
    if (autoMoveId) onAutoMoveHandled();
  }, [autoMoveId, onAutoMoveHandled]);
  const closeArchive = useCallback(() => setArchiving(null), []);
  const chooseMove = useCallback((agent: RowAgent) => setMovingId(agent.id), []);
  const moveHref = useCallback((agent: RowAgent) => moveAgentElsewhereHref(server.slug, agent.id), [server.slug]);

  const handleArchive = useCallback(async () => {
    if (!archiving) return;
    try {
      await archiveAgentForDeletion(server.id, archiving.id);
    } catch (err: unknown) {
      throw new Error(archiveRequestErrorMessage(err, formatMessage) ?? formatMessage({ id: "agent.archive.failed" }));
    }
    onChanged();
  }, [archiving, server.id, formatMessage, onChanged]);

  const namesOf = (list: RowAgent[]) => {
    const shown = list.slice(0, NAMES_SHOWN).map((agent) => agent.name);
    const more = list.length - shown.length;
    return formatList(more > 0 ? [...shown, formatMessage({ id: "accountDeletion.namesMore" }, { count: more })] : shown, { type: "conjunction" });
  };

  const count = agents.length;
  const name = computer
    ? count > 0
      ? formatMessage({ id: "accountDeletion.agentsOnComputer" }, { count, computerName: computer.name })
      : computer.name
    : formatMessage({ id: "accountDeletion.agentsInServer" }, { count, serverName: server.name });
  const outcome = handedOver === 0
    ? count > 0
      ? formatMessage({ id: "accountDeletion.assistantArchived" })
      : formatMessage({ id: "accountDeletion.computerDeleted" })
    : owner
      ? formatMessage({ id: computer ? "accountDeletion.agentsToOwnerNewComputer" : "accountDeletion.agentsToOwner" }, { count: handedOver, ownerName: owner.name })
      : formatMessage({ id: computer ? "accountDeletion.agentsToNewOwnerNewComputer" : "accountDeletion.agentsToNewOwner" }, { count: handedOver, serverName: server.name });

  // Moving needs the agent in this server's store; on another server the row links there.
  const canMove = computer !== null && moveOffered;
  const movable = useMemo(
    () => (canMove ? agents.filter((agent) => !onCurrentServer || storeAgent(agent.id) !== null) : NO_AGENTS),
    [agents, canMove, onCurrentServer, storeAgent],
  );

  return (
    <AccountDeletionChecklistRow
      icon={computer ? <Monitor /> : <Bot />}
      testId={`account-deletion-agents-${group.key.replace(":", "-")}`}
      name={name}
      detail={count > 0 ? namesOf(agents) : formatMessage({ id: "accountDeletion.computerOnServer" }, { serverName: server.name })}
      outcome={outcome}
    >
      {count > 0 ? (
        <AccountDeletionRowNote>
          {formatMessage({ id: "accountDeletion.agentsStopNow" }, { count, assistant: hasAssistant && handedOver > 0 ? "yes" : "no" })}
        </AccountDeletionRowNote>
      ) : null}
      {computer && count > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-testid={`account-deletion-agent-actions-${computer.id}`}>
          <span className="text-footnote text-foreground-hint">{formatMessage({ id: "accountDeletion.optionalActions" })}</span>
          {movable.length > 0 ? (
            <AgentAction
              agents={movable}
              icon={<Monitor size={14} />}
              label={formatMessage({ id: "agent.detail.moveToAnotherComputer" })}
              // Moving is a Pro feature: the neutral tag the agent's migration section shows.
              badge={<Badge appearance="outline">{formatMessage({ id: "billing.pro" })}</Badge>}
              testId={`account-deletion-move-${computer.id}`}
              onChoose={chooseMove}
              hrefFor={onCurrentServer ? undefined : moveHref}
            />
          ) : null}
          <AgentAction
            agents={agents}
            icon={<Archive size={14} />}
            label={formatMessage({ id: "agent.archive.confirm" })}
            testId={`account-deletion-archive-${computer.id}`}
            onChoose={setArchiving}
          />
        </div>
      ) : null}
      {moving ? <MoveAgentDialog agent={moving} onClose={closeMove} onStarted={onChanged} /> : null}
      {archiving ? (
        <ConfirmDialog
          title={formatMessage({ id: "agent.archive.title" }, { name: archiving.name })}
          maxWidthClass="max-w-md"
          message={formatMessage({ id: "agent.archive.description" })}
          chromeLocale="active"
          confirmLabel={formatMessage({ id: "agent.archive.confirm" })}
          loadingLabel={formatMessage({ id: "agent.detail.deleting" })}
          confirmIcon={<Archive size={14} />}
          confirmVariant="warning"
          onConfirm={handleArchive}
          onClose={closeArchive}
        />
      ) : null}
    </AccountDeletionChecklistRow>
  );
}
