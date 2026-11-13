import { Button, ListRow, ListRowBody, ListRowGroup, ListRowTitle, Select, SelectContent, SelectIcon, SelectList, SelectTrigger, SelectValue } from "@botiverse/raft-ui";
import { useCallback, useState, useEffect, useEffectEvent, useId, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Bot } from "lucide-react";
import { useServerStore } from "../../../store/serverStore";
import { isAgentInMemberLists, useAgentStore } from "../../../store/agentStore";
import { useServerPermissions } from "../../../hooks/useServerPermissions";
import Banner from "../../../components/ui/Banner";
import api from "../../../api/client";
import { useIntl } from "react-intl";
import { bumpServerSetupRevision } from "../../../components/onboarding/serverSetupProjection";
import SectionHeader from "../../../components/ui/SectionHeader";
import { ImmediateRowSwitch, ImmediateSaveStatus, apiErrorText, useImmediateSave } from "../../../components/settings/ImmediateSetting";
import type { SelectOption } from "../shared/selectOptions";
import { renderSelectItems } from "../shared/renderSelectItems";

export function OnboardingAgentSection() {
  const { formatMessage } = useIntl();
  const navigate = useNavigate();
  const current = useServerStore((s) => s.current);
  const loadServerSettings = useServerStore((s) => s.loadSettings);
  const allAgents = useAgentStore((s) => s.agents);
  // The server's greeter is one of its member agents: never a personal
  // assistant (anyone's, the viewer's own included) or a removed App Bot.
  const agents = useMemo(() => allAgents.filter(isAgentInMemberLists), [allAgents]);
  const { capabilities, isAdminOrOwner } = useServerPermissions();

  const greetingIdPrefix = useId();
  const agentLabelId = useId();
  const [onboardingAgentId, setOnboardingAgentId] = useState("");
  const [agentAllChannelGreetingEnabled, setAgentAllChannelGreetingEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // The onboarding agent and the greeting stand alone: each applies when it is
  // picked (Raft DS › Forms, "Settings that apply at once").
  const agentSave = useImmediateSave();
  const greetingSave = useImmediateSave();
  const [setupProjection, setSetupProjection] = useState<{
    surface: "none" | "computer_runtime" | "create_agent" | "complete" | "retry";
    phase: "not_started" | "in_progress" | "deferred" | "complete" | null;
  } | null>(null);
  const [reopeningSetup, setReopeningSetup] = useState(false);

  const serverId = current?.id;
  const serverSlug = current?.slug;
  const canManageLinks = capabilities.editServerSettings;
  const onboardingAgentOptions = useMemo<SelectOption[]>(() => [
    { value: "", label: formatMessage({ id: "settings.onboarding.disabledOption" }) },
    ...agents.map((agent) => ({
      value: agent.id,
      label: `@${agent.name}${agent.displayName ? ` (${agent.displayName})` : ""}`,
    })),
  ], [agents, formatMessage]);

  // Read at failure time so a locale switch does not refetch the settings.
  const formatLoadError = useEffectEvent(() => formatMessage({ id: "settings.onboarding.failedLoad" }));

  // Async-loader: load onboarding-settings on server change (keyed on the
  // server id, not the whole `current` store object, so unrelated server-store
  // churn does not refetch). Same FP family as PR #2530 useChannelMembers /
  // InviteAcceptPage / AgentSkills loaders.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!serverId || !canManageLinks) return;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setLoading(true);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setError("");
    void Promise.all([
      loadServerSettings(),
      api.get(`/servers/${serverId}/setup-projection`).catch(() => null),
    ])
      .then(([settings, projectionResponse]) => {
        if (!settings) throw new Error("Server settings unavailable");
        const data = settings.onboardSettings;
        const nextOnboardingAgentId = data.onboardingAgentId || "";
        const nextAgentAllChannelGreetingEnabled = data.agentAllChannelGreetingEnabled !== false;
        setOnboardingAgentId(nextOnboardingAgentId);
        setAgentAllChannelGreetingEnabled(nextAgentAllChannelGreetingEnabled);
        setSetupProjection(projectionResponse?.data ?? null);
      })
      .catch(() => {
        setError(formatLoadError());
      })
      .finally(() => {
        setLoading(false);
      });
  }, [canManageLinks, loadServerSettings, serverId]);

  const saveOnboardingSettings = useCallback(async (patch: { onboardingAgentId?: string | null; agentAllChannelGreetingEnabled?: boolean }) => {
    if (!serverId) return;
    await api.patch(`/servers/${serverId}/onboarding-settings`, patch);
    await loadServerSettings({ force: true });
  }, [loadServerSettings, serverId]);

  const handleFinishSetup = useCallback(async () => {
    if (!serverId || !isAdminOrOwner || reopeningSetup) return;
    setReopeningSetup(true);
    setError("");
    try {
      const { data } = await api.post(`/servers/${serverId}/setup-transition`, { action: "start" });
      setSetupProjection(data);
      // Tell the gate. Without this the server reopened setup and the only visible effect
      // was a navigation: the modal that was supposed to appear never heard about it.
      bumpServerSetupRevision();
      navigate(`/s/${serverSlug}`);
    } catch (error: unknown) {
      const responseError = (error as { response?: { data?: { error?: unknown } } }).response?.data?.error;
      setError(typeof responseError === "string" ? responseError : formatMessage({ id: "settings.onboarding.reopenSetupFailed" }));
    } finally {
      setReopeningSetup(false);
    }
  }, [formatMessage, isAdminOrOwner, navigate, reopeningSetup, serverId, serverSlug]);

  const runAgentSave = agentSave.run;
  const handleOnboardingAgentChange = useCallback((value: string | null) => {
    if (value == null || value === onboardingAgentId) return;
    const previous = onboardingAgentId;
    setOnboardingAgentId(value);
    void runAgentSave(
      () => saveOnboardingSettings({ onboardingAgentId: value || null }).catch((err: unknown) => {
        setOnboardingAgentId(previous);
        throw err;
      }),
      (err) => apiErrorText(err, formatMessage({ id: "settings.onboarding.failedSave" })),
    );
  }, [formatMessage, onboardingAgentId, runAgentSave, saveOnboardingSettings]);

  const runGreetingSave = greetingSave.run;
  const handleGreetingChange = useCallback((checked: boolean) => {
    setAgentAllChannelGreetingEnabled(checked);
    void runGreetingSave(
      () => saveOnboardingSettings({ agentAllChannelGreetingEnabled: checked }).catch((err: unknown) => {
        setAgentAllChannelGreetingEnabled(!checked);
        throw err;
      }),
      (err) => apiErrorText(err, formatMessage({ id: "settings.onboarding.greetingFailedSave" })),
    );
  }, [formatMessage, runGreetingSave, saveOnboardingSettings]);

  if (!canManageLinks) return null;

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Bot size={16} />}
        label={formatMessage({ id: "settings.onboarding.sectionLabel" })}
      />

      {/* Settings rows (DS Forms › A setting's row; Jasper + cindyz, #triage:c95a5e53): the
          agent's Select, the greeting's switch and Finish Setup end their rows (the Select and
          Finish Setup under the text where the row is under 32rem wide). On a wide row the
          Select is as wide as its longest option (`fit`, 11-20rem). */}
      <ListRowGroup className="@container" data-testid="onboarding-rows">
        <ListRow variant="plain" interactive={false} className="@max-lg:flex-wrap">
          <ListRowBody>
            <ListRowTitle id={agentLabelId}>{formatMessage({ id: "settings.onboarding.humanAgentTitle" })}</ListRowTitle>
            <ImmediateSaveStatus feedback={agentSave.feedback} testId="onboarding-agent-status" />
          </ListRowBody>
          <div className="shrink-0 @max-lg:basis-full">
            <Select
              value={onboardingAgentId}
              onValueChange={handleOnboardingAgentChange}
              disabled={!canManageLinks || agentSave.saving || loading}
              items={onboardingAgentOptions}
            >
              <SelectTrigger fit className="@max-lg:w-full @max-lg:max-w-sm" aria-labelledby={agentLabelId} data-testid="onboarding-agent-select">
                <SelectValue placeholder={formatMessage({ id: "settings.onboarding.agentPlaceholder" })} />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  {renderSelectItems(onboardingAgentOptions)}
                </SelectList>
              </SelectContent>
            </Select>
          </div>
        </ListRow>

        <ListRow variant="plain" interactive={false} data-testid="onboarding-greeting-setting">
          <ListRowBody>
            <ListRowTitle id={`${greetingIdPrefix}-label`}>{formatMessage({ id: "settings.onboarding.greetingTitle" })}</ListRowTitle>
            <ImmediateSaveStatus id={`${greetingIdPrefix}-status`} feedback={greetingSave.feedback} testId="onboarding-greeting-status" />
          </ListRowBody>
          <ImmediateRowSwitch
            checked={agentAllChannelGreetingEnabled}
            onCheckedChange={handleGreetingChange}
            disabled={!canManageLinks || greetingSave.saving || loading}
            aria-labelledby={`${greetingIdPrefix}-label`}
            aria-describedby={`${greetingIdPrefix}-status`}
            data-testid="onboarding-greeting-switch"
          />
        </ListRow>

        {/* Who may see the setup flow is the SERVER's answer, in one place: a non-owner's
            projection comes back `surface: "none"`. Re-deriving it here from the client's own
            role would be a second opinion that can drift — hide it in one surface, leak it in
            another (@Jianwei's point). The projection alone decides. */}
        {setupProjection && setupProjection.phase !== "complete" && setupProjection.surface !== "none" ? (
          <ListRow variant="plain" interactive={false} className="@max-lg:flex-wrap">
            <ListRowBody>
              <ListRowTitle>{formatMessage({ id: "settings.onboarding.serverSetupTitle" })}</ListRowTitle>
            </ListRowBody>
            <div className="shrink-0 @max-lg:basis-full">
              <Button
                variant="outline" size="md"
                type="button"
                onClick={handleFinishSetup}
                disabled={reopeningSetup}
                data-testid="finish-server-setup"
              >
                {formatMessage({ id: reopeningSetup ? "settings.onboarding.openingSetup" : "settings.onboarding.finishSetup" })}
                {!reopeningSetup && <ChevronRight size={14} />}
              </Button>
            </div>
          </ListRow>
        ) : null}
      </ListRowGroup>

      {error && (
        <Banner intent="warning" density="sm" className="mt-3">
          {error}
        </Banner>
      )}
    </div>
  );
}
