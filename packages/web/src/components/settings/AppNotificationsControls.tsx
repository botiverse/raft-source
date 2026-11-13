import { useCallback, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FocusEvent } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import ExperimentalBadge from "../ui/ExperimentalBadge";
import {
  APP_NOTIFICATION_EVENT_GROUPS,
  APP_NOTIFICATION_GROUPS,
} from "@botiverse/raft-shared";
import type {
  AppNotificationEvent,
  AppNotificationGroup,
} from "@botiverse/raft-shared";
import { AlertTriangle, Bell, Check, Copy, KeyRound, RefreshCw } from "lucide-react";
import { Badge, Card, Checkbox, Button, Field, FieldItem, FieldLabel, Table, TableHeader, TableBody, TableRow, TableHead, Input, Separator } from "@botiverse/raft-ui";
import api from "../../api/client";
import { isSecondFactorStepUpCancelled, withSecondFactorStepUp } from "./secondFactorStepUp";
import { expectedAppPermissionsBody, isAppPermissionsChangedError, isExpectedPermissionsRequiredError } from "../../lib/appPermissionExpectation";
import { AppPermissionSetList } from "../integrations/AppPermissionSetList";
import { AppPromptTextBlock, AppPromptTextComparison } from "../integrations/AppPromptText";
import { expectedTextRevisionBody, appTextChangedCurrent, readInstalledAppPromptTextState } from "../../lib/appPromptText";
import Banner from "../ui/Banner";
import ConfirmDialog from "../ConfirmDialog";
import SectionEyebrow from "../ui/SectionEyebrow";
import { AppNotificationGroupCheckbox } from "./AppNotificationGroupCheckbox";
import { AppNotificationEventCheckbox } from "./AppNotificationEventCheckbox";
import { AppPermissionAccessRow } from "./AppPermissionAccessRow";
import type { MessageId } from "../../i18n/messages";
import { ALL_APP_NOTIFICATION_EVENTS as ALL_EVENTS, APP_NOTIFICATION_GROUP_META as GROUP_META, permissionGroupLabel } from "./appNotificationSelection";
import type { AppNotificationSelection } from "./appNotificationSelection";
import { SETTING_SAVED_MS } from "./ImmediateSetting";

export { APP_NOTIFICATION_GROUP_META, permissionGroupLabel, toggleAppNotificationEvent, toggleAppNotificationGroup } from "./appNotificationSelection";
export type { AppNotificationSelection } from "./appNotificationSelection";

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
  /** The app's current login scopes; approving the update sends them back as shown. */
  requested_scopes?: string[];
  /** Login scopes the app added after this server approved it; approving the update approves them. */
  new_scopes?: string[];
};


type ApiError = {
  message?: string;
  response?: { data?: { error?: string } };
};

function apiErrorMessage(error: unknown, fallback: string): string {
  const apiError = error as ApiError;
  return apiError.response?.data?.error || apiError.message || fallback;
}

// Takes formatMessage as a parameter: this is a plain helper, not a component, so
// it cannot call useIntl. Both call sites are inside components that already have
// it. (The alternative — returning a MessageId as the F/H2a helpers do — does not
// apply here because this returns JSX, not a string.)
function statusBadge(
  state: AppNotificationsDeveloperState | null,
  formatMessage: IntlShape["formatMessage"],
) {
  if (state?.pending_revision) return <Badge appearance="soft" variant="warning">{formatMessage({ id: "settings.connectedApps.appNotifications.pendingAppReview" })}</Badge>;
  if (state?.current_events?.length) return <Badge appearance="soft" variant="success">{formatMessage({ id: "settings.connectedApps.appNotifications.requestApproved" })}</Badge>;
  return <Badge appearance="soft" variant="muted">{formatMessage({ id: "settings.connectedApps.appNotifications.disabled" })}</Badge>;
}

// Raft DS settings vocabulary shared by every block below: an inset group
// (rf-list--inset) is a raft-ui Card holding hairline-divided rows
// (rf-row--plain); a status notice is the DS Banner (`live={false}`: these
// persistent notices are part of the page, not news). A neutral hint is a
// sunken note.
const INSET_GROUP = "rule-y rule-line-hairline";
const NOTE = "rounded-container bg-fill-muted px-3 py-2 text-footnote text-foreground";

function AppNotificationsEyebrow() {
  const { formatMessage } = useIntl();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.section.webhook" })}</SectionEyebrow>
      <ExperimentalBadge />
    </div>
  );
}

