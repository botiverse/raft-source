import {
  Badge,
  Button,
  Card,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
  Separator,
  Spinner,
  Textarea,
  TextLink,
  ListRowGroup,
} from "@botiverse/raft-ui";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { CheckCircle2, ChevronDown, KeyRound, Pencil, Plus, Power, RefreshCw, Send, Trash2, XCircle } from "lucide-react";
import { useIntl } from "react-intl";
import {
  PI_BUILTIN_PROVIDER_DEFAULT_MODELS,
  PI_BUILTIN_PROVIDER_MODELS,
  providerProbeRequestDigest,
} from "@botiverse/raft-shared";
import type {
  ProviderConnectionAssignedAgent,
  ProviderConnectionAssignedAgentList,
  ProviderConnectionLatestVerified,
  ProviderConnectionProviderId,
  ProviderConnectionProviderOption,
  ProviderConnectionSummary,
  ProviderProbeCreatedView,
} from "@botiverse/raft-shared";
import api from "../../api/client";
import { useProviderConnections } from "../../hooks/useProviderConnections";
import { useAuthStore } from "../../store/authStore";
import { useMachineStore } from "../../store/machineStore";
import { orderMachinesLikeSidebar } from "../layout/sidebarMachineOrder";
import { useProfileStore } from "../../store/profileStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import Tooltip from "../ui/Tooltip";
import Banner from "../ui/Banner";
import DialogCard from "../ui/DialogCard";
import EmptyState from "../ui/EmptyState";
import FormField from "../ui/FormField";
import SectionEyebrow from "../ui/SectionEyebrow";
import SectionHeader from "../ui/SectionHeader";
import EditProviderConnectionModal from "./EditProviderConnectionModal";
import { ManagedConnectionRow } from "./ManagedConnectionRow";
import { AssignedAgentRow } from "./AssignedAgentRow";
import { DialogCardFooter, DialogCommit } from "../ui/NarrowDialog";
import { useLocalComputerMachineId } from "../machine/localComputer/localComputerStore";

function labelForProviderId(
  providerId: ProviderConnectionProviderId,
  providerOptions: ProviderConnectionProviderOption[],
): string {
  return providerOptions.find((entry) => entry.id === providerId)?.label ?? providerId;
}

function isGatewayProviderId(
  providerId: ProviderConnectionProviderId,
  providerOptions: ProviderConnectionProviderOption[],
): boolean {
  return providerOptions.find((entry) => entry.id === providerId)?.providerKind === "gateway";
}

const CUSTOM_MODEL_SELECT_VALUE = "__custom__";

/** Raft Design System status chips: ok is lime, a problem is orange, neutral or off is stone. */
type ConnectionStatusBadgeVariant = "success" | "warning" | "muted";

const CONNECTION_STATUS_BADGE_VARIANT: Record<ProviderConnectionSummary["status"], ConnectionStatusBadgeVariant> = {
  ready: "success",
  unchecked: "muted",
  pending_auth: "muted",
  error: "warning",
  expired: "warning",
};

function presetTestModels(providerId: ProviderConnectionProviderId): string[] {
  const prefix = `${providerId}/`;
  return (PI_BUILTIN_PROVIDER_MODELS[providerId] ?? []).map((model) => (
    model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id
  ));
}

function defaultTestModel(providerId: ProviderConnectionProviderId): string {
  const value = (PI_BUILTIN_PROVIDER_DEFAULT_MODELS as Partial<Record<ProviderConnectionProviderId, string>>)[providerId];
  const prefix = `${providerId}/`;
  return value?.startsWith(prefix) ? value.slice(prefix.length) : value ?? "";
}

