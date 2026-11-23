import { Button } from "@botiverse/raft-ui";
import { useCallback, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { getRuntimeDisplayName, getRuntimeInfo, runtimeAvailabilitySuffix } from "@botiverse/raft-shared";
import type { RuntimeSelectionOption } from "@botiverse/raft-shared";
import { applyRuntimeFormV2Change, initialRuntimeFormV2Values, runtimeFormV2Submission, validateRuntimeFormV2 } from "@botiverse/raft-runtime-form";
import type { RuntimeFormV2Value, RuntimeFormV2Values } from "@botiverse/raft-runtime-form";
import ConfirmDialog from "../../components/ConfirmDialog";
import Banner from "../../components/ui/Banner";
import RuntimeConfigFields from "../../components/agent/RuntimeConfigFields";
import { useRuntimeShowAllAction } from "../../components/agent/useRuntimeShowAllAction";
import { groupRuntimePickerRows } from "../../components/agent/runtimePickerOptions";
import { runtimePickerGuidance } from "../../utils/runtimeCapabilityHint";
import type { RuntimePickerRow } from "../../components/agent/runtimePickerOptions";
import RuntimeSignInNotice from "../../components/machine/RuntimeSignInNotice";
import { DialogCardFooter, DialogCommit } from "../../components/ui/NarrowDialog";
import { useExistingAgentRuntimeOptions as useExistingAgentRuntimeSelectionOptions } from "../../hooks/useRuntimeSelectionCatalog";
import { RUNTIME_FORM_V2_UNAVAILABLE, useRuntimeFormV2 } from "../../hooks/useRuntimeFormV2";
import type { RuntimeFormV2State } from "../../hooks/useRuntimeFormV2";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAgentStore, useAgentDisplayState } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { useAuthStore } from "../../store/authStore";
import { resolveAgentMachineRow } from "../../utils/agentMachineRow";
import { hydrateRuntimeConfigForm } from "../../utils/runtimeConfigForm";
import { canViewMachineRuntimeAccountUsage } from "../../utils/machineRuntimeUsageVisibility";
import { formatRuntimeAvailabilitySuffix, formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { AgentModelLimitsWarning } from "./AgentModelLimitsWarning";
import { RuntimeConfigEditorFrame } from "./RuntimeConfigEditorFrame";
import { announceRuntimeConfigApply } from "./runtimeConfigApplyNotice";

const RUNTIME_FORM_V2_LOADING: RuntimeFormV2State = { status: "loading" };

type SwitchConfirm = { from: string; to: string; onConfirm: () => Promise<void> };

/**
 * An agent's Edit runtime config dialog: the runtime picker and the
 * server-described runtime form (protocol v2/v3) in RuntimeConfigEditorFrame,
 * with its save, its toasts (announceRuntimeConfigApply) and, for a stopped
 * agent's runtime switch, its confirmation. Mounted only while open: it seeds
 * its draft from the agent when it mounts and calls `onClose` when it is done
 * (cancel, saved, or the switch confirmation closed). Opened from the agent's
 * profile (its Runtime config pencil) and from the Members page (Edit agent).
 *
 * The caller decides who may open it: the profile's rule (owner/admin's
 * editAgents or the agent's creator, never an external agent).
 * `runtimeOptions`:
 * the agent's runtime rows (`/agents/:id/runtime-options`) when the caller
 * already holds them (the profile), so the editor opens on them instead of
 * asking again; without it (Members) it reads them itself.
 */
export function AgentRuntimeConfigEditor({ agent, runtimeOptions, onClose }: {
  agent: Agent;
  runtimeOptions?: { options: RuntimeSelectionOption[]; loading: boolean };
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const currentServerId = useServerStore((s) => s.current?.id);
  const displayState = useAgentDisplayState(agent.id, agent);
  const isActive = displayState.isOnline || agent.status === "active";
  const machines = useMachineStore((s) => s.machines);
  const machineLoadStatus = useMachineStore((s) => s.loadStatus);
  const agentMachineRow = resolveAgentMachineRow(agent.machineId, machines, machineLoadStatus);
  const agentMachine = agentMachineRow.kind === "machine" ? agentMachineRow.machine : null;
  const { capabilities } = useServerPermissions();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  // The agent's runtime as the profile reads it; the editor starts on it.
  const { envVars: agentEnvVars, model: agentModel, reasoningEffort: agentReasoningEffort, runtime: agentRuntime, runtimeConfig: agentRuntimeConfig } = agent;
  const currentRuntime = useMemo(() => hydrateRuntimeConfigForm({
    envVars: agentEnvVars,
    model: agentModel,
    reasoningEffort: agentReasoningEffort,
    runtime: agentRuntime,
    runtimeConfig: agentRuntimeConfig,
  }).runtime, [agentEnvVars, agentModel, agentReasoningEffort, agentRuntime, agentRuntimeConfig]);
  // The one thing drafted here besides the v2 form's values: which runtime it edits.
  const [draftRuntime, setDraftRuntime] = useState<string>(currentRuntime);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [switchConfirm, setSwitchConfirm] = useState<SwitchConfirm | null>(null);

  const availableRuntimes = agentMachine?.runtimes || [];
  const ownRuntimeOptions = useExistingAgentRuntimeSelectionOptions(agent.id, availableRuntimes, !runtimeOptions);
  const { options: runtimeAdmissionOptions, loading: runtimeAdmissionLoading } = runtimeOptions ?? ownRuntimeOptions;
  const draftRuntimeAdmission = runtimeAdmissionOptions.find((option) => option.runtimeId === draftRuntime);
  // Protocol v2 edit — the only runtime editor: the same server-described form
  // as create, pre-filled by the server with this agent's values (writeOnly
  // fields blank = keep). Switching to another runtime loads that runtime's
  // create form instead (nothing to prefill, no secret to keep) and saves it as
  // a runtime switch (task #8). A leftover saved provider connection binding
  // opens with nothing selected and the agent-local provider fields shown
  // (useRuntimeFormV2 drops connection options and values).
  // A runtime whose admission row has no v2 marker, or a form needing client
  // capabilities this build lacks, shows the form-unavailable notice and
  // cannot be saved; a failed load shows it with a retry.
  const draftRuntimeHasFormV2 = draftRuntimeAdmission?.runtimeFormV2?.protocolVersion === 2;
  const v2RuntimeSwitched = draftRuntime !== agent.runtime;
  const runtimeFormV2Loaded = useRuntimeFormV2(
    draftRuntimeHasFormV2 ? agent.machineId : null,
    draftRuntimeHasFormV2 ? draftRuntime : null,
    v2RuntimeSwitched ? undefined : agent.id,
  );
  const runtimeFormV2Edit = draftRuntimeHasFormV2
    ? runtimeFormV2Loaded
    // Until the admission rows arrive nothing says the runtime lacks a form.
    : runtimeAdmissionLoading ? RUNTIME_FORM_V2_LOADING : RUNTIME_FORM_V2_UNAVAILABLE;
  const [v2EditDraft, setV2EditDraft] = useState<RuntimeFormV2Values | null>(null);
  const [v2EditServerErrors, setV2EditServerErrors] = useState<Record<string, string>>({});
  const v2EditInitial = useMemo(
    () => runtimeFormV2Edit.status === "ready" ? initialRuntimeFormV2Values(runtimeFormV2Edit.form, runtimeFormV2Edit.sources) : null,
    [runtimeFormV2Edit],
  );
  const v2EditValues = v2EditDraft ?? v2EditInitial;
  // A runtime switch is a change by itself, even with the new form's defaults untouched.
  const v2EditChanged = v2RuntimeSwitched
    || Boolean(v2EditDraft && v2EditInitial && JSON.stringify(v2EditDraft) !== JSON.stringify(v2EditInitial));
  // A required field whose option source is unavailable cannot be saved (option_source.status),
  // nor a blank secret whose bound fields changed (writeOnlyKeepRequiresUnchanged),
  // nor a required field this build cannot render (it says to update Raft).
  const v2EditBlocked = runtimeFormV2Edit.status === "ready" && v2EditValues !== null
    && Object.values(validateRuntimeFormV2(runtimeFormV2Edit.form, runtimeFormV2Edit.sources, v2EditValues, { editing: !v2RuntimeSwitched }))
      .some((code) => code === "source_unavailable" || code === "secret_reentry_required" || code === "unsupported_required");
  // The runtime must still be selectable here: its Computer capability can go away mid-edit.
  const draftRuntimeCanSelect = draftRuntimeAdmission?.canSelectInThisContext === true;
  const saveDisabled = saving || !draftRuntimeCanSelect || runtimeFormV2Edit.status !== "ready" || !v2EditChanged || v2EditBlocked;
  const changeV2EditValue = useCallback((key: string, value: RuntimeFormV2Value) => {
    if (runtimeFormV2Edit.status !== "ready" || !v2EditValues) return;
    setV2EditServerErrors({});
    setV2EditDraft(applyRuntimeFormV2Change(runtimeFormV2Edit.form, runtimeFormV2Edit.sources, v2EditValues, key, value));
  }, [runtimeFormV2Edit, v2EditValues]);

  const canViewRuntimeAccountUsage = canViewMachineRuntimeAccountUsage(agentMachine, currentUserId, capabilities);
  // Which runtimes the agent may switch to is the server's rows (a deprecated
  // runtime it offers again is one); Experimental is the server's catalog; the
  // bundled catalog only names them.
  const runtimePickerRows = runtimeAdmissionOptions.flatMap((option): RuntimePickerRow[] => {
    const runtimeInfo = getRuntimeInfo(option.runtimeId);
    const deprecatedHere = option.admissionReason === "deprecated";
    return runtimeInfo?.supported
      ? [{
          value: runtimeInfo.id,
          label: formatRuntimeLabelWithStatus(runtimeInfo.id, formatMessage, deprecatedHere),
          availabilitySuffix: formatRuntimeAvailabilitySuffix(runtimeAvailabilitySuffix(runtimeInfo, availableRuntimes), formatMessage),
          ...runtimePickerGuidance(runtimeInfo.id, deprecatedHere, formatMessage),
          disabled: !option.canSelectInThisContext,
          capabilityStatus: option.capabilityStatus,
          selectable: option.canSelectInThisContext,
          // The agent's runtime is always listed, first, even when deprecated.
          current: runtimeInfo.id === currentRuntime,
        }]
      : [];
  });
  const [showAllRuntimes, setShowAllRuntimes] = useState(false);
  const runtimePicker = groupRuntimePickerRows(runtimePickerRows, {
    showAll: showAllRuntimes,
    selectedValue: draftRuntime,
    formatMessage,
  });
  const runtimeListAction = useRuntimeShowAllAction(runtimePicker.canToggle, showAllRuntimes, setShowAllRuntimes);
  const runtimeBelowDescription = (
    // Signed out is said, never enforced: Save stays as it is.
    <RuntimeSignInNotice
      serverId={currentServerId}
      machineId={agentMachine?.id}
      machineName={agentMachine?.name ?? formatMessage({ id: "machine.runtimeAuth.thisComputer" })}
      runtimeId={draftRuntime}
      enabled={canViewRuntimeAccountUsage}
    />
  );

  const changeDraftRuntime = useCallback((id: string) => {
    setDraftRuntime(id);
    // The v2 draft belongs to the form it was made in.
    setV2EditDraft(null);
    setV2EditServerErrors({});
  }, []);

  const runtimeFormV2EditProps = useMemo(() => ({
    state: runtimeFormV2Edit,
    values: v2EditValues,
    onChange: changeV2EditValue,
    serverErrors: v2EditServerErrors,
    editing: !v2RuntimeSwitched,
  }), [changeV2EditValue, runtimeFormV2Edit, v2EditServerErrors, v2EditValues, v2RuntimeSwitched]);

  const save = async () => {
    setSaveError("");
    if (runtimeFormV2Edit.status !== "ready" || !v2EditValues) return;
    if (!v2EditChanged) {
      onClose();
      return;
    }
    const { form, sources } = runtimeFormV2Edit;
    // Field errors are already shown beside the fields; nothing to send yet.
    if (Object.keys(validateRuntimeFormV2(form, sources, v2EditValues, { editing: !v2RuntimeSwitched })).length > 0) return;
    const fields = {
      // The rendered form's protocol (2, or 3 for runtime_form.v3); same formValues.
      formDefinitionRef: { protocolVersion: form.protocolVersion, runtimeId: draftRuntime },
      formValues: runtimeFormV2Submission(form, v2EditValues, sources),
    };
    const submit = async (restartMode?: "restart" | "session") => {
      try {
        const saved = await updateAgent(agent.id, fields, restartMode ? { restartMode } : undefined);
        setV2EditDraft(null);
        return { configApply: saved.configApply, configApplyNewSession: saved.configApplyNewSession };
      } catch (err: unknown) {
        const data = (err as { response?: { data?: { error?: string; issues?: Array<{ pointer?: string }> } } }).response?.data;
        const fieldErrors: Record<string, string> = {};
        for (const issue of data?.issues ?? []) {
          const key = issue.pointer?.startsWith("/formValues/") ? issue.pointer.slice("/formValues/".length) : "";
          if (key) fieldErrors[key] = data?.error ?? "";
        }
        setV2EditServerErrors(fieldErrors);
        setSaveError(data?.error ?? formatMessage({ id: "agent.detail.runtimeConfigInvalid" }));
        throw err;
      }
    };
    // A stopped agent's runtime switch is confirmed: it starts on a new session.
    // The editor gives way to the confirmation, and closes with it.
    if (v2RuntimeSwitched && !isActive) {
      setSwitchConfirm({
        from: getRuntimeDisplayName(agent.runtime),
        to: getRuntimeDisplayName(draftRuntime),
        onConfirm: async () => {
          await submit("session");
        },
      });
      return;
    }
    // Reconciler step 11c + #proj-runtime:#80: saved runtime config changes
    // apply immediately (interrupting & restarting with preserved context if
    // mid-turn) — show plain confirmation only.
    setSaving(true);
    try {
      const { configApply, configApplyNewSession } = await submit();
      const newSession = configApplyNewSession ?? (v2RuntimeSwitched || (draftRuntime === "codex" && v2EditValues.model !== v2EditInitial?.model));
      onClose();
      announceRuntimeConfigApply({
        configApply,
        agentActive: isActive,
        agentName: agent.displayName || agent.name,
        newSession,
        formatMessage,
      });
    } catch {
      // Shown beside the fields and in the banner.
    } finally {
      setSaving(false);
    }
  };

  if (switchConfirm) {
    return (
      <ConfirmDialog
        title={formatMessage({ id: "agent.detail.switchRuntimeConfig" })}
        message={formatMessage({ id: "agent.detail.switchRuntimeInactiveMessage" }, { from: switchConfirm.from, to: switchConfirm.to })}
        confirmLabel={formatMessage({ id: "agent.detail.saveRuntimeChange" })}
        loadingLabel={formatMessage({ id: "agent.detail.applying" })}
        confirmVariant="warning"
        chromeLocale="active"
        onConfirm={switchConfirm.onConfirm}
        onClose={onClose}
        layer={1}
      />
    );
  }

  return (
    <RuntimeConfigEditorFrame
      title={formatMessage({ id: "agent.detail.editRuntimeConfig" })}
      onClose={onClose}
      surfaceRef={surfaceRef}
    >
      <form
        className="stack-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <RuntimeConfigFields
          runtime={draftRuntime}
          onRuntimeChange={changeDraftRuntime}
          runtimeOptions={runtimePicker.options}
          runtimeBelowDescription={runtimeBelowDescription}
          runtimeListAction={runtimeListAction}
          upgradeServerId={currentServerId}
          upgradeMachineId={agentMachine?.id}
          runtimeFormV2={runtimeFormV2EditProps}
        />
        {agent.modelLimits?.defaultsReported && draftRuntime === "builtin" && !v2EditChanged && <AgentModelLimitsWarning />}

        {saveError ? (
          <Banner intent="warning" density="sm">
            {saveError}
          </Banner>
        ) : null}

        <DialogCardFooter>
          <Button variant="ghost" size="lg"
            type="button"
            onClick={onClose}
            disabled={saving}
          >
            {formatMessage({ id: "common.confirm.cancel" })}
          </Button>
          <DialogCommit>
            {(inHead) => (
              <Button variant="primary" size={inHead ? "md" : "lg"}
                type="submit"
                disabled={saveDisabled}
              >
                {formatMessage({ id: "agent.detail.saveRuntimeConfig" })}
              </Button>
            )}
          </DialogCommit>
        </DialogCardFooter>
      </form>
    </RuntimeConfigEditorFrame>
  );
}