export function AppNotificationPermissionPicker({
  value,
  onChange,
  disabled = false,
  allowedGroups,
  allowedEvents,
  section = "all",
}: {
  value: AppNotificationSelection;
  onChange: (next: AppNotificationSelection) => void;
  disabled?: boolean;
  allowedGroups?: readonly AppNotificationGroup[];
  allowedEvents?: readonly AppNotificationEvent[];
  section?: "all" | "groups" | "events";
}) {
  const { formatMessage } = useIntl();
  const selectedGroups = new Set(value.groups);
  const selectedEvents = new Set(value.events);
  const allowedGroupSet = allowedGroups ? new Set(allowedGroups) : null;
  const allowedEventSet = allowedEvents ? new Set(allowedEvents) : null;

  return (
    <div className="stack-y-4" data-testid="app-notifications-permission-picker">
      {section !== "events" ? <Card className={INSET_GROUP}>
        {APP_NOTIFICATION_GROUPS.map((group) => {
          const allowed = !allowedGroupSet || allowedGroupSet.has(group);
          const inactive = disabled || !allowed;
          return (
            <label
              key={group}
              className={`flex min-h-11 items-start gap-3 px-4 py-3 ${inactive ? "cursor-not-allowed" : ""}`}
            >
              <AppNotificationGroupCheckbox
                group={group}
                value={value}
                checked={selectedGroups.has(group)}
                disabled={inactive}
                onChange={onChange}
              />
              <span className="min-w-0">
                <span className={`block text-subhead font-semibold ${inactive ? "text-foreground-disabled" : "text-foreground"}`}>{permissionGroupLabel(group, formatMessage)}</span>
                <span className={`mt-0.5 block text-footnote ${inactive ? "text-foreground-disabled" : "text-foreground-muted"}`}>{formatMessage({ id: GROUP_META[group].summaryId })}</span>
              </span>
            </label>
          );
        })}
      </Card> : null}
      {section !== "groups" ? APP_NOTIFICATION_GROUPS.filter((group) => selectedGroups.has(group)).map((group) => {
        const events = ALL_EVENTS.filter((event) => APP_NOTIFICATION_EVENT_GROUPS[event][0] === group);
        // Write grants (agent_reminder_write) carry no events.
        if (events.length === 0) return null;
        return (
          <details key={group} open>
            <summary className="text-footnote font-bold text-foreground-hint">{formatMessage({ id: "settings.connectedApps.appNotifications.groupEventsSummary" }, { group: formatMessage({ id: GROUP_META[group].labelId }) })}</summary>
            <Card className={`mt-2 ${INSET_GROUP}`}>
              {events.map((event) => {
                const requiredGroups = APP_NOTIFICATION_EVENT_GROUPS[event];
                const available = requiredGroups.every((required) => selectedGroups.has(required))
                  && (!allowedEventSet || allowedEventSet.has(event));
                const inactive = disabled || !available;
                return (
                  <label key={event} className={`flex min-h-11 items-start gap-3 px-4 py-3 text-subhead font-semibold ${inactive ? "cursor-not-allowed text-foreground-disabled" : "text-foreground"}`}>
                    <AppNotificationEventCheckbox
                      event={event}
                      value={value}
                      checked={selectedEvents.has(event)}
                      disabled={inactive}
                      onChange={onChange}
                    />
                    <span className="min-w-0 break-words">
                      {formatMessage({ id: EVENT_LABEL_ID[event] })}
                      {/* Only where the event needs both permissions: why the row is greyed out (Kirby). */}
                      {requiredGroups.length > 1 ? <span className={`mt-0.5 block text-footnote font-normal ${inactive ? "text-foreground-disabled" : "text-foreground-muted"}`} data-testid="app-notifications-event-requires">{formatMessage({ id: "settings.connectedApps.appNotifications.requiresAgentAndComputer" })}</span> : null}
                    </span>
                  </label>
                );
              })}
            </Card>
          </details>
        );
      }) : null}
      {value.groups.length === 0 ? (
        <div className={NOTE}>
          {formatMessage({ id: "settings.connectedApps.appPermissions.noSelection" })}
        </div>
      ) : null}
    </div>
  );
}

function selectInputOnFocus(event: FocusEvent<HTMLInputElement>) {
  event.target.select();
}

