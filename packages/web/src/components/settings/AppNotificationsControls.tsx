import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import {
  APP_NOTIFICATION_EVENT_GROUPS,
  APP_NOTIFICATION_GROUPS,
} from "@botiverse/raft-shared";
import type {
  AppNotificationEvent,
  AppNotificationGroup,
} from "@botiverse/raft-shared";
import { Bell, Check, Copy, KeyRound, RotateCw } from "lucide-react";
import { Badge, Switch } from "raft-ui";
import api from "../../api/client";
import Button from "../ui/Button";
import Checkbox from "../ui/Checkbox";
import SectionEyebrow from "../ui/SectionEyebrow";
import type { MessageId } from "../../i18n/messages";

// Holds catalog IDS, not display text: module scope cannot call formatMessage.
// Call sites format. Same shape as the sub-batch F distribution helpers.
const GROUP_META: Record<AppNotificationGroup, { labelId: MessageId; summaryId: MessageId }> = {
  server: { labelId: "settings.connectedApps.appNotifications.group.server.label", summaryId: "settings.connectedApps.appNotifications.group.server.summary" },
  agent: { labelId: "settings.connectedApps.appNotifications.group.agent.label", summaryId: "settings.connectedApps.appNotifications.group.agent.summary" },
  channel: { labelId: "settings.connectedApps.appNotifications.group.channel.label", summaryId: "settings.connectedApps.appNotifications.group.channel.summary" },
  computer: { labelId: "settings.connectedApps.appNotifications.group.computer.label", summaryId: "settings.connectedApps.appNotifications.group.computer.summary" },
};

const EVENT_LABEL_ID: Record<AppNotificationEvent, MessageId> = {
  "server.member_added": "settings.connectedApps.appNotifications.event.server_member_added",
  "server.member_removed": "settings.connectedApps.appNotifications.event.server_member_removed",
  "server.member_role_changed": "settings.connectedApps.appNotifications.event.server_member_role_changed",
  "server.config_updated": "settings.connectedApps.appNotifications.event.server_config_updated",
  "server.public_channel_created": "settings.connectedApps.appNotifications.event.server_public_channel_created",
  "server.public_channel_archived": "settings.connectedApps.appNotifications.event.server_public_channel_archived",
  "server.plan_changed": "settings.connectedApps.appNotifications.event.server_plan_changed",
  "agent.status_changed": "settings.connectedApps.appNotifications.event.agent_status_changed",
  "agent.profile_updated": "settings.connectedApps.appNotifications.event.agent_profile_updated",
  "agent.runtime_changed": "settings.connectedApps.appNotifications.event.agent_runtime_changed",
  "agent.model_changed": "settings.connectedApps.appNotifications.event.agent_model_changed",
  "channel.member_added": "settings.connectedApps.appNotifications.event.channel_member_added",
  "channel.member_removed": "settings.connectedApps.appNotifications.event.channel_member_removed",
  "channel.config_updated": "settings.connectedApps.appNotifications.event.channel_config_updated",
  "channel.archived": "settings.connectedApps.appNotifications.event.channel_archived",
  "thread.created": "settings.connectedApps.appNotifications.event.thread_created",
  "thread.resolved": "settings.connectedApps.appNotifications.event.thread_resolved",
  "computer.online": "settings.connectedApps.appNotifications.event.computer_online",
  "computer.offline": "settings.connectedApps.appNotifications.event.computer_offline",
  "computer.version_changed": "settings.connectedApps.appNotifications.event.computer_version_changed",
  "computer.agent_started": "settings.connectedApps.appNotifications.event.computer_agent_started",
  "computer.agent_stopped": "settings.connectedApps.appNotifications.event.computer_agent_stopped",
};

export type AppNotificationSelection = {
  groups: AppNotificationGroup[];
  events: AppNotificationEvent[];
};

export type AppNotificationsDeveloperState = {
  source_installation?: {
    installation_id: AppNotificationsInstallationState["installation_id"];
    status: "active" | "suspended";
    enabled: boolean;
    approved_request_revision_id: string | null;
    approved_groups: AppNotificationGroup[];
  } | null;
  request_revision: number;
  current_revision_id: string | null;
  current_groups: AppNotificationGroup[];
  current_events: AppNotificationEvent[];
  pending_revision: {
    id: string;
    revision: number;
    groups: AppNotificationGroup[];
    events: AppNotificationEvent[];
    created_at: string;
  } | null;
  webhook: {
    endpoint_url: string;
    config_revision: number;
    enabled: boolean;
    previous_valid_until: string | null;
    updated_at: string;
  } | null;
};

