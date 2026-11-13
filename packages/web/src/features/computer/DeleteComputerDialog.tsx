/**
 * Delete Computer, from the Computer page and the rack row's … menu.
 *
 * Someone else's computer (an admin removing it, or a raw daemon): as before,
 * DELETE /servers/:id/machines/:machineId, which the server refuses while any
 * agent is on it, so while the list shows one the dialog only says so.
 *
 * The person's own computer (#triage:d10ace06, Tenny; server #12858): a
 * Computer whose machine row is theirs (`userId`), the same test the server's
 * revoke uses. Not `computerAttachedByCurrentUser`: for a legacy machine an
 * admin adopted, the attacher and the row's owner differ, and the server
 * then takes the admin path (no 409, everything stays bound, DELETE refuses).
 * only their own agents (ones they created, or their personal assistant) have
 * to go first, as DELETE still refuses them. Other people's agents, which only
 * their owners can move, don't: confirming revokes the Computer's key first
 * (revoke-computer-key), and while such agents are on it the server answers
 * 409 with them (its own list: another member's personal assistant isn't in
 * the viewer's). The dialog then lists them, with Notify Owner to Move It
 * (once a day, shared with Delete Account) and Force Unbind and Delete, which
 * asks again (ForceUnbindAgentsDialog) and sends `forceAgentIds`, exactly the
 * agents shown. A 409 on that means more arrived and nothing happened: the
 * confirm shows the newer list and says so. Once the key is revoked the
 * computer is offline, and the same DELETE takes it off the list. Should that
 * DELETE fail, the dialog says so in our words (the key is revoked and it is
 * offline, why it is still listed, that trying again is safe); a retry finds
 * the key already revoked and goes on to the DELETE.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";

import ConfirmDialog from "../../components/ConfirmDialog";
import { useAuthStore } from "../../store/authStore";
import type { Agent } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import type { Machine } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { getApiErrorResponse } from "../../utils/apiErrorResponse";
import { ForceUnbindAgentsDialog } from "./ForceUnbindAgentsDialog";
import { isOwnAgent, notifyComputerAgentOwners, revokeComputerKey } from "./othersAgentsApi";
import type { OthersAgent } from "./othersAgentsApi";
import { OthersAgentsOnComputerDialog } from "./OthersAgentsOnComputerDialog";
import { useAgentOwnerNotify } from "./useAgentOwnerNotify";

type Phase =
  | { kind: "confirm" }
  | { kind: "others"; agents: OthersAgent[] }
  | { kind: "force"; agents: OthersAgent[] };

/** Why DELETE refused (machineService.ts MachineDeleteConflictError), for `machine.othersAgents.revokedNotRemoved`. */
function deleteRefusalReason(err: unknown): "agents" | "migration" | "profile" | "other" {
  switch (getApiErrorResponse(err)?.code) {
    case "MACHINE_HAS_ASSIGNED_AGENTS": return "agents";
    case "MACHINE_HAS_ACTIVE_MIGRATION": return "migration";
    case "MACHINE_HAS_ACTIVE_RUNTIME_PROFILE": return "profile";
    default: return "other";
  }
}

/** The "cannot delete" notice has nothing to confirm; OK only closes it. */
function acknowledgeCannotDelete() {}