export function DeveloperAppPermissions({ clientId, value, onChange, state, loading }: {
  clientId: string | null;
  value: AppNotificationSelection;
  onChange: (next: AppNotificationSelection) => void;
  state: AppNotificationsDeveloperState | null;
  loading: boolean;
}) {
  const { formatMessage } = useIntl();
  return (
    <section className="stack-y-3" data-testid="developer-app-permissions">
      <Card>
        <Table aria-label={formatMessage({ id: "settings.connectedApps.section.appPermissions" })} data-testid="app-permissions-resources">
          <TableHeader>
            <TableRow>
              <TableHead>{formatMessage({ id: "settings.connectedApps.appPermissions.resource" })}</TableHead>
              <TableHead className="w-36">{formatMessage({ id: "settings.connectedApps.appPermissions.access" })}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {APP_NOTIFICATION_GROUPS.map((group) => (
              <AppPermissionAccessRow
                key={group}
                group={group}
                value={value}
                disabled={loading || (clientId !== null && state === null)}
                onChange={onChange}
              />
            ))}
          </TableBody>
        </Table>
      </Card>
      {state?.pending_revision ? (
        <Banner intent="warning" density="sm" live={false}>{formatMessage({ id: "settings.connectedApps.appNotifications.revisionPendingReview" }, { revision: state.pending_revision.revision })}</Banner>
      ) : null}
      {state?.source_installation ? (
        <Card className="stack-y-3 p-4" data-testid="app-notifications-source-installation">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-subhead font-semibold text-foreground">{formatMessage({ id: "settings.connectedApps.appNotifications.sourceInstallation" })}</div>
            <Badge
              appearance="soft"
              variant={!state.source_installation.enabled
                ? "muted"
                : state.source_installation.status === "suspended"
                  ? "warning"
                  : "success"}
            >
              {formatMessage({ id: !state.source_installation.enabled
                ? "settings.connectedApps.appNotifications.sourceDisabled"
                : state.source_installation.status === "suspended"
                  ? "settings.connectedApps.appNotifications.sourceSuspended"
                  : "settings.connectedApps.appNotifications.sourceActive" })}
            </Badge>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-footnote font-semibold text-foreground-muted">{formatMessage({ id: "settings.connectedApps.appNotifications.installationId" })}</span>
            <Input readOnly value={state.source_installation.installation_id} onFocus={selectInputOnFocus}
              className="w-full font-mono text-mono-code" />
          </label>
        </Card>
      ) : null}
    </section>
  );
}