export type AppNotificationsInstallationState = {
  installation_id: string;
  status: "active";
  approved_request_revision_id: string | null;
  requested_groups: AppNotificationGroup[];
  requested_events: AppNotificationEvent[];
  approved_groups: AppNotificationGroup[];
  subscribed_events: AppNotificationEvent[];
  effective_groups: AppNotificationGroup[];
  effective_events: AppNotificationEvent[];
  grant_revision: number;
  subscription_revision: number;
  app_review_pending: boolean;
  approval_required: boolean;
};

const ALL_EVENTS = Object.keys(APP_NOTIFICATION_EVENT_GROUPS) as AppNotificationEvent[];

type ApiError = {
  message?: string;
  response?: { data?: { error?: string } };
};

function apiErrorMessage(error: unknown, fallback: string): string {
  const apiError = error as ApiError;
  return apiError.response?.data?.error || apiError.message || fallback;
}

function sortedSelection(selection: AppNotificationSelection): AppNotificationSelection {
  return {
    groups: APP_NOTIFICATION_GROUPS.filter((group) => selection.groups.includes(group)),
    events: ALL_EVENTS.filter((event) => selection.events.includes(event)),
  };
}

export function toggleAppNotificationGroup(
  selection: AppNotificationSelection,
  group: AppNotificationGroup,
  checked: boolean,
): AppNotificationSelection {
  const groups = checked
    ? [...selection.groups, group]
    : selection.groups.filter((item) => item !== group);
  const events = checked
    ? selection.events
    : selection.events.filter((event) => !(APP_NOTIFICATION_EVENT_GROUPS[event] as readonly AppNotificationGroup[]).includes(group));
  return sortedSelection({ groups, events });
}

export function toggleAppNotificationEvent(
  selection: AppNotificationSelection,
  event: AppNotificationEvent,
  checked: boolean,
): AppNotificationSelection {
  const events = checked
    ? [...selection.events, event]
    : selection.events.filter((item) => item !== event);
  return sortedSelection({ groups: selection.groups, events });
}

// Takes formatMessage as a parameter: this is a plain helper, not a component, so
// it cannot call useIntl. Both call sites are inside components that already have
// it. (The alternative — returning a MessageId as the F/H2a helpers do — does not
// apply here because this returns JSX, not a string.)
function statusBadge(
  state: AppNotificationsDeveloperState | null,
  formatMessage: IntlShape["formatMessage"],
) {
  if (state?.pending_revision) return <Badge variant="warning" uppercase>{formatMessage({ id: "settings.connectedApps.appNotifications.pendingAppReview" })}</Badge>;
  if (state?.current_events?.length) return <Badge variant="success" uppercase>{formatMessage({ id: "settings.connectedApps.appNotifications.requestApproved" })}</Badge>;
  return <Badge appearance="outline" uppercase>{formatMessage({ id: "settings.connectedApps.appNotifications.disabled" })}</Badge>;
}

function AppNotificationsEyebrow() {
  const { formatMessage } = useIntl();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.section.appNotifications" })}</SectionEyebrow>
      <Badge.Experimental />
    </div>
  );
}