export default function ProviderConnectionsSettings() {
  const { formatMessage } = useIntl();
  const { capabilities } = useServerPermissions();
  const openProfile = useProfileStore((s) => s.openProfile);
  const { connections, providerOptions, loading, error, refresh, featureEnabled } = useProviderConnections();
  // The legacy server-side test button retires exactly when the AI provider
  // feature (single switch) is on; enforcement follows the same key.
  const legacyTestVisible = !featureEnabled;
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProviderConnectionSummary | null>(null);
  const [testing, setTesting] = useState<ProviderConnectionSummary | null>(null);
  const [verifying, setVerifying] = useState<ProviderConnectionSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  const run = useCallback(async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setActionError("");
    try {
      await action();
      await refresh();
    } catch {
      setActionError(formatMessage({ id: "settings.providers.actionError" }));
      await refresh();
    } finally {
      setBusyId(null);
    }
  }, [formatMessage, refresh]);

  const openAgent = useCallback((agentId: string) => openProfile("agent", agentId), [openProfile]);
  const openCreate = useCallback(() => setCreating(true), []);
  const closeCreate = useCallback(() => setCreating(false), []);
  const handleCreated = useCallback(async () => {
    setCreating(false);
    await refresh();
  }, [refresh]);
  const closeEdit = useCallback(() => setEditing(null), []);
  const handleEdited = useCallback(async () => {
    setEditing(null);
    await refresh();
  }, [refresh]);
  const closeVerify = useCallback(() => setVerifying(null), []);
  const closeTest = useCallback(() => setTesting(null), []);
  const handleTested = useCallback(async () => {
    setTesting(null);
    await refresh();
  }, [refresh]);

  if (!featureEnabled) return null;

  return (
    <div id="ai-providers" className="mx-auto max-w-3xl stack-y-4" data-testid="provider-connections-settings">
      {/* In a narrow settings column Add wraps under the title instead of
          pushing it off the row. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeader className="min-w-0" label={formatMessage({ id: "settings.providers.sectionTitle" })} icon={<KeyRound size={16} />} />
        {capabilities.manageExternalAuth && (
          <Button type="button" variant="primary" size="md" disabled={providerOptions.length === 0} onClick={openCreate}>
            <Plus size={16} />
            {formatMessage({ id: "settings.providers.add" })}
          </Button>
        )}
      </div>
      <p className="text-footnote text-foreground-muted">{formatMessage({ id: "settings.providers.description" })}</p>

      {(error || actionError) && (
        <Banner intent="warning" density="sm">
          {actionError || formatMessage({ id: "settings.providers.loadError" })}
        </Banner>
      )}

      {loading ? (
        <div className="flex min-h-32 items-center justify-center"><Spinner size="md"  aria-label={formatMessage({ id: "common.loadingLabel" })} /></div>
      ) : connections.length === 0 ? (
        <EmptyState
          icon={<KeyRound size={36} />}
          title={formatMessage({ id: "settings.providers.empty" })}
        />
      ) : (
        <Card>
          {connections.map((connection, index) => (
            <Fragment key={connection.id}>
            {index > 0 ? <Separator /> : null}
            <ManagedConnectionRow
              connection={connection}
              providerOptions={providerOptions}
              canManage={capabilities.manageExternalAuth}
              legacyTestVisible={legacyTestVisible}
              busy={busyId === connection.id}
              run={run}
              onTestConnection={setTesting}
              onEditConnection={setEditing}
              onVerifyConnection={setVerifying}
              onOpenAgent={openAgent}
            />
            </Fragment>
          ))}
        </Card>
      )}

      {creating && (
        <CreateProviderConnectionModal
          providerOptions={providerOptions}
          onClose={closeCreate}
          onCreated={handleCreated}
        />
      )}
      {editing && (
        <EditProviderConnectionModal
          key={editing.id}
          connection={editing}
          providerOptions={providerOptions}
          onClose={closeEdit}
          onCompleted={handleEdited}
        />
      )}
      {verifying && (
        <VerifyProviderConnectionModal
          connection={verifying}
          onClose={closeVerify}
        />
      )}
      {testing && (
        <ProviderConnectionTestModal
          key={testing.id}
          connection={testing}
          onClose={closeTest}
          onCompleted={handleTested}
        />
      )}
    </div>
  );
}

export function ConnectionRow({
  connection,
  providerOptions,
  canManage,
  legacyTestVisible,
  busy,
  onTest,
  onEdit,
  onToggle,
  onDelete,
  onOpenAgent,
  onVerify,
  onDetachAgent,
}: {
  connection: ProviderConnectionSummary;
  providerOptions: ProviderConnectionProviderOption[];
  canManage: boolean;
  legacyTestVisible: boolean;
  busy: boolean;
  onTest: () => void;
  onEdit?: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onOpenAgent?: (agentId: string) => void;
  onVerify?: () => void;
  onDetachAgent?: (agentId: string) => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const [expanded, setExpanded] = useState(false);
  const [assignedAgents, setAssignedAgents] = useState<ProviderConnectionAssignedAgent[] | null>(null);
  const [loadingAssignedAgents, setLoadingAssignedAgents] = useState(false);
  const [assignedAgentsError, setAssignedAgentsError] = useState(false);
  const ready = connection.enabled;
  const assigned = connection.assignedAgentCount > 0;
  const deleteDisabledReason = assigned
    ? formatMessage(
      { id: "settings.providers.deleteAssignedHint" },
      { count: connection.assignedAgentCount },
    )
    : "";
  const assignedAgentsId = `provider-connection-${connection.id}-assigned-agents`;

  const loadAssignedAgents = useCallback(async () => {
    setLoadingAssignedAgents(true);
    setAssignedAgentsError(false);
    try {
      const { data } = await api.get<ProviderConnectionAssignedAgentList>(
        `/provider-connections/${connection.id}/agents`,
      );
      setAssignedAgents(Array.isArray(data.agents) ? data.agents : []);
    } catch {
      setAssignedAgentsError(true);
    } finally {
      setLoadingAssignedAgents(false);
    }
  }, [connection.id]);

  // The assignment list is read once per row and reused across collapse/reopen:
  // it is bounded by the Agents of one Server, and the catalog refresh that
  // follows any mutation already re-reads the authoritative count.
  const toggleExpanded = useCallback(() => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (assignedAgents === null && !loadingAssignedAgents) void loadAssignedAgents();
  }, [expanded, assignedAgents, loadingAssignedAgents, loadAssignedAgents]);

  const detachAgent = useCallback(async (agentId: string) => {
    await onDetachAgent?.(agentId);
    await loadAssignedAgents();
  }, [loadAssignedAgents, onDetachAgent]);

  const handleEdit = onEdit;

  return (
    <div data-testid={`provider-connection-${connection.id}`}>
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className={`flex size-[35px] shrink-0 items-center justify-center rounded-control bg-fill-muted ${ready ? "text-foreground-muted" : "text-foreground-hint"}`}>
            {ready ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <div className="min-w-0 truncate text-subhead font-semibold text-foreground">{connection.name}</div>
              <Badge appearance="soft" variant={ready ? CONNECTION_STATUS_BADGE_VARIANT[connection.status] : "muted"}>
                {formatMessage({ id: `settings.providers.status.${connection.status}` })}
              </Badge>
            </div>
            <div className="mt-0.5 text-footnote text-foreground-muted">
              {labelForProviderId(connection.providerId, providerOptions)}
              {" · "}
              {assigned ? (
                <Tooltip content={formatMessage({ id: "settings.providers.assignedAgentsExpand" })}>
                <TextLink
                  variant="strong"
                  className="inline-flex items-center gap-1"
                  aria-expanded={expanded}
                  aria-controls={assignedAgentsId}
                  disabled={busy}
                  onClick={toggleExpanded}
                >
                  {connection.assignedAgentCount === 1
                    ? formatMessage({ id: "settings.providers.agentCountOne" })
                    : formatMessage({ id: "settings.providers.agentCount" }, { count: connection.assignedAgentCount })}
                  <ChevronDown size={14} className={expanded ? "rotate-180" : ""} aria-hidden="true" />
                </TextLink>
                </Tooltip>
              ) : formatMessage({ id: "settings.providers.agentCount" }, { count: 0 })}
            </div>
          </div>
        </div>
        {canManage && (
          <div className="flex shrink-0 items-center gap-2">
            {legacyTestVisible && (
              <Button type="button" variant="outline" size="icon-md" aria-label={formatMessage({ id: "settings.providers.test" })} disabled={busy} onClick={onTest}><Send size={16} /></Button>
            )}
            {onVerify && (
              <Button
                type="button"
                variant="outline"
                size="icon-md"
                aria-label={formatMessage({ id: "settings.providers.verify" })}
                disabled={busy}
                onClick={onVerify}
              >
                <Send size={16} />
              </Button>
            )}
            {handleEdit && (
              <Button type="button" variant="outline" size="icon-md" aria-label={formatMessage({ id: "settings.providers.edit" })} disabled={busy} onClick={handleEdit}><Pencil size={16} /></Button>
            )}
            <Button type="button" variant="outline" size="icon-md" aria-label={connection.enabled ? formatMessage({ id: "settings.providers.disable" }) : formatMessage({ id: "settings.providers.enable" })} disabled={busy} onClick={onToggle}><Power size={16} /></Button>
            <Tooltip content={deleteDisabledReason || formatMessage({ id: "settings.providers.delete" })}>
            <Button
              type="button"
              size="icon-md"
              variant="danger"
              data-slot="button"
              // Keep the "disabled but focusable, with a reason" shape: RUI's
              // Button does not land aria-disabled on its own, so the render
              // element carries it (and the recipe draws its disabled look).
              render={<button aria-disabled={deleteDisabledReason ? true : undefined} />}
              aria-label={formatMessage({ id: "settings.providers.delete" })}
              aria-description={deleteDisabledReason || undefined}
              disabled={busy}
              onClick={deleteDisabledReason ? undefined : onDelete}
            >
              <Trash2 size={16} />
            </Button>
            </Tooltip>
          </div>
        )}
      </div>
      {connection.latestVerified && <VerifiedOnChip latestVerified={connection.latestVerified} />}
      {expanded && assigned && (
        <AssignedAgentsPanel
          panelId={assignedAgentsId}
          agents={assignedAgents}
          loading={loadingAssignedAgents}
          error={assignedAgentsError}
          canManage={canManage}
          busy={busy}
          onRetry={loadAssignedAgents}
          onOpenAgent={onOpenAgent}
          onDetachAgent={detachAgent}
        />
      )}
    </div>
  );
}

/**
 * Names the Agents holding this connection so a blocked delete is recoverable:
 * an active Agent links to the existing Agent surface that owns its provider,
 * while a soft-deleted Agent — which can no longer be edited — offers detach.
 */
function AssignedAgentsPanel({
  panelId,
  agents,
  loading,
  error,
  canManage,
  busy,
  onRetry,
  onOpenAgent,
  onDetachAgent,
}: {
  panelId: string;
  agents: ProviderConnectionAssignedAgent[] | null;
  loading: boolean;
  error: boolean;
  canManage: boolean;
  busy: boolean;
  onRetry: () => void;
  onOpenAgent?: (agentId: string) => void;
  onDetachAgent: (agentId: string) => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const listed = agents ?? [];
  return (
    <div
      id={panelId}
      className="border-t border-line-hairline px-4 py-3"
      data-testid="provider-connection-assigned-agents"
    >
      <SectionEyebrow as="div">
        {formatMessage({ id: "settings.providers.assignedAgents" })}
      </SectionEyebrow>
      <p className="mt-1 text-footnote text-foreground-muted">
        {formatMessage({ id: "settings.providers.assignedAgentsUnblockHint" })}
      </p>
      {loading ? (
        <div className="mt-2 flex items-center gap-2 text-callout text-foreground-muted">
          <Spinner size="sm" aria-hidden="true" />
          {formatMessage({ id: "settings.providers.assignedAgentsLoading" })}
        </div>
      ) : error ? (
        <Banner
          className="mt-2"
          intent="warning"
          density="sm"
          actions={(
            <Button type="button" variant="outline" size="md" disabled={busy} onClick={onRetry}>
              <RefreshCw size={16} />
              {formatMessage({ id: "settings.providers.assignedAgentsRetry" })}
            </Button>
          )}
        >
          {formatMessage({ id: "settings.providers.assignedAgentsError" })}
        </Banner>
      ) : listed.length === 0 ? (
        <p className="mt-2 text-callout text-foreground-muted">
          {formatMessage({ id: "settings.providers.assignedAgentsEmpty" })}
        </p>
      ) : (
        // DS ListRow › `rf-list--inset`: one card, hairlines between rows.
        <ListRowGroup render={<ul />} className="mt-2">
          {listed.map((agent) => (
            <AssignedAgentRow
              key={agent.id}
              agent={agent}
              canManage={canManage}
              busy={busy}
              onOpenAgent={onOpenAgent}
              onDetachAgent={onDetachAgent}
            />
          ))}
        </ListRowGroup>
      )}
    </div>
  );
}

function ProviderConnectionTestModal({
  connection,
  onClose,
  onCompleted,
}: {
  connection: ProviderConnectionSummary;
  onClose: () => void;
  onCompleted: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const [model, setModel] = useState(defaultTestModel(connection.providerId));
  const [message, setMessage] = useState(() => formatMessage({ id: "settings.providers.testMessageDefault" }));
  const [models, setModels] = useState(() => presetTestModels(connection.providerId));
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [customModelMode, setCustomModelMode] = useState(() => {
    const presets = presetTestModels(connection.providerId);
    const initial = defaultTestModel(connection.providerId);
    return presets.length === 0 || (initial.trim().length > 0 && !presets.includes(initial));
  });
  const modelInputId = `provider-connection-${connection.id}-test-model`;
  const modelSelectId = `provider-connection-${connection.id}-test-model-select`;
  const messageInputId = `provider-connection-${connection.id}-test-message`;

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    setModelError("");
    try {
      const response = await api.get<{ models: string[] }>(`/provider-connections/${connection.id}/models`);
      const nextModels = [...new Set([...presetTestModels(connection.providerId), ...response.data.models])];
      setModels(nextModels);
      setModel((current) => {
        if (!current.trim() && nextModels[0]) {
          setCustomModelMode(false);
          return nextModels[0];
        }
        if (nextModels.includes(current)) {
          setCustomModelMode(false);
          return current;
        }
        return current;
      });
    } catch {
      setModelError(formatMessage({ id: "settings.providers.modelsLoadError" }));
    } finally {
      setLoadingModels(false);
    }
  }, [connection.id, connection.providerId, formatMessage]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api.post(`/provider-connections/${connection.id}/test`, { model, message });
      await onCompleted();
    } catch {
      setError(formatMessage({ id: "settings.providers.testError" }));
    } finally {
      setSubmitting(false);
    }
  };

  const isCustom = customModelMode || (model.trim().length > 0 && !models.includes(model));
  const selectValue = isCustom ? CUSTOM_MODEL_SELECT_VALUE : model;
  const modelSelectOptions = useMemo(() => [
    ...models.map((candidate) => ({ value: candidate, label: candidate })),
    { value: CUSTOM_MODEL_SELECT_VALUE, label: formatMessage({ id: "agent.runtimeConfig.custom" }) },
  ], [formatMessage, models]);

  const handleModelSelect = useCallback((nextValue: string | null) => {
    if (nextValue === CUSTOM_MODEL_SELECT_VALUE) {
      setCustomModelMode(true);
      if (models.includes(model)) setModel("");
      return;
    }
    if (nextValue != null) {
      setCustomModelMode(false);
      setModel(nextValue);
    }
  }, [model, models]);
  const handleModelInput = useCallback((event: ChangeEvent<HTMLInputElement>) => setModel(event.target.value), []);
  const handleMessageInput = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setMessage(event.target.value), []);

  return (
    <DialogCard
      onClose={onClose}
      title={formatMessage({ id: "settings.providers.testTitle" }, { name: connection.name })}
      testId="provider-connection-test-dialog"
      narrow="sheet"
    >
      <form onSubmit={submit} className="stack-y-4 md:pointer-fine:stack-y-3" data-testid="provider-connection-test-form">
        <FormField
          label={formatMessage({ id: "settings.providers.testModel" })}
          htmlFor={isCustom || models.length === 0 ? modelInputId : modelSelectId}
        >
          {models.length > 0 ? (
            <Select
              value={selectValue}
              onValueChange={handleModelSelect}
              items={modelSelectOptions}
            >
              <SelectTrigger
                id={modelSelectId}
                className="w-full"
                aria-label={formatMessage({ id: "settings.providers.testModel" })}
              >
                <SelectValue placeholder={formatMessage({ id: "settings.providers.testModel" })} />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  {modelSelectOptions.map((candidate) => (
                    <SelectItem key={candidate.value} value={candidate.value}>
                      <SelectItemText>{candidate.label}</SelectItemText>
                      <SelectItemIndicator />
                    </SelectItem>
                  ))}
                </SelectList>
              </SelectContent>
            </Select>
          ) : null}
          {(isCustom || models.length === 0) && (
            <Input
              id={modelInputId}
              className={`w-full ${models.length > 0 ? "mt-2" : ""}`}
              value={model}
              onChange={handleModelInput}
              placeholder={formatMessage({ id: "agent.runtimeConfig.customModelId" })}
              maxLength={200}
              required
              autoFocus={isCustom}
            />
          )}
        </FormField>
        <div className="flex items-center justify-between gap-3">
          {/* Only the error: no fill-in hint (HelperText step 1); the empty line keeps Refresh at the end. */}
          <p className="text-caption text-danger-strong">{modelError}</p>
          <Button type="button" variant="outline" size="md" disabled={loadingModels || submitting} onClick={loadModels}>
            <RefreshCw size={16} className={loadingModels ? "animate-spin" : ""} />
            {formatMessage({ id: "settings.providers.refreshModels" })}
          </Button>
        </div>
        <FormField
          label={formatMessage({ id: "settings.providers.testMessage" })}
          htmlFor={messageInputId}
        >
          <Textarea
            id={messageInputId}
            className="min-h-28 w-full resize-y"
            value={message}
            onChange={handleMessageInput}
            maxLength={2000}
            required
          />
        </FormField>
        {error && <Banner intent="warning" density="sm">{error}</Banner>}
        <DialogCardFooter>
          <Button size="lg" type="button" variant="ghost" onClick={onClose}>{formatMessage({ id: "settings.common.cancel" })}</Button>
          <DialogCommit>
            {(inHead) => (
              <Button size={inHead ? "md" : "lg"} type="submit" variant="primary" disabled={submitting || !model.trim() || !message.trim()}>
                {submitting ? <Spinner size="sm" aria-hidden="true" /> : <Send size={16} />}
                {formatMessage({ id: "settings.providers.sendTest" })}
              </Button>
            )}
          </DialogCommit>
        </DialogCardFooter>
      </form>
    </DialogCard>
  );
}