function AppPermissionsEyebrow() {
  const { formatMessage } = useIntl();
  return <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.section.appPermissions" })}</SectionEyebrow>;
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
  const enabledId = useId();
  const sourceEndpoint = state?.webhook?.endpoint_url ?? "";
  const webhookEnabled = !!state?.webhook?.enabled;
  const [endpointDraft, setEndpointDraft] = useState<{
    clientId: string | null;
    sourceEndpoint: string;
    value: string;
  } | null>(null);
  const [busy, setBusy] = useState<"save" | "rotate" | null>(null);
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const savedTimer = useRef<number | null>(null);
  // Sending events needs an endpoint before it can be on, so it is a checkbox
  // with the endpoint under it and one Save for both (Raft DS › Forms,
  // "Settings saved together"): checking it only starts the draft, and
  // unchecking an active webhook stops deliveries only once it is saved.
  const [enabledDraft, setEnabledDraft] = useState<{
    clientId: string;
    sourceEnabled: boolean;
    checked: boolean;
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
  const checked = clientId && enabledDraft?.clientId === clientId && enabledDraft.sourceEnabled === webhookEnabled
    ? enabledDraft.checked
    : webhookEnabled;
  const canSave = checked
    ? !!endpoint.trim() && (!webhookEnabled || endpoint !== sourceEndpoint)
    : webhookEnabled;

  useEffect(() => () => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
  }, []);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const { data } = await api.get(`/integrations/clients/${clientId}/app-notifications`);
    onStateChange(data);
  }, [clientId, onStateChange]);

  const flashSaved = useCallback(() => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    setSavedFlash(true);
    savedTimer.current = window.setTimeout(() => {
      savedTimer.current = null;
      setSavedFlash(false);
    }, SETTING_SAVED_MS);
  }, []);

  const save = useCallback(async () => {
    if (!clientId || !canSave || !state) return;
    setBusy("save");
    setSavedFlash(false);
    onError("");
    try {
      // The answer says what was stored, so the state shows it before the
      // refresh: a refresh that fails can't take the configuration (and the
      // one-time signing secret) off the screen, or leave a stored change
      // looking unsaved.
      let stored: AppNotificationsDeveloperState;
      if (checked) {
        try {
          const { data } = await api.put(`/integrations/clients/${clientId}/app-notifications/webhook`, { endpointUrl: endpoint });
          // Shown until dismissed; a save that rotates nothing keeps it.
          if (data?.signing_secret) setSecretState({ clientId, value: data.signing_secret, copied: false });
          stored = {
            ...state,
            webhook: {
              previous_valid_until: state.webhook?.previous_valid_until ?? null,
              updated_at: state.webhook?.updated_at ?? new Date().toISOString(),
              endpoint_url: typeof data?.endpoint_url === "string" ? data.endpoint_url : endpoint,
              config_revision: typeof data?.config_revision === "number" ? data.config_revision : state.webhook?.config_revision ?? 0,
              enabled: typeof data?.enabled === "boolean" ? data.enabled : true,
            },
          };
        } catch (error: unknown) {
          onError(apiErrorMessage(error, formatMessage({ id: "settings.connectedApps.appNotifications.failedSaveEndpoint" })));
          return;
        }
      } else {
        try {
          const { data } = await api.delete(`/integrations/clients/${clientId}/app-notifications/webhook`);
          setSecretState(null);
          onConfigurationOpenChange?.(false);
          stored = {
            ...state,
            webhook: state.webhook
              ? {
                  ...state.webhook,
                  enabled: false,
                  config_revision: typeof data?.config_revision === "number" ? data.config_revision : state.webhook.config_revision,
                }
              : null,
          };
        } catch (error: unknown) {
          onError(apiErrorMessage(error, formatMessage({ id: "settings.connectedApps.appNotifications.failedDisableEndpoint" })));
          return;
        }
      }
      onStateChange(stored);
      setEnabledDraft(null);
      setEndpointDraft(null);
      flashSaved();
      await refresh();
    } catch (error: unknown) {
      onError(apiErrorMessage(error, formatMessage({ id: "settings.connectedApps.failedLoadAppNotifications" })));
    } finally {
      setBusy(null);
    }
  }, [canSave, checked, clientId, endpoint, flashSaved, formatMessage, onConfigurationOpenChange, onError, onStateChange, refresh, state]);

  const dismissSecret = useCallback(() => setSecretState(null), []);

  const rotateSecret = useCallback(async () => {
    if (!clientId) return;
    setBusy("rotate");
    onError("");
    try {
      const { data } = await withSecondFactorStepUp(() => api.post(`/integrations/clients/${clientId}/app-notifications/webhook/rotate-secret`), "secret");
      setSecretState({ clientId, value: data.signing_secret, copied: false });
      await refresh();
    } catch (error: unknown) {
      if (isSecondFactorStepUpCancelled(error)) return;
      onError(apiErrorMessage(error, formatMessage({ id: "settings.connectedApps.appNotifications.failedRotateSecret" })));
    } finally {
      setBusy(null);
    }
  }, [clientId, formatMessage, onError, refresh]);

  // Rotating makes the secret the app checks events with stop working at
  // once, so it asks first, as Regenerate client secret does (Raft DS ›
  // Forms, "When a change takes effect").
  const askRotateSecret = useCallback(() => setConfirmingRotate(true), []);
  const closeRotateSecret = useCallback(() => setConfirmingRotate(false), []);

  const handleEnabledChange = useCallback((next: boolean) => {
    if (!clientId) return;
    setSavedFlash(false);
    setEnabledDraft({ clientId, sourceEnabled: webhookEnabled, checked: next });
    onConfigurationOpenChange?.(next);
  }, [clientId, onConfigurationOpenChange, webhookEnabled]);

  const handleEndpointChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setSavedFlash(false);
    setEndpointDraft({
      clientId,
      sourceEndpoint,
      value: event.target.value,
    });
  }, [clientId, sourceEndpoint]);

  const copySecret = useCallback(async () => {
    if (!signingSecret) return;
    try {
      await navigator.clipboard.writeText(signingSecret);
      setSecretState((current) => current?.clientId === clientId
        ? { ...current, copied: true }
        : current);
    } catch (error: unknown) {
      onError(apiErrorMessage(error, formatMessage({ id: "settings.connectedApps.appNotifications.failedCopySecret" })));
    }
  }, [clientId, formatMessage, onError, signingSecret]);

  const showConfiguration = checked && !!clientId;
  // Save shows while there is something it can save: the endpoint of a checked
  // box, or turning off a webhook that is still on.
  // After a save it also stays for its "Saved", including a disable.
  const showSave = !!clientId && (checked || webhookEnabled || savedFlash);
  const disabled = !clientId || loading || !state || !!busy;

  return (
    <section className="stack-y-4" data-testid="developer-app-notifications">
      {!embedded ? <Separator className="mb-4" /> : null}
      {!embedded ? (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <Bell size={18} className="mt-0.5 shrink-0 text-foreground-muted" />
            <div className="min-w-0">
              <AppNotificationsEyebrow />
            </div>
          </div>
          {loading ? <Badge appearance="soft">{formatMessage({ id: "common.loadingLabel" })}</Badge> : statusBadge(state, formatMessage)}
        </div>
      ) : null}
      <div className="stack-y-2" data-testid="app-notifications-delivery">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-subhead font-semibold text-foreground">{formatMessage({ id: "settings.connectedApps.appNotifications.deliveryTitle" })}</div>
          </div>
          {embedded ? (loading ? <Badge appearance="soft">{formatMessage({ id: "common.loadingLabel" })}</Badge> : statusBadge(state, formatMessage)) : null}
        </div>
        <Card className={INSET_GROUP}>
          <div className="stack-y-3 px-4 py-4">
            <Field>
              <FieldItem>
                <Checkbox
                  id={enabledId}
                  checked={checked}
                  onCheckedChange={handleEnabledChange}
                  disabled={disabled}
                  data-testid="app-notifications-enabled-checkbox"
                />
                <div className="min-w-0">
                  <FieldLabel htmlFor={enabledId} id={`${enabledId}-label`}>
                    {formatMessage({ id: "settings.connectedApps.appNotifications.enableTitle" })}
                  </FieldLabel>
                  {!clientId ? (
                    <span className="text-caption text-foreground-hint">{formatMessage({ id: "settings.connectedApps.appNotifications.saveBeforeWebhook" })}</span>
                  ) : null}
                </div>
              </FieldItem>
            </Field>
            {showConfiguration ? (
              <div className="stack-y-3" data-testid="app-notifications-configuration">
                <label className="block min-w-0">
                  <span className="mb-1.5 block text-footnote font-semibold text-foreground-muted">{formatMessage({ id: "settings.connectedApps.appNotifications.httpsEndpoint" })}</span>
                  <Input
                    type="url"
                    value={endpoint}
                    onChange={handleEndpointChange}
                    disabled={!!busy}
                    className="w-full font-mono text-mono-code"
                    render={<input placeholder="https://example.com/raft/events" />}
                  />
                </label>
                <div className="flex flex-wrap items-center justify-between gap-2 text-footnote text-foreground-muted">
                  <span>{webhookEnabled
                    ? formatMessage({ id: "settings.connectedApps.appNotifications.enabledRevision" }, { revision: state?.webhook?.config_revision ?? 0 })
                    : formatMessage({ id: "settings.connectedApps.appNotifications.enterEndpointToEnable" })}</span>
                  {webhookEnabled ? (
                    <Button type="button" size="md" onClick={askRotateSecret} disabled={!!busy} data-testid="app-notifications-rotate-secret">
                      <RefreshCw size={16} /> {busy === "rotate" ? formatMessage({ id: "settings.connectedApps.appNotifications.rotating" }) : formatMessage({ id: "settings.connectedApps.appNotifications.rotateSecret" })}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {/* The one-time secret stays until it is dismissed, whatever the box shows. The banner says it's shown
                once (its title); the secret itself is data, so it sits under the banner, not in its message. */}
            {signingSecret ? (
              <div className="stack-y-2" data-testid="app-notifications-secret">
              <Banner
                intent="success"
                density="sm"
                live={false}
                data-testid="app-notifications-secret-reveal"
                onClose={dismissSecret}
                closeLabel={formatMessage({ id: "common.announcement.dismiss" })}
                icon={<KeyRound size={16} aria-hidden="true" />}
                title={formatMessage({ id: "settings.connectedApps.appNotifications.signingSecretShownOnce" })}
              />
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center" data-testid="app-notifications-secret-value">
                <code className="min-w-0 flex-1 break-all rounded-control border border-line-hairline bg-layer-code px-3 py-2 font-mono text-mono-code text-foreground">{signingSecret}</code>
                <Button type="button" size="md" onClick={copySecret}>
                  {secretState?.copied ? <Check size={16} /> : <Copy size={16} />} {secretState?.copied ? formatMessage({ id: "settings.connectedApps.appNotifications.copied" }) : formatMessage({ id: "settings.connectedApps.appNotifications.copy" })}
                </Button>
              </div>
              </div>
            ) : null}
            {!checked && webhookEnabled ? (
              <div className="text-footnote text-foreground-muted" data-testid="app-notifications-disable-pending">
                {formatMessage({ id: "settings.connectedApps.appNotifications.saveToStop" })}
              </div>
            ) : null}
            {showSave ? (
              <div>
                <Button
                  type="button"
                  size="md"
                  variant={savedFlash ? "success" : "accent"}
                  onClick={save}
                  disabled={!!busy || loading || !state || !canSave}
                  data-testid="app-notifications-save"
                >
                  {busy === "save"
                    ? formatMessage({ id: "settings.common.saving" })
                    : savedFlash
                      ? <><Check size={16} aria-hidden="true" /> {formatMessage({ id: "settings.common.saved" })}</>
                      : formatMessage({ id: "settings.common.save" })}
                </Button>
              </div>
            ) : null}
          </div>
        </Card>
      </div>
      {showConfiguration ? (
        <div className="stack-y-3" data-testid="app-notifications-permissions">
          <div>
            <div className="text-subhead font-semibold text-foreground">{formatMessage({ id: "settings.connectedApps.appNotifications.permissionsTitle" })}</div>
          </div>
          <AppNotificationPermissionPicker value={value} onChange={onChange} section="events" disabled={loading || !state} />
          {state?.pending_revision ? (
            <Banner intent="warning" density="sm" live={false}>
              {formatMessage(
                { id: "settings.connectedApps.appNotifications.revisionPendingReview" },
                { revision: state.pending_revision.revision },
              )}
            </Banner>
          ) : null}
        </div>
      ) : null}
      {confirmingRotate ? (
        <ConfirmDialog
          title={formatMessage({ id: "settings.connectedApps.appNotifications.rotateSecretConfirmTitle" })}
          message={formatMessage({ id: "settings.connectedApps.appNotifications.rotateSecretConfirmMessage" })}
          confirmLabel={formatMessage({ id: "settings.connectedApps.appNotifications.rotateSecret" })}
          loadingLabel={formatMessage({ id: "settings.connectedApps.appNotifications.rotating" })}
          confirmIcon={<AlertTriangle size={14} />}
          confirmVariant="warning"
          confirmTestId="app-notifications-rotate-secret-confirm"
          analyticsDialog="app_notifications_rotate_secret"
          layer={1}
          onClose={closeRotateSecret}
          onConfirm={rotateSecret}
        />
      ) : null}
    </section>
  );
}

function ScopeChips({ values, empty }: { values: readonly string[]; empty: string }) {
  if (values.length === 0) return <span className="text-footnote text-foreground-hint">{empty}</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => <Badge key={value} appearance="soft">{value}</Badge>)}
    </div>
  );
}

