import { useCallback } from "react";
import type { Agent } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { useProfileStore } from "../../store/profileStore";
import { useServerStore } from "../../store/serverStore";
import { openUpgradeDialog } from "../../store/upgradeDialogStore";
import { AgentMigrationDialog } from "../../components/agentMigration/AgentMigrationDialog";
import { useHostedMigrationAvailable } from "../../components/agentMigration/useHostedMigrationAvailable";

/**
 * The existing Move to Another Computer dialog, opened by a drop with the
 * row's computer preselected. A started move opens the agent's profile, where
 * its progress shows (AgentMigrationSection).
 */
export function RackMoveDialog({ agent, targetId, onClose }: { agent: Agent; targetId: string; onClose: () => void }) {
  const machines = useMachineStore((s) => s.machines);
  const loadBilling = useServerStore((s) => s.loadBilling);
  const hostedAvailable = useHostedMigrationAvailable(true);
  const handleProRequired = useCallback(() => {
    onClose();
    openUpgradeDialog("agent_migration", { unprompted: true });
    void loadBilling();
  }, [loadBilling, onClose]);
  const handleStarted = useCallback(async () => {
    onClose();
    useProfileStore.getState().openProfile("agent", agent.id);
  }, [agent.id, onClose]);
  return (
    <AgentMigrationDialog
      agent={agent}
      machines={machines}
      sourceMachineId={agent.machineId ?? null}
      hostedAvailable={hostedAvailable}
      initialTarget={targetId}
      onClose={onClose}
      onProRequired={handleProRequired}
      onStarted={handleStarted}
    />
  );
}