export function DeleteComputerDialog({ machine, agents, onClose }: {
  machine: Machine;
  /** The live agents on it the viewer can see. */
  agents: readonly Agent[];
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const deleteMachine = useMachineStore((s) => s.deleteMachine);
  const attachedByMe = machine.isComputer === true && !!currentUserId && machine.userId === currentUserId;
  const holding = attachedByMe ? agents.filter((agent) => isOwnAgent(agent, currentUserId)) : agents;
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  const finished = useRef(false);
  // Its key was revoked from this dialog: a failed DELETE leaves it offline but listed.
  const revoked = useRef(false);

  const sendNotify = useCallback((agentIds: string[]) => {
    if (!serverId) return Promise.reject(new Error("No server selected"));
    return notifyComputerAgentOwners(serverId, machine.id, agentIds);
  }, [machine.id, serverId]);
  const { state: notifyState, notify } = useAgentOwnerNotify(sendNotify);

  /** Deletes it; the others' agents still on it when the server refused (nothing happened). */
  const remove = useCallback(async (forceAgentIds: readonly string[]): Promise<OthersAgent[] | null> => {
    if (attachedByMe) {
      if (!serverId) throw new Error("No server selected");
      const result = await revokeComputerKey(serverId, machine.id, forceAgentIds);
      if (result.kind === "others_agents") return result.agents;
      revoked.current = true;
    }
    try {
      await deleteMachine(machine.id);
    } catch (err) {
      if (!revoked.current) throw err;
      throw new Error(formatMessage({ id: "machine.othersAgents.revokedNotRemoved" }, { reason: deleteRefusalReason(err) }));
    }
    return null;
  }, [attachedByMe, deleteMachine, formatMessage, machine.id, serverId]);

  const finish = useCallback(() => {
    finished.current = true;
    onClose();
  }, [onClose]);

  const confirmDelete = useCallback(async () => {
    const others = await remove([]);
    if (others) setPhase({ kind: "others", agents: others });
    else finish();
  }, [finish, remove]);

  const forcing = phase.kind === "force" ? phase.agents : null;
  const confirmForce = useCallback(async () => {
    if (!forcing) return;
    const others = await remove(forcing.map((agent) => agent.id));
    if (!others) return finish();
    setPhase({ kind: "force", agents: others });
    throw new Error(formatMessage({ id: "machine.othersAgents.forceConflict" }));
  }, [finish, forcing, formatMessage, remove]);
  // Cancel goes back to the list; after the delete it is already closed.
  const backToList = useCallback(() => {
    if (!finished.current) setPhase((current) => (current.kind === "force" ? { kind: "others", agents: current.agents } : current));
  }, []);
  const openForce = useCallback(() => {
    setPhase((current) => (current.kind === "others" ? { kind: "force", agents: current.agents } : current));
  }, []);
  const forceList = useMemo(
    () => forcing?.map((agent) => ({ id: agent.id, name: agent.name, owner: agent.owner, computer: { id: machine.id, name: machine.name } })) ?? [],
    [forcing, machine.id, machine.name],
  );

  if (holding.length > 0) {
    return (
      <ConfirmDialog
        title={formatMessage({ id: "machine.detail.cannotDeleteComputer" })}
        message={formatMessage({ id: "machine.detail.cannotDeleteComputerMessage" }, { count: holding.length })}
        confirmLabel={formatMessage({ id: "common.announcement.ok" })}
        confirmVariant="outline"
        hideCancel
        onConfirm={acknowledgeCannotDelete}
        onClose={onClose}
      />
    );
  }
  if (phase.kind === "others") {
    return (
      <OthersAgentsOnComputerDialog
        agents={phase.agents}
        notifyState={notifyState}
        onNotify={notify}
        onForceUnbind={openForce}
        onClose={onClose}
      />
    );
  }
  if (phase.kind === "force") {
    return (
      <ForceUnbindAgentsDialog
        agents={forceList}
        confirmLabel={formatMessage({ id: "machine.othersAgents.forceUnbindAndDelete" })}
        onConfirm={confirmForce}
        onClose={backToList}
      />
    );
  }
  return (
    <ConfirmDialog
      title={formatMessage({ id: "machine.detail.deleteComputer" })}
      message={formatMessage({ id: "machine.detail.deleteComputerMessage" }, { name: machine.name })}
      confirmLabel={formatMessage({ id: "machine.detail.deleteComputer" })}
      loadingLabel={formatMessage({ id: "machine.detail.deleting" })}
      closeOnConfirm={false}
      onConfirm={confirmDelete}
      onClose={onClose}
    />
  );
}