// One fact row of an inset group (DS PropertyList inside rf-list--inset): the
// label on the left (stacked above on narrow widths), its scope chips on the right.
function ScopeRow({ label, values, empty }: { label: string; values: readonly string[]; empty: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="text-footnote font-medium text-foreground-hint sm:w-44 sm:shrink-0 sm:py-0.5">{label}</div>
      <div className="min-w-0 flex-1">
        <ScopeChips values={values} empty={empty} />
      </div>
    </div>
  );
}

export function AppNotificationRequestSummary({
  groups,
  events,
  pendingGroups,
  pendingEvents,
  reviewPending = false,
}: {
  groups: readonly AppNotificationGroup[];
  events: readonly AppNotificationEvent[];
  pendingGroups?: readonly AppNotificationGroup[];
  pendingEvents?: readonly AppNotificationEvent[];
  reviewPending?: boolean;
}) {
  const { formatMessage } = useIntl();
  const shownGroups = reviewPending && pendingGroups ? pendingGroups : groups;
  const shownEvents = reviewPending && pendingEvents ? pendingEvents : events;
  const groupLabels = useMemo(
    () => shownGroups.map((group) => permissionGroupLabel(group, formatMessage)),
    [formatMessage, shownGroups],
  );
  const eventLabels = useMemo(
    () => shownEvents.map((event) => formatMessage({ id: EVENT_LABEL_ID[event] })),
    [formatMessage, shownEvents],
  );
  return (
    <section className="stack-y-3" data-testid="app-notifications-request-summary">
      <Separator className="mb-4" />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <Bell size={18} className="mt-0.5 shrink-0 text-foreground-muted" />
          <div>
            <AppPermissionsEyebrow />
            <div className="mt-1 text-footnote text-foreground-muted">
              {formatMessage({
                id: reviewPending
                  ? "settings.connectedApps.appNotifications.requestPendingDescription"
                  : "settings.connectedApps.appNotifications.requestApprovedDescription",
              })}
            </div>
          </div>
        </div>
        {reviewPending ? <Badge appearance="soft" variant="warning">{formatMessage({ id: "settings.connectedApps.appNotifications.permissionUpdatePending" })}</Badge> : null}
      </div>
      <Card className={INSET_GROUP}>
        <ScopeRow
          label={formatMessage({ id: reviewPending ? "settings.connectedApps.appNotifications.requestedDataGroups" : "settings.connectedApps.appNotifications.dataGroups" })}
          values={groupLabels}
          empty={formatMessage({ id: "settings.connectedApps.appNotifications.noDataAccess" })}
        />
        <ScopeRow
          label={formatMessage({ id: reviewPending ? "settings.connectedApps.appNotifications.requestedNotificationEvents" : "settings.connectedApps.appNotifications.notificationEvents" })}
          values={eventLabels}
          empty={formatMessage({ id: "settings.connectedApps.appNotifications.noEvents" })}
        />
      </Card>
    </section>
  );
}

