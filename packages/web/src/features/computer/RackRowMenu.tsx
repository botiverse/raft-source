import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { EllipsisVertical, Plus, RotateCcw, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, PanelAction } from "@botiverse/raft-ui";
import type { Agent } from "../../store/agentStore";
import type { Machine } from "../../store/machineStore";
import Tooltip from "../../components/ui/Tooltip";
import { CreateAgentDialog } from "../../components/agent/DeferredCreateAgentDialog";
import { trackAgentCreateOpened } from "../../analytics/journey";
import type { UpgradeCard, RestartState } from "./computersRackTypes";
import { DeleteComputerDialog } from "./DeleteComputerDialog";

/**
 * The row's … menu: the Computer page's own actions for this computer
 * (Create agent with this computer preselected, as the Computer page's agent
 * list does, while it is online: CreateAgentDialog would otherwise quietly
 * preselect another computer; Restart while it is online; Delete Computer, as on the Computer
 * page: DeleteComputerDialog). Absent when the viewer may do none of them.
 */
export function RackRowMenu({ machine, agents, canManage, upgrade, restartState }: {
  machine: Machine;
  agents: readonly Agent[];
  canManage: boolean;
  upgrade: UpgradeCard;
  restartState: RestartState;
}) {
  const { formatMessage } = useIntl();
  const { cardState } = upgrade;
  const { progress, restart } = restartState;
  const [showDelete, setShowDelete] = useState(false);
  const openDelete = useCallback(() => setShowDelete(true), []);
  const closeDelete = useCallback(() => setShowDelete(false), []);
  const [showCreate, setShowCreate] = useState(false);
  const openCreate = useCallback(() => {
    trackAgentCreateOpened("computer_rack");
    setShowCreate(true);
  }, []);
  const closeCreate = useCallback(() => setShowCreate(false), []);
  if (!canManage) return <div className="size-8 shrink-0" aria-hidden="true" />;
  const canRestart = machine.isComputer === true && machine.status === "online" && cardState.kind !== "upgrading" && !progress;
  const menuLabel = formatMessage({ id: "agent.detail.moreActions" });
  return (
    <>
      <DropdownMenu>
        <Tooltip content={menuLabel}>
          <DropdownMenuTrigger
            render={<PanelAction aria-label={menuLabel} data-testid={`rack-row-menu-${machine.id}`} />}
          >
            <EllipsisVertical />
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent side="bottom" align="end" sideOffset={4} aria-label={menuLabel}>
          {machine.status === "online" && (
            <DropdownMenuItem onClick={openCreate} data-testid={`rack-row-create-agent-${machine.id}`}>
              <Plus />
              {formatMessage({ id: "machine.detail.create" })}
            </DropdownMenuItem>
          )}
          {canRestart && (
            <DropdownMenuItem onClick={restart} data-testid={`rack-row-restart-${machine.id}`}>
              <RotateCcw />
              {formatMessage({ id: "machine.detail.restart" })}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={openDelete} data-testid={`rack-row-delete-${machine.id}`}>
            <Trash2 />
            {formatMessage({ id: "machine.detail.deleteComputer" })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {showCreate && <CreateAgentDialog defaultMachineId={machine.id} onClose={closeCreate} />}
      {showDelete && <DeleteComputerDialog machine={machine} agents={agents} onClose={closeDelete} />}
    </>
  );
}
