import { useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { isExternalAgentRuntime } from "@botiverse/raft-shared";
import ConfirmDialog from "../../components/ConfirmDialog";
import ResetAgentDialog from "../../components/agent/ResetAgentDialog";
import { showToast } from "../../components/toastBridge";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import type { Agent } from "../../store/agentStore";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import { useProfileStore } from "../../store/profileStore";
import { useThreadStore } from "../../store/threadStore";
import { agentRuntimePermissions } from "../../utils/agentVisibility";
import { isMachineOfflineError, startRefusalText } from "../../utils/machineOfflineError";
import { lazyDialog } from "../../boot/deferredUi";
import { canMessageEntry } from "./memberActionsContext";
import type { MemberActions } from "./memberActionsContext";
import type { MemberEntry } from "./membersPageModel";

// The agent's Edit runtime config dialog (the profile's), loaded when Edit agent first opens it.
const AgentRuntimeConfigEditor = lazyDialog(() => import("../agent/AgentRuntimeConfigEditor").then((module) => ({ default: module.AgentRuntimeConfigEditor })));

/**
 * The Members page's member actions (MemberActionsContext) and the dialogs
 * they open: Stop's confirmation, the Restart / reset chooser and Edit
 * agent's Edit runtime config dialog, the same ones the agent's profile
 * opens, with its words.
 */
export function useMemberActions(): { actions: MemberActions; dialogs: ReactNode } {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const { role, capabilities } = useServerPermissions();
  const userId = useAuthStore((s) => s.user?.id);
  const roleRef = useRef(role);
  roleRef.current = role;
  const [stopTarget, setStopTarget] = useState<Agent | null>(null);
  const [resetTarget, setResetTarget] = useState<Agent | null>(null);
  // Edit agent: its id, the agent read live from the store (a save updates it there).
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const editTarget = useAgentStore((s) => (editTargetId ? s.agents.find((a) => a.id === editTargetId) ?? null : null));
  const requestEdit = useCallback((agent: Agent) => setEditTargetId(agent.id), []);
  const closeEdit = useCallback(() => setEditTargetId(null), []);

  const openDm = useCallback((entry: MemberEntry) => {
    if (!canMessageEntry(entry, roleRef.current)) return;
    useProfileStore.getState().closeProfile();
    useThreadStore.getState().closeThread();
    const { dmChannels, openDM, openUserDM } = useChannelStore.getState();
    const peerType = entry.kind === "agent" ? "agent" : "user";
    const existing = dmChannels.find((dm) => dm.peerType === peerType && dm.peerId === entry.id);
    if (existing) {
      nav.toDm(existing.id);
      return;
    }
    void (entry.kind === "agent" ? openDM(entry.id) : openUserDM(entry.id)).then((dm) => {
      if (dm) nav.toDm(dm.id);
    });
  }, [nav]);
  const startAgent = useCallback((agent: Agent) => {
    // A machine_offline refusal already updated the store (agentStore.startAgent); any other one says why.
    useAgentStore.getState().startAgent(agent.id).catch((error: unknown) => {
      if (!isMachineOfflineError(error)) showToast({ title: startRefusalText(error, formatMessage), type: "error" });
    });
  }, [formatMessage]);
  const actions = useMemo<MemberActions>(() => ({
    viewerRole: role,
    openDm,
    startAgent,
    requestStop: setStopTarget,
    requestReset: setResetTarget,
    requestEdit,
  }), [openDm, requestEdit, role, startAgent]);

  const closeStop = useCallback(() => setStopTarget(null), []);
  const closeReset = useCallback(() => setResetTarget(null), []);
  const confirmStop = useCallback(async () => {
    if (stopTarget) await useAgentStore.getState().stopAgent(stopTarget.id);
  }, [stopTarget]);
  const resetPermissions = resetTarget
    ? agentRuntimePermissions(resetTarget, userId, capabilities, {
      isExternalAgent: resetTarget.external === true || isExternalAgentRuntime(resetTarget.runtime),
    })
    : null;
  const dialogs = (
    <>
      {stopTarget ? (
        <ConfirmDialog
          title={formatMessage({ id: "agent.detail.stopAgentTitle" })}
          message={formatMessage({ id: "agent.detail.stopAgentConfirmMessage" }, { name: stopTarget.displayName || stopTarget.name })}
          confirmLabel={formatMessage({ id: "agent.detail.stopAgentConfirm" })}
          loadingLabel={formatMessage({ id: "agent.detail.stopping" })}
          confirmVariant="warning"
          chromeLocale="active"
          onConfirm={confirmStop}
          onClose={closeStop}
        />
      ) : null}
      {resetTarget && resetPermissions?.canControlAgentRuntime ? (
        <ResetAgentDialog
          agentId={resetTarget.id}
          agentName={resetTarget.displayName || resetTarget.name}
          canFullReset={resetPermissions.canResetAgentWorkspace}
          memberRuntimeOnly={role === "member"}
          onClose={closeReset}
        />
      ) : null}
      {editTarget ? (
        <AgentRuntimeConfigEditor key={editTarget.id} agent={editTarget} onClose={closeEdit} />
      ) : null}
    </>
  );
  return { actions, dialogs };
}
