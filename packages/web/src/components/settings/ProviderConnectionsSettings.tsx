import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { CheckCircle2, KeyRound, Pencil, Plus, Power, RefreshCw, Send, Trash2, XCircle } from "lucide-react";
import { useIntl } from "react-intl";
import {
  PI_BUILTIN_PROVIDER_DEFAULT_MODELS,
  PI_BUILTIN_PROVIDER_MODELS,
} from "@botiverse/raft-shared";
import type {
  ProviderConnectionProviderId,
  ProviderConnectionProviderOption,
  ProviderConnectionSummary,
} from "@botiverse/raft-shared";
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "raft-ui";
import api from "../../api/client";
import { useProviderConnections } from "../../hooks/useProviderConnections";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import Button from "../ui/Button";
import Checkbox from "../ui/Checkbox";
import DialogCard from "../ui/DialogCard";
import FormField from "../ui/FormField";
import SectionHeader from "../ui/SectionHeader";
import Spinner from "../ui/Spinner";

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
  const { connections, providerOptions, loading, error, refresh, featureEnabled } = useProviderConnections();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<{ connection: ProviderConnectionSummary; action: "rename" | "rotate" } | null>(null);
  const [testing, setTesting] = useState<ProviderConnectionSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  if (!featureEnabled) return null;

  const run = async (id: string, action: () => Promise<unknown>) => {
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
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="provider-connections-settings">
      <div className="flex items-center justify-between gap-3">
        <SectionHeader label={formatMessage({ id: "settings.providers.sectionTitle" })} icon={<KeyRound size={16} />} />
        {capabilities.manageExternalAuth && (
          <Button type="button" size="sm" disabled={providerOptions.length === 0} onClick={() => setCreating(true)}>
            <Plus size={16} />
            {formatMessage({ id: "settings.providers.add" })}
          </Button>
        )}
      </div>
      <p className="text-sm text-black/60">{formatMessage({ id: "settings.providers.description" })}</p>

      {(error || actionError) && (
        <div className="border-2 border-black bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
          {actionError || formatMessage({ id: "settings.providers.loadError" })}
        </div>
      )}

      {loading ? (
        <div className="flex min-h-32 items-center justify-center"><Spinner size="md" /></div>
      ) : connections.length === 0 ? (
        <div className="border-2 border-dashed border-black/25 px-5 py-10 text-center text-sm text-black/55">
          {formatMessage({ id: "settings.providers.empty" })}
        </div>
      ) : (
        <div className="divide-y-2 divide-black border-2 border-black bg-white shadow-brutal-sm">
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              providerOptions={providerOptions}
              canManage={capabilities.manageExternalAuth}
              busy={busyId === connection.id}
              onTest={() => setTesting(connection)}
              onRename={() => setEditing({ connection, action: "rename" })}
              onRotate={() => setEditing({ connection, action: "rotate" })}
              onToggle={() => void run(connection.id, () => api.patch(`/provider-connections/${connection.id}`, { enabled: !connection.enabled }))}
              onDelete={() => {
                if (window.confirm(formatMessage({ id: "settings.providers.deleteConfirm" }, { name: connection.name }))) {
                  void run(connection.id, () => api.delete(`/provider-connections/${connection.id}`));
                }
              }}
            />
          ))}
        </div>
      )}

      {creating && (
        <CreateProviderConnectionModal
          providerOptions={providerOptions}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}
      {editing && (
        <ProviderConnectionActionModal
          key={`${editing.connection.id}:${editing.action}`}
          connection={editing.connection}
          providerOptions={providerOptions}
          action={editing.action}
          onClose={() => setEditing(null)}
          onCompleted={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
      {testing && (
        <ProviderConnectionTestModal
          key={testing.id}
          connection={testing}
          onClose={() => setTesting(null)}
          onCompleted={async () => {
            setTesting(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function ConnectionRow({
  connection,
  providerOptions,
  canManage,
  busy,
  onTest,
  onRename,
  onRotate,
  onToggle,
  onDelete,
}: {
  connection: ProviderConnectionSummary;
  providerOptions: ProviderConnectionProviderOption[];
  canManage: boolean;
  busy: boolean;
  onTest: () => void;
  onRename: () => void;
  onRotate: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { formatMessage } = useIntl();
  const ready = connection.enabled && connection.status === "ready";
  const deleteDisabledReason = connection.assignedAgentCount > 0
    ? formatMessage(
      { id: "settings.providers.deleteAssignedHint" },
      { count: connection.assignedAgentCount },
    )
    : "";
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center" data-testid={`provider-connection-${connection.id}`}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center border-2 border-black ${ready ? "bg-green-100" : "bg-black/5"}`}>
          {ready ? <CheckCircle2 size={17} /> : <XCircle size={17} />}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-bold">{connection.name}</div>
          <div className="mt-0.5 text-xs text-black/55">
            {labelForProviderId(connection.providerId, providerOptions)}
            {" · "}
            {formatMessage({ id: `settings.providers.status.${connection.status}` })}
            {" · "}
            {connection.assignedAgentCount === 1
              ? formatMessage({ id: "settings.providers.agentCountOne" })
              : formatMessage({ id: "settings.providers.agentCount" }, { count: connection.assignedAgentCount })}
          </div>
        </div>
      </div>
      {canManage && (
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="sm" shape="icon" title={formatMessage({ id: "settings.providers.test" })} disabled={busy} onClick={onTest}><Send size={15} /></Button>
          <Button type="button" size="sm" shape="icon" title={formatMessage({ id: "settings.providers.rename" })} disabled={busy} onClick={onRename}><Pencil size={15} /></Button>
          <Button type="button" size="sm" shape="icon" title={formatMessage({ id: "settings.providers.rotate" })} disabled={busy} onClick={onRotate}><KeyRound size={15} /></Button>
          <Button type="button" size="sm" shape="icon" title={connection.enabled ? formatMessage({ id: "settings.providers.disable" }) : formatMessage({ id: "settings.providers.enable" })} disabled={busy} onClick={onToggle}><Power size={15} /></Button>
          <Button
            type="button"
            size="sm"
            shape="icon"
            title={deleteDisabledReason || formatMessage({ id: "settings.providers.delete" })}
            aria-label={formatMessage({ id: "settings.providers.delete" })}
            aria-description={deleteDisabledReason || undefined}
            aria-disabled={deleteDisabledReason ? true : undefined}
            className={deleteDisabledReason ? "cursor-not-allowed opacity-50" : ""}
            disabled={busy}
            onClick={deleteDisabledReason ? undefined : onDelete}
          >
            <Trash2 size={15} />
          </Button>
        </div>
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
  const modelListId = `provider-connection-${connection.id}-models`;
  const modelInputId = `provider-connection-${connection.id}-test-model`;
  const messageInputId = `provider-connection-${connection.id}-test-message`;

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    setModelError("");
    try {
      const response = await api.get<{ models: string[] }>(`/provider-connections/${connection.id}/models`);
      const nextModels = [...new Set([...presetTestModels(connection.providerId), ...response.data.models])];
      setModels(nextModels);
      setModel((current) => current.trim() ? current : nextModels[0] ?? "");
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

  return (
    <DialogCard
      onClose={onClose}
      title={formatMessage({ id: "settings.providers.testTitle" }, { name: connection.name })}
      testId="provider-connection-test-dialog"
    >
      <form onSubmit={submit} className="space-y-4" data-testid="provider-connection-test-form">
        <FormField
          label={formatMessage({ id: "settings.providers.testModel" })}
          htmlFor={modelInputId}
        >
          <input
            id={modelInputId}
            className="input-brutal w-full"
            list={modelListId}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            maxLength={200}
            required
            autoFocus
          />
          <datalist id={modelListId}>
            {models.map((candidate) => <option key={candidate} value={candidate} />)}
          </datalist>
        </FormField>
        <div className="flex items-center justify-between gap-3">
          <p className={`text-xs ${modelError ? "text-red-700" : "text-black/55"}`}>
            {modelError || formatMessage({ id: "settings.providers.testModelHint" })}
          </p>
          <Button type="button" size="sm" disabled={loadingModels || submitting} onClick={() => void loadModels()}>
            <RefreshCw size={15} className={loadingModels ? "animate-spin" : ""} />
            {formatMessage({ id: "settings.providers.refreshModels" })}
          </Button>
        </div>
        <FormField
          label={formatMessage({ id: "settings.providers.testMessage" })}
          htmlFor={messageInputId}
        >
          <textarea
            id={messageInputId}
            className="input-brutal min-h-28 w-full resize-y"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={2000}
            required
          />
        </FormField>
        {error && <div className="text-sm font-medium text-red-700">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>{formatMessage({ id: "settings.common.cancel" })}</Button>
          <Button type="submit" disabled={submitting || !model.trim() || !message.trim()}>
            {submitting ? <Spinner size="sm" /> : <Send size={16} />}
            {formatMessage({ id: "settings.providers.sendTest" })}
          </Button>
        </div>
      </form>
    </DialogCard>
  );
}

function ProviderConnectionActionModal({
  connection,
  providerOptions,
  action,
  onClose,
  onCompleted,
}: {
  connection: ProviderConnectionSummary;
  providerOptions: ProviderConnectionProviderOption[];
  action: "rename" | "rotate";
  onClose: () => void;
  onCompleted: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the keyed modal snapshots the selected row when it opens; catalog refreshes must not overwrite in-progress input.
  const [name, setName] = useState(connection.name);
  const [apiKey, setApiKey] = useState("");
  // oxlint-disable-next-line react-doctor/no-derived-useState -- same keyed modal snapshot contract as the name field above.
  const [endpointUrl, setEndpointUrl] = useState(connection.endpointUrl ?? "");
  // oxlint-disable-next-line react-doctor/no-derived-useState -- same keyed modal snapshot contract as the name field above.
  const [supportsImageInput, setSupportsImageInput] = useState(connection.supportsImageInput);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const gateway = isGatewayProviderId(connection.providerId, providerOptions);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      if (action === "rename") {
        await api.patch(`/provider-connections/${connection.id}`, { name });
      } else {
        await api.post(`/provider-connections/${connection.id}/credentials/rotate`, {
          apiKey,
          ...(gateway ? { endpointUrl, supportsImageInput } : {}),
        });
      }
      await onCompleted();
    } catch {
      setError(formatMessage({ id: "settings.providers.actionError" }));
    } finally {
      setSubmitting(false);
    }
  };

  const titleId = action === "rename" ? "settings.providers.renameTitle" : "settings.providers.rotateTitle";
  const submitId = action === "rename" ? "settings.providers.saveName" : "settings.providers.rotateCredential";
  return (
    <DialogCard onClose={onClose} title={formatMessage({ id: titleId }, { name: connection.name })} testId={`provider-connection-${action}-dialog`}>
      <form onSubmit={submit} className="space-y-4">
        {action === "rename" ? (
          <FormField label={formatMessage({ id: "settings.providers.name" })}>
            <input className="input-brutal w-full" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required autoFocus />
          </FormField>
        ) : (
          <>
            <p className="text-sm text-black/60">{formatMessage({ id: "settings.providers.rotateHint" })}</p>
            {gateway && (
              <FormField label={formatMessage({ id: "settings.providers.endpoint" })}>
                <input className="input-brutal w-full" type="url" value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} required />
              </FormField>
            )}
            <FormField label={formatMessage({ id: "settings.providers.apiKey" })} hint={formatMessage({ id: "settings.providers.apiKeyHint" })}>
              <input className="input-brutal w-full" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required autoFocus={!gateway} />
            </FormField>
            {gateway && (
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox checked={supportsImageInput} onChange={(event) => setSupportsImageInput(event.target.checked)} />
                {formatMessage({ id: "settings.providers.imageInput" })}
              </label>
            )}
          </>
        )}
        {error && <div className="text-sm font-medium text-red-700">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>{formatMessage({ id: "settings.common.cancel" })}</Button>
          <Button type="submit" disabled={submitting || (action === "rename" ? !name.trim() : !apiKey.trim() || (gateway && !endpointUrl.trim()))}>
            {submitting ? <Spinner size="sm" /> : action === "rename" ? <Pencil size={16} /> : <KeyRound size={16} />}
            {formatMessage({ id: submitId })}
          </Button>
        </div>
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
    <DialogCard onClose={onClose} title={formatMessage({ id: "settings.providers.createTitle" })} testId="provider-connection-create-dialog">
      <form onSubmit={submit} className="space-y-4" data-testid="provider-connection-create-form">
        <FormField label={formatMessage({ id: "settings.providers.name" })}>
          <input className="input-brutal w-full" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required />
        </FormField>
        <FormField label={formatMessage({ id: "settings.providers.provider" })}>
          <Select
            value={providerId}
            onValueChange={(value) => {
              if (value != null) setProviderId(value as ProviderConnectionProviderId);
            }}
            items={providerOptions.map((provider) => ({
              value: provider.id,
              label: provider.label,
            }))}
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
            <input className="input-brutal w-full" type="url" value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} placeholder="https://gateway.example.com/v1" required />
          </FormField>
        )}
        <FormField label={formatMessage({ id: "settings.providers.apiKey" })} hint={formatMessage({ id: "settings.providers.apiKeyHint" })}>
          <input className="input-brutal w-full" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required />
        </FormField>
        {gateway && (
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox checked={supportsImageInput} onChange={(event) => setSupportsImageInput(event.target.checked)} />
            {formatMessage({ id: "settings.providers.imageInput" })}
          </label>
        )}
        {error && <div className="text-sm font-medium text-red-700">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>{formatMessage({ id: "settings.common.cancel" })}</Button>
          <Button type="submit" disabled={submitting || !name.trim() || !apiKey.trim() || (gateway && !endpointUrl.trim())}>
            {submitting ? <Spinner size="sm" /> : <Plus size={16} />}
            {formatMessage({ id: "settings.providers.create" })}
          </Button>
        </div>
      </form>
    </DialogCard>
  );
}

export const __testInternals = { ConnectionRow, CreateProviderConnectionModal, ProviderConnectionTestModal };