export function InstalledAppNotifications({
  clientId,
  service,
  canManage,
  promptTextConsent = false,
  onError,
  onApprovalUpdated,
}: {
  clientId: string;
  /** The app's client id, as agents call it (`--service`). */
  service?: string;
  canManage: boolean;
  /** app_prompt_text_consent on this Server. Off: exactly the permissions view. */
  promptTextConsent?: boolean;
  onError: (message: string) => void;
  /** Refresh installed-list permission/text notices after a successful approval. */
  onApprovalUpdated?: () => Promise<void> | void;
}) {
  const { formatMessage } = useIntl();
  const [state, setState] = useState<AppNotificationsInstallationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/integrations/marketplace/${clientId}/install/app-notifications`);
      setState(data);
    } catch (error: unknown) {
      onError(apiErrorMessage(error, formatMessage({ id: "settings.connectedApps.appNotifications.failedLoadInstalled" })));
    } finally {
      setLoading(false);
    }
  }, [clientId, formatMessage, onError]);
  // Load once per app; parent re-renders (a new `onError`, a locale switch) must not refetch.
  const loadForClient = useEffectEvent(load);

  useEffect(() => {
    void loadForClient();
  }, [clientId]);

  // The text this app adds to agent prompts: what this Server confirmed (agents
  // use it) and the app's current text, which Approve Update also confirms.
  const promptText = promptTextConsent ? readInstalledAppPromptTextState(state) : null;
  const pendingText = promptText?.confirmationRequired ? promptText.current : null;
  // The text this detail shows as current; every grant binds to it, so a text
  // change that landed after the page loaded is caught even when only the
  // permissions looked updated.
  const shownTextRevisionId = promptText?.current?.id ?? null;
  const promptTextService = service ?? null;

  const save = useCallback(async () => {
    if (!state) return;
    setSaving(true);
    onError("");
    try {
      // Approving the app's update needs a sign-in that passed the second step.
      await withSecondFactorStepUp(() => api.put(
        `/integrations/marketplace/${clientId}/install/app-notifications/grant`,
        {
          ...expectedAppPermissionsBody(state.requested_scopes ?? [], state.requested_groups),
          ...expectedTextRevisionBody(shownTextRevisionId),
        },
      ), "appAccess");
      await load();
      await onApprovalUpdated?.();
    } catch (error: unknown) {
      // "Verify it's you" closed: nothing changed, nothing to report.
      if (isSecondFactorStepUpCancelled(error)) return;
      if (shownTextRevisionId && appTextChangedCurrent(error, shownTextRevisionId)) {
        // Reread the installation: its confirmed and current text, in place.
        await load();
        onError(formatMessage({ id: "appPromptText.textChanged" }));
        return;
      }
      if (isAppPermissionsChangedError(error)) {
        await load();
        onError(formatMessage({ id: "settings.connectedApps.permissionsChanged" }));
        return;
      }
      if (isExpectedPermissionsRequiredError(error)) {
        onError(formatMessage({ id: "appPermissionSet.reloadRequired" }));
        return;
      }
      onError(apiErrorMessage(error, formatMessage({ id: "settings.connectedApps.appNotifications.failedUpdateInstalled" })));
    } finally {
      setSaving(false);
    }
  }, [clientId, formatMessage, load, onError, onApprovalUpdated, shownTextRevisionId, state]);

  const formatGroups = useCallback(
    (groups: readonly AppNotificationGroup[] | undefined) =>
      (groups ?? []).map((group) => permissionGroupLabel(group, formatMessage)),
    [formatMessage],
  );
  const formatEvents = useCallback(
    (events: readonly AppNotificationEvent[] | undefined) =>
      (events ?? []).map((event) => formatMessage({ id: EVENT_LABEL_ID[event] })),
    [formatMessage],
  );
  const approvedGroupLabels = useMemo(() => formatGroups(state?.approved_groups), [formatGroups, state?.approved_groups]);
  const subscribedEventLabels = useMemo(() => formatEvents(state?.subscribed_events), [formatEvents, state?.subscribed_events]);
  const effectiveEventLabels = useMemo(() => formatEvents(state?.effective_events), [formatEvents, state?.effective_events]);
  const newlyRequestedGroups = useMemo(
    () => (state?.requested_groups ?? []).filter((group) => !state?.approved_groups.includes(group)),
    [state?.approved_groups, state?.requested_groups],
  );

  if (loading) return <div className="text-footnote text-foreground-hint"><Separator className="mb-3" />{formatMessage({ id: "settings.connectedApps.appNotifications.loading" })}</div>;
  if (!state) return null;

  return (
    <section className="stack-y-3" data-testid="installed-app-notifications">
      <Separator className="mb-4" />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <Bell size={18} className="mt-0.5 shrink-0 text-foreground-muted" />
          <div>
            <AppPermissionsEyebrow />
          </div>
        </div>
        {state.effective_groups.length > 0 ? <Badge appearance="soft" variant="success">{formatMessage({ id: "settings.connectedApps.appNotifications.enabled" })}</Badge> : <Badge appearance="soft" variant="muted">{formatMessage({ id: "settings.connectedApps.appNotifications.disabled" })}</Badge>}
      </div>
      {state.app_review_pending ? <Badge appearance="soft" variant="warning">{formatMessage({ id: "settings.connectedApps.appNotifications.appReviewPending" })}</Badge> : null}
      <Card className={INSET_GROUP}>
        <ScopeRow
          label={formatMessage({ id: "settings.connectedApps.appNotifications.approvedData" })}
          values={approvedGroupLabels}
          empty={formatMessage({ id: "settings.connectedApps.appNotifications.noDataAccessEmpty" })}
        />
        <ScopeRow
          label={formatMessage({ id: "settings.connectedApps.appNotifications.developerSubscriptions" })}
          values={subscribedEventLabels}
          empty={formatMessage({ id: "settings.connectedApps.appNotifications.noSubscriptions" })}
        />
        <ScopeRow
          label={formatMessage({ id: "settings.connectedApps.appNotifications.activeEvents" })}
          values={effectiveEventLabels}
          empty={formatMessage({ id: "settings.connectedApps.appNotifications.noActiveEvents" })}
        />
      </Card>
      {state.approval_required ? (
        <Banner
          intent="warning"
          density="sm"
          live={false}
          data-testid="app-notifications-approval-required"
          actions={canManage ? (
            <Button type="button" size="md" variant="outline" className="shrink-0" onClick={save} disabled={saving}>
              {saving ? formatMessage({ id: "settings.connectedApps.appNotifications.approving" }) : formatMessage({ id: "settings.connectedApps.appNotifications.approveUpdate" })}
            </Button>
          ) : undefined}
        >
          <div className="min-w-0 stack-y-2">
            <div>{formatMessage({ id: "settings.connectedApps.appNotifications.newDataAccessNotice" })}</div>
            {/* The whole set Approve Update sends back and records,
                with what it adds marked New — not only the additions. */}
            <div>{formatMessage({ id: "settings.connectedApps.appNotifications.approveRecordsAll" })}</div>
            <AppPermissionSetList
              scopes={state.requested_scopes}
              groups={state.requested_groups}
              newScopes={state.new_scopes}
              newGroups={newlyRequestedGroups}
            />
            {pendingText ? (
              <>
                <div>{formatMessage({ id: "appPromptText.installedNotice" })}</div>
                <div>{formatMessage({ id: "appPromptText.approveAlsoConfirms" })}</div>
                <AppPromptTextComparison
                  before={promptText?.confirmed ?? null}
                  after={pendingText}
                  beforeTitle={formatMessage({ id: "appPromptText.agentsUseNow" })}
                  afterTitle={formatMessage({ id: "appPromptText.pendingTitle" })}
                  service={promptTextService}
                />
              </>
            ) : null}
          </div>
        </Banner>
      ) : pendingText ? (
        // Only the text changed: the same Approve Update confirms it.
        <Banner
          intent="warning"
          density="sm"
          live={false}
          data-testid="app-prompt-text-confirmation-required"
          actions={canManage ? (
            <Button type="button" size="md" variant="outline" className="shrink-0" onClick={save} disabled={saving}>
              {saving ? formatMessage({ id: "settings.connectedApps.appNotifications.approving" }) : formatMessage({ id: "settings.connectedApps.appNotifications.approveUpdate" })}
            </Button>
          ) : undefined}
        >
          <div className="min-w-0 stack-y-2">
            <div>{formatMessage({ id: "appPromptText.installedNotice" })}</div>
            <AppPromptTextComparison
              before={promptText?.confirmed ?? null}
              after={pendingText}
              beforeTitle={formatMessage({ id: "appPromptText.agentsUseNow" })}
              afterTitle={formatMessage({ id: "appPromptText.pendingTitle" })}
              service={promptTextService}
            />
          </div>
        </Banner>
      ) : promptText?.confirmed ? (
        <div className="stack-y-2" data-testid="app-prompt-text-confirmed">
          <div className="text-footnote font-semibold text-foreground">{formatMessage({ id: "appPromptText.title" })}</div>
          <div className="text-footnote text-foreground-muted">{formatMessage({ id: "appPromptText.installNote" })}</div>
          <AppPromptTextBlock fields={promptText.confirmed} service={promptTextService} />
        </div>
      ) : null}
    </section>
  );
}