function CreateProviderConnectionModal({
  providerOptions,
  onClose,
  onCreated,
}: {
  providerOptions: ProviderConnectionProviderOption[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const [name, setName] = useState("");
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the modal snapshots the schema catalog default when it opens.
  const [providerId, setProviderId] = useState<ProviderConnectionProviderId>(providerOptions[0]?.id ?? "deepseek");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [supportsImageInput, setSupportsImageInput] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const gateway = isGatewayProviderId(providerId, providerOptions);
  const providerSelectItems = useMemo(
    () => providerOptions.map((provider) => ({
      value: provider.id,
      label: provider.label,
    })),
    [providerOptions],
  );
  const handleNameChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setName(event.target.value), []);
  const handleProviderChange = useCallback((value: string | null) => {
    if (value != null) setProviderId(value as ProviderConnectionProviderId);
  }, []);
  const handleEndpointUrlChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setEndpointUrl(event.target.value),
    [],
  );
  const handleApiKeyChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setApiKey(event.target.value), []);
  const handleSupportsImageInputChange = useCallback((checked: boolean) => setSupportsImageInput(checked), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api.post("/provider-connections", {
        name,
        providerId,
        ...(gateway ? { endpointUrl, supportsImageInput } : {}),
        apiKey,
      });
      await onCreated();
    } catch {
      setError(formatMessage({ id: "settings.providers.createError" }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogCard onClose={onClose} title={formatMessage({ id: "settings.providers.createTitle" })} testId="provider-connection-create-dialog" narrow="sheet">
      <form onSubmit={submit} className="stack-y-4 md:pointer-fine:stack-y-3" data-testid="provider-connection-create-form">
        <FormField label={formatMessage({ id: "settings.providers.name" })}>
          <Input className="w-full" value={name} onChange={handleNameChange} maxLength={120} required />
        </FormField>
        <FormField label={formatMessage({ id: "settings.providers.provider" })}>
          <Select
            value={providerId}
            onValueChange={handleProviderChange}
            items={providerSelectItems}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                {providerOptions.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    <SelectItemText>{provider.label}</SelectItemText>
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
        </FormField>
        {gateway && (
          <FormField label={formatMessage({ id: "settings.providers.endpoint" })}>
            <Input className="w-full" type="url" value={endpointUrl} onChange={handleEndpointUrlChange} render={<input placeholder="https://gateway.example.com/v1" />} required />
          </FormField>
        )}
        <FormField label={formatMessage({ id: "settings.providers.apiKey" })} hint={formatMessage({ id: "settings.providers.apiKeyHint" })}>
          <Input className="w-full" type="password" autoComplete="new-password" value={apiKey} onChange={handleApiKeyChange} required />
        </FormField>
        {gateway && (
          <label className="flex items-center gap-2 text-callout font-semibold text-foreground">
            <Checkbox checked={supportsImageInput} onCheckedChange={handleSupportsImageInputChange} />
            {formatMessage({ id: "settings.providers.imageInput" })}
          </label>
        )}
        {error && <Banner intent="warning" density="sm">{error}</Banner>}
        <DialogCardFooter>
          <Button size="lg" type="button" variant="ghost" onClick={onClose}>{formatMessage({ id: "settings.common.cancel" })}</Button>
          <DialogCommit>
            {(inHead) => (
              <Button size={inHead ? "md" : "lg"} type="submit" variant="primary" disabled={submitting || !name.trim() || !apiKey.trim() || (gateway && !endpointUrl.trim())}>
                {submitting ? <Spinner size="sm" aria-hidden="true" /> : <Plus size={16} />}
                {formatMessage({ id: "settings.providers.create" })}
              </Button>
            )}
          </DialogCommit>
        </DialogCardFooter>
      </form>
    </DialogCard>
  );
}

export const __testInternals = { ConnectionRow, CreateProviderConnectionModal, EditProviderConnectionModal, ProviderConnectionTestModal, VerifyProviderConnectionModal, VerifiedOnChip };

/** Prop-driven chip from the catalog read model: zero extra requests. */
function VerifiedOnChip({ latestVerified }: { latestVerified: ProviderConnectionLatestVerified }) {
  const { formatMessage } = useIntl();
  return (
    <div className="flex flex-wrap gap-2 pb-3 pl-[63px] pr-4" data-testid="provider-connection-verified-on">
      <Tooltip
        content={(
          <span className="font-mono text-mono-meta">
            {`${latestVerified.runtime} · ${latestVerified.model} · ${latestVerified.verifiedAt}`}
          </span>
        )}
      >
      <Badge appearance="soft" variant="success">
        {formatMessage({ id: "settings.providers.verifiedOn" })}
        {" "}
        {latestVerified.computerName ?? <span className="font-mono text-mono-meta">{latestVerified.computerId}</span>}
      </Badge>
      </Tooltip>
    </div>
  );
}

/**
 * Computer-scoped verification modal. Deliberately never auto-closes: the
 * user sees 准备 → 正在 <Computer> 验证 → 成功/失败, the durable coordinates,
 * and (only on this page load) the bounded plain-text model reply.
 */
function VerifyProviderConnectionModal({
  connection,
  onClose,
}: {
  connection: ProviderConnectionSummary;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const machines = useMachineStore((state) => state.machines);
  const pinnedMachineId = useLocalComputerMachineId();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  // Same order as the Computers list (this device, then mine, then the rest).
  const candidates = useMemo(
    () => orderMachinesLikeSidebar(machines.filter((machine) => machine.status === "online" && machine.runtimes.includes("builtin")), pinnedMachineId, userId),
    [machines, pinnedMachineId, userId],
  );
  const [computerId, setComputerId] = useState(candidates[0]?.id ?? "");
  const [model, setModel] = useState(() => defaultTestModel(connection.providerId));
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [result, setResult] = useState<ProviderProbeCreatedView | null>(null);
  const [failure, setFailure] = useState("");
  const computerName = machines.find((machine) => machine.id === computerId)?.name ?? computerId;
  const presetModels = useMemo(() => presetTestModels(connection.providerId), [connection.providerId]);
  const [customModelMode, setCustomModelMode] = useState(() => {
    const initial = defaultTestModel(connection.providerId);
    return presetModels.length === 0 || (initial.trim().length > 0 && !presetModels.includes(initial));
  });
  const isCustom = customModelMode || (model.trim().length > 0 && !presetModels.includes(model));
  const verifyModelInputId = `provider-connection-${connection.id}-verify-model`;
  const verifyModelSelectId = `provider-connection-${connection.id}-verify-model-select`;
  const verifyModelOptions = useMemo(() => [
    ...presetModels.map((candidate) => ({ value: candidate, label: candidate })),
    { value: CUSTOM_MODEL_SELECT_VALUE, label: formatMessage({ id: "agent.runtimeConfig.custom" }) },
  ], [formatMessage, presetModels]);
  const computerSelectItems = useMemo(
    () => candidates.map((machine) => ({
      value: machine.id,
      label: machine.name,
    })),
    [candidates],
  );

  const handleComputerChange = useCallback((value: string | null) => {
    if (value != null) setComputerId(value);
  }, []);
  const handleModelInput = useCallback((event: ChangeEvent<HTMLInputElement>) => setModel(event.target.value), []);
  const handleModelSelect = useCallback((nextValue: string | null) => {
    if (nextValue === CUSTOM_MODEL_SELECT_VALUE) {
      setCustomModelMode(true);
      if (presetModels.includes(model)) setModel("");
      return;
    }
    if (nextValue != null) {
      setCustomModelMode(false);
      setModel(nextValue);
    }
  }, [model, presetModels]);

  const start = useCallback(async () => {
    setPhase("running");
    setFailure("");
    setResult(null);
    try {
      const payload = {
        computerId,
        runtime: "builtin",
        model: model.trim() || defaultTestModel(connection.providerId),
        probeKind: "canary" as const,
      };
      const requestDigest = await providerProbeRequestDigest({ connectionId: connection.id, ...payload });
      const { data } = await api.post<ProviderProbeCreatedView>(`/provider-connections/${connection.id}/probes`, {
        probeRequestId: globalThis.crypto.randomUUID(),
        requestDigest,
        ...payload,
      });
      setResult(data);
      setPhase("done");
    } catch {
      setFailure(formatMessage({ id: "settings.providers.verifyError" }));
      setPhase("done");
    }
  }, [computerId, connection.id, connection.providerId, formatMessage, model]);

  const outcome = result?.probe.outcome ?? null;
  const category = result?.probe.category ?? null;
  return (
    <DialogCard
      onClose={onClose}
      title={formatMessage({ id: "settings.providers.verifyTitle" }, { name: connection.name })}
      testId="provider-connection-verify-dialog"
      narrow="sheet"
    >
      <div className="stack-y-4" data-testid="provider-connection-verify-body">
        <FormField label={formatMessage({ id: "settings.providers.verifyComputer" })}>
          <Select
            value={computerId}
            disabled={phase === "running" || candidates.length === 0}
            onValueChange={handleComputerChange}
            items={computerSelectItems}
          >
            <SelectTrigger
              className="w-full"
              aria-label={formatMessage({ id: "settings.providers.verifyComputer" })}
              disabled={phase === "running" || candidates.length === 0}
            >
              <SelectValue placeholder={formatMessage({ id: "settings.providers.verifyComputer" })} />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                {candidates.map((machine) => (
                  <SelectItem key={machine.id} value={machine.id}>
                    <SelectItemText>{machine.name}</SelectItemText>
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
        </FormField>
        {candidates.length === 0 && (
          <Banner intent="warning" density="sm">{formatMessage({ id: "settings.providers.verifyNoComputers" })}</Banner>
        )}
        <FormField
          label={formatMessage({ id: "settings.providers.verifyModel" })}
          htmlFor={isCustom || presetModels.length === 0 ? verifyModelInputId : verifyModelSelectId}
        >
          {presetModels.length > 0 ? (
            <Select
              value={isCustom ? CUSTOM_MODEL_SELECT_VALUE : model}
              disabled={phase === "running"}
              onValueChange={handleModelSelect}
              items={verifyModelOptions}
            >
              <SelectTrigger
                id={verifyModelSelectId}
                className="w-full"
                aria-label={formatMessage({ id: "settings.providers.verifyModel" })}
                disabled={phase === "running"}
              >
                <SelectValue placeholder={formatMessage({ id: "settings.providers.verifyModel" })} />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  {verifyModelOptions.map((candidate) => (
                    <SelectItem key={candidate.value} value={candidate.value}>
                      <SelectItemText>{candidate.label}</SelectItemText>
                      <SelectItemIndicator />
                    </SelectItem>
                  ))}
                </SelectList>
              </SelectContent>
            </Select>
          ) : null}
          {(isCustom || presetModels.length === 0) && (
            <Input
              id={verifyModelInputId}
              className={`w-full ${presetModels.length > 0 ? "mt-2" : ""}`}
              value={model}
              disabled={phase === "running"}
              onChange={handleModelInput}
              placeholder={formatMessage({ id: "agent.runtimeConfig.customModelId" })}
              maxLength={200}
              required
              autoFocus={isCustom}
            />
          )}
        </FormField>
        {phase === "running" && (
          <p className="text-callout text-foreground-muted" data-testid="provider-connection-verify-running">
            {formatMessage({ id: "settings.providers.verifyRunning" }, { computer: computerName })}
          </p>
        )}
        {phase === "done" && result && outcome === "success" && (
          <div className="stack-y-3" data-testid="provider-connection-verify-success">
            <Banner intent="success" density="sm" role="status">
              {formatMessage({ id: "settings.providers.verifySuccess" }, { computer: computerName })}
              {" · "}
              <span className="font-mono text-mono-meta">
                {formatMessage({ id: "settings.providers.verifyLatency" }, { ms: result.probe.latencyMs ?? 0 })}
              </span>
              {" · "}
              <span className="font-mono text-mono-meta">{result.probe.verifiedAt ?? ""}</span>
            </Banner>
            <div>
              <div className="text-footnote font-semibold text-foreground-muted">
                {formatMessage({ id: "settings.providers.verifyReply" })}
              </div>
              {result.reply ? (
                <pre className="mt-1 w-full whitespace-pre-wrap break-words rounded-container border border-line-hairline bg-layer-code px-3 py-2 font-mono text-mono-code text-foreground" data-testid="provider-connection-verify-reply">
                  {result.reply}
                </pre>
              ) : (
                <p className="mt-1 text-caption text-foreground-hint">{formatMessage({ id: "settings.providers.verifyReplyMissing" })}</p>
              )}
            </div>
          </div>
        )}
        {phase === "done" && (outcome === "failure" || failure) && (
          <div data-testid="provider-connection-verify-failure">
            <Banner
              intent="warning"
              density="sm"
              title={failure || formatMessage({ id: "settings.providers.verifyFailure" }, {
                category: category ? formatMessage({ id: `settings.providers.probeCategory.${category}` }) : "",
              })}
            >
              {formatMessage({ id: "settings.providers.verifyFailureHint" })}
            </Banner>
          </div>
        )}
        <DialogCardFooter>
          <Button size="lg" type="button" variant="ghost" onClick={onClose}>{formatMessage({ id: "settings.common.close" })}</Button>
          <DialogCommit>
            {(inHead) => (
              <Button size={inHead ? "md" : "lg"}
                type="button"
                variant="primary"
                disabled={phase === "running" || candidates.length === 0}
                onClick={start}
              >
                {phase === "done"
                  ? formatMessage({ id: "settings.providers.verifyAgain" })
                  : formatMessage({ id: "settings.providers.verifyStart" })}
              </Button>
            )}
          </DialogCommit>
        </DialogCardFooter>
      </div>
    </DialogCard>
  );
}