export function AppNotificationPermissionPicker({
  value,
  onChange,
  disabled = false,
  allowedGroups,
  allowedEvents,
}: {
  value: AppNotificationSelection;
  onChange: (next: AppNotificationSelection) => void;
  disabled?: boolean;
  allowedGroups?: readonly AppNotificationGroup[];
  allowedEvents?: readonly AppNotificationEvent[];
}) {
  const { formatMessage } = useIntl();
  const selectedGroups = new Set(value.groups);
  const selectedEvents = new Set(value.events);
  const allowedGroupSet = allowedGroups ? new Set(allowedGroups) : null;
  const allowedEventSet = allowedEvents ? new Set(allowedEvents) : null;

  return (
    <div className="space-y-3" data-testid="app-notifications-permission-picker">
      <div className="grid gap-2 sm:grid-cols-2">
        {APP_NOTIFICATION_GROUPS.map((group) => {
          const allowed = !allowedGroupSet || allowedGroupSet.has(group);
          return (
            <label
              key={group}
              className={`flex min-h-[68px] items-start gap-2 border-2 p-2.5 ${selectedGroups.has(group) ? "border-black bg-brutal-lime/20" : "border-black/15 bg-white"} ${allowed ? "" : "opacity-45"}`}
            >
              <Checkbox
                size="sm"
                checked={selectedGroups.has(group)}
                disabled={disabled || !allowed}
                onChange={(event) => onChange(toggleAppNotificationGroup(value, group, event.currentTarget.checked))}
              />
              <span className="min-w-0">
                <span className="block text-xs font-black text-black">{formatMessage({ id: GROUP_META[group].labelId })}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-black/55">{formatMessage({ id: GROUP_META[group].summaryId })}</span>
              </span>
            </label>
          );
        })}
      </div>
      {APP_NOTIFICATION_GROUPS.filter((group) => selectedGroups.has(group)).map((group) => {
        const events = ALL_EVENTS.filter((event) => APP_NOTIFICATION_EVENT_GROUPS[event][0] === group);
        return (
          <details key={group} open className="border-t-2 border-black/15 pt-2">
            <summary className="text-xs font-black text-black">{formatMessage({ id: "settings.connectedApps.appNotifications.groupEventsSummary" }, { group: formatMessage({ id: GROUP_META[group].labelId }) })}</summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {events.map((event) => {
                const requiredGroups = APP_NOTIFICATION_EVENT_GROUPS[event];
                const available = requiredGroups.every((required) => selectedGroups.has(required))
                  && (!allowedEventSet || allowedEventSet.has(event));
                return (
                  <label key={event} className={`flex min-h-[38px] items-start gap-2 border border-black/15 bg-white px-2 py-1.5 text-xs font-bold text-black/70 ${available ? "" : "opacity-45"}`}>
                    <Checkbox
                      size="sm"
                      checked={selectedEvents.has(event)}
                      disabled={disabled || !available}
                      onChange={(change) => onChange(toggleAppNotificationEvent(value, event, change.currentTarget.checked))}
                    />
                    <span className="min-w-0 break-words">
                      {formatMessage({ id: EVENT_LABEL_ID[event] })}
                      {requiredGroups.length > 1 ? <span className="block text-[10px] font-normal text-black/45">{formatMessage({ id: "settings.connectedApps.appNotifications.requiresAgentAndComputer" })}</span> : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </details>
        );
      })}
      {value.groups.length === 0 ? (
        <div className="border-l-4 border-black/25 bg-black/[0.03] px-3 py-2 text-xs font-bold text-black/55">
          {formatMessage({ id: "settings.connectedApps.appNotifications.disabledForApp" })}
        </div>
      ) : null}
    </div>
  );
}

export function DeveloperAppNotifications({
  clientId,
  value,
  onChange,
  state,
  loading,
  onStateChange,
  onConfigurationOpenChange,
  onError,
  embedded = false,
}: {
  clientId: string | null;
  value: AppNotificationSelection;
  onChange: (next: AppNotificationSelection) => void;
  state: AppNotificationsDeveloperState | null;
  loading: boolean;
  onStateChange: (next: AppNotificationsDeveloperState) => void;
  onConfigurationOpenChange?: (open: boolean) => void;
  onError: (message: string) => void;
  embedded?: boolean;
}) {
  const { formatMessage } = useIntl();
  const sourceEndpoint = state?.webhook?.endpoint_url ?? "";
  const [endpointDraft, setEndpointDraft] = useState<{
    clientId: string | null;
    sourceEndpoint: string;
    value: string;
  } | null>(null);
  const [busy, setBusy] = useState<"endpoint" | "rotate" | "disable" | null>(null);
  const [configurationDraft, setConfigurationDraft] = useState<{
    clientId: string;
    open: boolean;
  } | null>(null);
  const [secretState, setSecretState] = useState<{
    clientId: string;
    value: string;
    copied: boolean;
  } | null>(null);
  const endpoint = endpointDraft?.clientId === clientId && endpointDraft.sourceEndpoint === sourceEndpoint
    ? endpointDraft.value
    : sourceEndpoint;
  const signingSecret = clientId && secretState?.clientId === clientId ? secretState.value : null;
  const configurationOpen = clientId && configurationDraft?.clientId === clientId
    ? configurationDraft.open
    : !!state?.webhook?.enabled;

  const refresh = async () => {
    if (!clientId) return;
    const { data } = await api.get(`/integrations/clients/${clientId}/app-notifications`);
    onStateChange(data);
  };

  const saveEndpoint = async () => {
    if (!clientId) return;
    setBusy("endpoint");
    onError("");
    try {
      const { data } = await api.put(`/integrations/clients/${clientId}/app-notifications/webhook`, { endpointUrl: endpoint });
      setSecretState(data.signing_secret ? { clientId, value: data.signing_secret, copied: false } : null);
      await refresh();
    } catch (error: unknown) {
      onError(apiErrorMessage(error, formatMessage({ id: "settings.connectedApps.appNotifications.failedSaveEndpoint" })));
    } finally {
      setBusy(null);
    }
  };

  const rotateSecret = async () => {
    if (!clientId) return;
    setBusy("rotate");
    onError("");
    try {
      const { data } = await api.post(`/integrations/clients/${clientId}/app-notifications/webhook/rotate-secret`);
      setSecretState({ clientId, value: data.signing_secret, copied: false });
      await refresh();
    } catch (error: unknown) {
      onError(apiErrorMessage(error, formatMessage({ id: "settings.connectedApps.appNotifications.failedRotateSecret" })));
    } finally {
      setBusy(null);
    }
  };

  const disableEndpoint = async (): Promise<boolean> => {
    if (!clientId) return false;
    setBusy("disable");
    onError("");
    try {
      await api.delete(`/integrations/clients/${clientId}/app-notifications/webhook`);
      setSecretState(null);
      await refresh();
      return true;
    } catch (error: unknown) {
      onError(apiErrorMessage(error, formatMessage({ id: "settings.connectedApps.appNotifications.failedDisableEndpoint" })));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const toggleConfiguration = async (enabled: boolean) => {
    if (!clientId) return;
    if (enabled) {
      setConfigurationDraft({ clientId, open: true });
      onConfigurationOpenChange?.(true);
      return;
    }
    if (state?.webhook?.enabled && !(await disableEndpoint())) return;
    setConfigurationDraft({ clientId, open: false });
    onConfigurationOpenChange?.(false);
  };

  const copySecret = async () => {
    if (!signingSecret) return;
    try {
      await navigator.clipboard.writeText(signingSecret);
      setSecretState((current) => current?.clientId === clientId
        ? { ...current, copied: true }
        : current);
    } catch (error: unknown) {
      onError(apiErrorMessage(error, formatMessage({ id: "settings.connectedApps.appNotifications.failedCopySecret" })));
    }
  };

  return (
    <section className={embedded ? "space-y-3" : "space-y-3 border-t-2 border-black pt-4"} data-testid="developer-app-notifications">
      {!embedded ? (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <Bell size={18} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <AppNotificationsEyebrow />
              <div className="mt-1 text-xs leading-relaxed text-black/60">{formatMessage({ id: "settings.connectedApps.appNotifications.eventsMayReceive" })}</div>
            </div>
          </div>
          {loading ? <Badge appearance="outline" uppercase>{formatMessage({ id: "common.loadingLabel" })}</Badge> : statusBadge(state, formatMessage)}
        </div>
      ) : null}
      {state?.source_installation ? (
        <div className="space-y-2 border-2 border-black/20 bg-white p-3" data-testid="app-notifications-source-installation">
          <div className="text-sm font-bold">{formatMessage({ id: "settings.connectedApps.appNotifications.sourceInstallation" })}</div>
          <div className="text-xs">{formatMessage({ id: !state.source_installation.enabled
            ? "settings.connectedApps.appNotifications.sourceDisabled"
            : state.source_installation.status === "suspended"
              ? "settings.connectedApps.appNotifications.sourceSuspended"
              : "settings.connectedApps.appNotifications.sourceActive" })}</div>
          <label className="block text-xs font-bold">
            {formatMessage({ id: "settings.connectedApps.appNotifications.installationId" })}
            <input readOnly value={state.source_installation.installation_id} onFocus={(event) => event.target.select()}
              className="mt-1 block w-full border border-black/30 p-2 font-mono text-xs" />
          </label>
          <div className="text-xs text-black/60">{formatMessage({ id: "settings.connectedApps.appNotifications.sourceUse" })}</div>
        </div>
      ) : null}
      <div className="space-y-3 border-2 border-black/20 bg-white p-3" data-testid="app-notifications-delivery">
        <div className="flex flex-wrap items-start justify-between gap-2 border-b-2 border-black/10 pb-2">
          <div>
            <div className="text-sm font-black text-black">{formatMessage({ id: "settings.connectedApps.appNotifications.deliveryTitle" })}</div>
            <div className="mt-0.5 text-xs leading-relaxed text-black/55">{formatMessage({ id: "settings.connectedApps.appNotifications.deliveryDescription" })}</div>
          </div>
          {embedded ? (loading ? <Badge appearance="outline" uppercase>{formatMessage({ id: "common.loadingLabel" })}</Badge> : statusBadge(state, formatMessage)) : null}
        </div>
        <div className="flex items-start justify-between gap-4">
          <span className="min-w-0">
            <span id="app-notifications-enabled-label" className="block text-sm font-bold text-black">
              {formatMessage({ id: "settings.connectedApps.appNotifications.enableTitle" })}
            </span>
            <span id="app-notifications-enabled-description" className="mt-0.5 block text-xs leading-5 text-black/60">
              {formatMessage({ id: "settings.connectedApps.appNotifications.enableDescription" })}
            </span>
            {!clientId ? (
              <span className="mt-1 block text-[11px] font-bold text-black/45">{formatMessage({ id: "settings.connectedApps.appNotifications.saveBeforeWebhook" })}</span>
            ) : null}
          </span>
          <Switch
            size="md"
            checked={configurationOpen}
            onCheckedChange={(enabled) => void toggleConfiguration(enabled)}
            disabled={!clientId || loading || !state || !!busy}
            aria-labelledby="app-notifications-enabled-label"
            aria-describedby="app-notifications-enabled-description"
            className="mt-0.5 shrink-0"
          />
        </div>
        {configurationOpen && clientId ? (
          <div className="space-y-3 border-t-2 border-black/15 pt-3" data-testid="app-notifications-configuration">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-xs font-bold text-black/70">{formatMessage({ id: "settings.connectedApps.appNotifications.httpsEndpoint" })}</span>
                <input
                  type="url"
                  value={endpoint}
                  onChange={(event) => setEndpointDraft({
                    clientId,
                    sourceEndpoint,
                    value: event.target.value,
                  })}
                  className="input-brutal w-full font-mono text-xs"
                  placeholder="https://example.com/raft/events"
                />
              </label>
              <Button type="button" size="sm" className="h-9" onClick={() => void saveEndpoint()} disabled={!!busy || !endpoint.trim()}>
                {busy === "endpoint" ? formatMessage({ id: "settings.connectedApps.appNotifications.saving" }) : formatMessage({ id: "settings.connectedApps.appNotifications.saveEndpoint" })}
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-black/55">
              <span>{state?.webhook?.enabled
            ? formatMessage({ id: "settings.connectedApps.appNotifications.enabledRevision" }, { revision: state.webhook.config_revision })
            : formatMessage({ id: "settings.connectedApps.appNotifications.enterEndpointToEnable" })}</span>
              {state?.webhook?.enabled ? (
                <Button type="button" size="sm" shape="iconText" onClick={() => void rotateSecret()} disabled={!!busy}>
                  <RotateCw size={13} /> {busy === "rotate" ? formatMessage({ id: "settings.connectedApps.appNotifications.rotating" }) : formatMessage({ id: "settings.connectedApps.appNotifications.rotateSecret" })}
                </Button>
              ) : null}
            </div>
            {signingSecret ? (
              <div className="space-y-2 border-l-4 border-brutal-lime bg-brutal-lime/15 px-3 py-2" data-testid="app-notifications-secret-reveal">
                <div className="flex items-center gap-2 text-xs font-black text-black"><KeyRound size={14} /> {formatMessage({ id: "settings.connectedApps.appNotifications.signingSecretShownOnce" })}</div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <code className="min-w-0 flex-1 break-all border border-black/20 bg-white p-2 text-[11px]">{signingSecret}</code>
                  <Button type="button" size="sm" shape="iconText" onClick={() => void copySecret()}>
                    {secretState?.copied ? <Check size={13} /> : <Copy size={13} />} {secretState?.copied ? formatMessage({ id: "settings.connectedApps.appNotifications.copied" }) : formatMessage({ id: "settings.connectedApps.appNotifications.copy" })}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {configurationOpen && clientId ? (
        <div className="space-y-3 border-2 border-black/20 bg-white p-3" data-testid="app-notifications-permissions">
          <div className="border-b-2 border-black/10 pb-2">
            <div className="text-sm font-black text-black">{formatMessage({ id: "settings.connectedApps.appNotifications.permissionsTitle" })}</div>
            <div className="mt-0.5 text-xs leading-relaxed text-black/55">{formatMessage({ id: "settings.connectedApps.appNotifications.permissionsDescription" })}</div>
          </div>
          <AppNotificationPermissionPicker value={value} onChange={onChange} disabled={loading || !state} />
          {state?.pending_revision ? (
            <div className="border-l-4 border-soft-signal bg-soft-signal/20 px-3 py-2 text-xs leading-relaxed text-black/70">
              {formatMessage(
                { id: "settings.connectedApps.appNotifications.revisionPendingReview" },
                { revision: state.pending_revision.revision },
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ScopeChips({ values, empty }: { values: readonly string[]; empty: string }) {
  if (values.length === 0) return <span className="text-xs font-bold text-black/45">{empty}</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => <span key={value} className="border border-black/20 bg-white px-2 py-1 text-[11px] font-bold text-black/70">{value}</span>)}
    </div>
  );
}

export function AppNotificationRequestSummary({
  groups,
  events,
  reviewPending = false,
}: {
  groups: readonly AppNotificationGroup[];
  events: readonly AppNotificationEvent[];
  reviewPending?: boolean;
}) {
  const { formatMessage } = useIntl();
  return (
    <section className="space-y-3 border-t-2 border-black pt-4" data-testid="app-notifications-request-summary">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <Bell size={18} className="mt-0.5 shrink-0" />
          <div>
            <AppNotificationsEyebrow />
            <div className="mt-1 text-xs text-black/55">
              {formatMessage({
                id: reviewPending
                  ? "settings.connectedApps.appNotifications.requestPendingDescription"
                  : "settings.connectedApps.appNotifications.requestApprovedDescription",
              })}
            </div>
          </div>
        </div>
        {reviewPending ? <Badge variant="warning" uppercase>{formatMessage({ id: "settings.connectedApps.appNotifications.appReviewPending" })}</Badge> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-2 border-t-2 border-black/15 pt-2">
          <div className="text-[10px] font-black uppercase tracking-widest text-black/50">{formatMessage({ id: "settings.connectedApps.appNotifications.dataGroups" })}</div>
          <ScopeChips values={groups.map((group) => formatMessage({ id: GROUP_META[group].labelId }))} empty={formatMessage({ id: "settings.connectedApps.appNotifications.noDataAccess" })} />
        </div>
        <div className="min-w-0 space-y-2 border-t-2 border-black/15 pt-2">
          <div className="text-[10px] font-black uppercase tracking-widest text-black/50">{formatMessage({ id: "settings.connectedApps.appNotifications.notificationEvents" })}</div>
          <ScopeChips values={events.map((event) => formatMessage({ id: EVENT_LABEL_ID[event] }))} empty={formatMessage({ id: "settings.connectedApps.appNotifications.noEvents" })} />
        </div>
      </div>
    </section>
  );
}

export function InstalledAppNotifications({
  clientId,
  canManage,
  onError,
}: {
  clientId: string;
  canManage: boolean;
  onError: (message: string) => void;
}) {
  const { formatMessage } = useIntl();
  const [state, setState] = useState<AppNotificationsInstallationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/integrations/marketplace/${clientId}/install/app-notifications`);
      setState(data);
    } catch (error: unknown) {
      onError(apiErrorMessage(error, formatMessage({ id: "settings.connectedApps.appNotifications.failedLoadInstalled" })));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const save = async () => {
    setSaving(true);
    onError("");
    try {
      await api.put(`/integrations/marketplace/${clientId}/install/app-notifications/grant`);
      await load();
    } catch (error: unknown) {
      onError(apiErrorMessage(error, formatMessage({ id: "settings.connectedApps.appNotifications.failedUpdateInstalled" })));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="border-t-2 border-black pt-3 text-xs font-bold text-black/50">{formatMessage({ id: "settings.connectedApps.appNotifications.loading" })}</div>;
  if (!state) return null;

  const newlyRequestedGroups = state.requested_groups.filter((group) => !state.approved_groups.includes(group));

  return (
    <section className="space-y-3 border-t-2 border-black pt-4" data-testid="installed-app-notifications">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <Bell size={18} className="mt-0.5 shrink-0" />
          <div>
            <AppNotificationsEyebrow />
            <div className="mt-1 text-xs text-black/55">{formatMessage({ id: "settings.connectedApps.appNotifications.installedSummary" })}</div>
          </div>
        </div>
        {state.effective_events.length > 0 ? <Badge variant="success" uppercase>{formatMessage({ id: "settings.connectedApps.appNotifications.enabled" })}</Badge> : <Badge appearance="outline" uppercase>{formatMessage({ id: "settings.connectedApps.appNotifications.disabled" })}</Badge>}
      </div>
      {state.app_review_pending ? <Badge variant="warning" uppercase>{formatMessage({ id: "settings.connectedApps.appNotifications.appReviewPending" })}</Badge> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="min-w-0 space-y-2 border-t-2 border-black/15 pt-2">
          <div className="text-[10px] font-black uppercase tracking-widest text-black/50">{formatMessage({ id: "settings.connectedApps.appNotifications.approvedData" })}</div>
          <ScopeChips values={state.approved_groups.map((group) => formatMessage({ id: GROUP_META[group].labelId }))} empty={formatMessage({ id: "settings.connectedApps.appNotifications.noDataAccessEmpty" })} />
        </div>
        <div className="min-w-0 space-y-2 border-t-2 border-black/15 pt-2">
          <div className="text-[10px] font-black uppercase tracking-widest text-black/50">{formatMessage({ id: "settings.connectedApps.appNotifications.developerSubscriptions" })}</div>
          <ScopeChips values={state.subscribed_events.map((event) => formatMessage({ id: EVENT_LABEL_ID[event] }))} empty={formatMessage({ id: "settings.connectedApps.appNotifications.noSubscriptions" })} />
        </div>
        <div className="min-w-0 space-y-2 border-t-2 border-black/15 pt-2">
          <div className="text-[10px] font-black uppercase tracking-widest text-black/50">{formatMessage({ id: "settings.connectedApps.appNotifications.activeEvents" })}</div>
          <ScopeChips values={state.effective_events.map((event) => formatMessage({ id: EVENT_LABEL_ID[event] }))} empty={formatMessage({ id: "settings.connectedApps.appNotifications.noActiveEvents" })} />
        </div>
      </div>
      {state.approval_required ? (
        <div
          className="flex flex-col gap-3 border-l-4 border-soft-signal bg-soft-signal/20 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
          data-testid="app-notifications-approval-required"
        >
          <div className="min-w-0 space-y-2">
            <div className="text-xs font-bold text-black/70">{formatMessage({ id: "settings.connectedApps.appNotifications.newDataAccessNotice" })}</div>
            <ScopeChips
              values={newlyRequestedGroups.map((group) => formatMessage({ id: "settings.connectedApps.appNotifications.newDataGroupPrefix" }, { group: formatMessage({ id: GROUP_META[group].labelId }) }))}
              empty={formatMessage({ id: "settings.connectedApps.appNotifications.noNewDataGroups" })}
            />
          </div>
          {canManage ? (
            <Button type="button" size="sm" tone="pink" onClick={() => void save()} disabled={saving}>
              {saving ? formatMessage({ id: "settings.connectedApps.appNotifications.approving" }) : formatMessage({ id: "settings.connectedApps.appNotifications.approveUpdate" })}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
