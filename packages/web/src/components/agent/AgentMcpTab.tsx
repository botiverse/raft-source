import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import type { MessageId } from "../../i18n/messages/en";
import { Blocks, Check, ChevronDown, ChevronUp, FlaskConical, Info, Link2, Pencil, Plus, Trash2, Unplug } from "lucide-react";
import {
  MANAGED_MCP_OAUTH_RESULT_CHANNEL,
} from "@botiverse/raft-shared";
import type {
  ManagedMcpAgentCatalogResponse,
  ManagedMcpAuthMode,
  ManagedMcpProvider,
  ManagedMcpRecommendation,
  ManagedMcpServerView,
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
import ConfirmDialog from "../ConfirmDialog";
import Banner from "../ui/Banner";
import Button from "../ui/Button";
import DialogCard from "../ui/DialogCard";
import EmptyState from "../ui/EmptyState";
import FormField from "../ui/FormField";
import { KeyValueAddButton, KeyValueInputRow } from "../ui/KeyValueInput";
import SectionHeader from "../ui/SectionHeader";
import SurfaceListItem from "../ui/SurfaceListItem";
import Textarea from "../ui/Textarea";
import Tooltip from "../ui/Tooltip";
import {
  buildManagedMcpCredentialPatch,
  managedMcpHeadersForCreate,
  managedMcpHeadersIncomplete,
} from "./managedMcpCredentials";
import type {
  ManagedMcpHeaderDraft,
} from "./managedMcpCredentials";
import { normalizeManagedMcpToolDescription } from "./managedMcpToolDescription";

type ConnectionTestResult = { status: "testing" } | { status: "success"; toolCount: number } | { status: "error"; message: string };
type ServerDraft = {
  id: string | null;
  name: string;
  description: string;
  provider: ManagedMcpProvider;
  authMode: ManagedMcpAuthMode;
  endpointUrl: string;
  headers: ManagedMcpHeaderDraft[];
  persistedHeaderNames: string[];
};

const EMPTY_DRAFT: ServerDraft = {
  id: null,
  name: "",
  description: "",
  provider: "custom",
  authMode: "none",
  endpointUrl: "",
  headers: [],
  persistedHeaderNames: [],
};

const PROVIDER_OPTIONS = [
  { value: "custom", labelId: "agent.mcp.provider.custom" },
  { value: "notion", labelId: "agent.mcp.provider.notion" },
  { value: "linear", labelId: "agent.mcp.provider.linear" },
] as const;

const AUTH_MODE_OPTIONS = [
  { value: "none", labelId: "agent.mcp.authMode.none" },
  { value: "headers", labelId: "agent.mcp.authMode.headers" },
  { value: "oauth", labelId: "agent.mcp.authMode.oauth" },
] as const;

function renderSelectItems(
  options: readonly { value: string; labelId: MessageId }[],
  formatMessage: IntlShape["formatMessage"],
) {
  return options.map((option) => (
    <SelectItem key={option.value} value={option.value}>
      <SelectItemText>{formatMessage({ id: option.labelId })}</SelectItemText>
      <SelectItemIndicator />
    </SelectItem>
  ));
}

function messageFor(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === "string" ? data.error : fallback;
}

export function AgentMcpTab({
  agentId,
  canManageServer,
  scope = "agent",
}: {
  agentId?: string;
  canManageServer: boolean;
  scope?: "agent" | "server";
}) {
  const { formatDate, formatMessage, formatTime } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const [catalog, setCatalog] = useState<ManagedMcpAgentCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerDraft | null>(null);
  const [connectionTest, setConnectionTest] = useState<ConnectionTestResult | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedMcpServerView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [headerSequence, setHeaderSequence] = useState(0);
  const providerSelectOptions = useMemo(
    () => PROVIDER_OPTIONS.map((option) => ({
      value: option.value,
      label: formatMessage({ id: option.labelId }),
    })),
    [formatMessage],
  );
  const authModeSelectOptions = useMemo(
    () => AUTH_MODE_OPTIONS.map((option) => ({
      value: option.value,
      label: formatMessage({ id: option.labelId }),
    })),
    [formatMessage],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (scope === "agent" && !agentId) throw new Error(formatMessageRef.current({ id: "agent.mcp.errorAgentIdRequired" }));
      const endpoint = scope === "server" ? "/mcp/servers" : `/mcp/agents/${agentId}`;
      const { data } = await api.get<ManagedMcpAgentCatalogResponse>(endpoint);
      setCatalog(data);
    } catch (loadError) {
      setError(messageFor(loadError, formatMessageRef.current({ id: "agent.mcp.errorRequestFailed" })));
    } finally {
      setLoading(false);
    }
  }, [agentId, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const refreshAfterOAuth = () => void load();
    window.addEventListener("focus", refreshAfterOAuth);
    return () => window.removeEventListener("focus", refreshAfterOAuth);
  }, [load]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(MANAGED_MCP_OAUTH_RESULT_CHANNEL);
    const refreshAfterOAuth = (event: MessageEvent) => {
      if ((event.data as { type?: unknown } | null)?.type === MANAGED_MCP_OAUTH_RESULT_CHANNEL) void load();
    };
    channel.addEventListener("message", refreshAfterOAuth);
    return () => {
      channel.removeEventListener("message", refreshAfterOAuth);
      channel.close();
    };
  }, [load]);

  const beginAdd = () => {
    setDraft({ ...EMPTY_DRAFT });
    setConnectionTest(null);
    setEditorError(null);
  };

  const beginRecommendation = (recommendation: ManagedMcpRecommendation) => {
    const firstId = headerSequence + 1;
    setDraft({
      ...EMPTY_DRAFT,
      name: recommendation.name,
      description: recommendation.description,
      provider: recommendation.provider,
      authMode: recommendation.authMode,
      endpointUrl: recommendation.endpointUrl,
      persistedHeaderNames: [],
      headers: recommendation.credentialHeaderNames.map((name, index) => ({
        id: firstId + index, name, value: "", persistedName: null,
      })),
    });
    setConnectionTest(null);
    setEditorError(null);
    setHeaderSequence((value) => value + recommendation.credentialHeaderNames.length);
  };

  const beginEdit = (server: ManagedMcpServerView) => {
    const firstId = headerSequence + 1;
    setDraft({
      id: server.id,
      name: server.name,
      description: server.description ?? "",
      provider: server.provider,
      authMode: server.authMode,
      endpointUrl: server.endpointUrl,
      persistedHeaderNames: server.credentialHeaderNames,
      headers: server.credentialHeaderNames.map((name, index) => ({
        id: firstId + index, name, value: "", persistedName: name,
      })),
    });
    setConnectionTest(null);
    setEditorError(null);
    setHeaderSequence((value) => value + server.credentialHeaderNames.length);
  };

  const updateDraft = (next: ServerDraft) => {
    setDraft(next);
    setConnectionTest(null);
    setEditorError(null);
  };

  const closeEditor = () => {
    setDraft(null);
    setConnectionTest(null);
    setEditorError(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    if (draft.authMode === "headers" && managedMcpHeadersIncomplete(draft.headers)) {
      setEditorError(formatMessage({ id: "agent.mcp.errorCredentialHeadersIncomplete" }));
      return;
    }
    setBusyId(draft.id ?? "new");
    setEditorError(null);
    try {
      const payload = {
        name: draft.name,
        description: draft.description || null,
        provider: draft.provider,
        authMode: draft.authMode,
        endpointUrl: draft.endpointUrl,
        ...(draft.authMode === "headers"
          ? draft.id
            ? { credentialPatch: buildManagedMcpCredentialPatch(draft.headers, draft.persistedHeaderNames) }
            : { headers: managedMcpHeadersForCreate(draft.headers) }
          : {}),
      };
      if (draft.id) await api.patch(`/mcp/servers/${draft.id}`, payload);
      else await api.post("/mcp/servers", payload);
      closeEditor();
      await load();
    } catch (saveError) {
      setEditorError(messageFor(saveError, formatMessage({ id: "agent.mcp.errorRequestFailed" })));
    } finally {
      setBusyId(null);
    }
  };

  const mutate = async (id: string, operation: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await operation();
      await load();
    } catch (mutationError) {
      setError(messageFor(mutationError, formatMessage({ id: "agent.mcp.errorRequestFailed" })));
    } finally {
      setBusyId(null);
    }
  };

  const connectOAuth = async (server: ManagedMcpServerView) => {
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    setBusyId(server.id);
    setError(null);
    try {
      const { data } = await api.post<{ authorizationUrl: string }>(`/mcp/servers/${server.id}/oauth/start`);
      if (popup) {
        popup.location.href = data.authorizationUrl;
      } else {
        window.location.assign(data.authorizationUrl);
      }
    } catch (oauthError) {
      popup?.close();
      setError(messageFor(oauthError, formatMessage({ id: "agent.mcp.errorRequestFailed" })));
    } finally {
      setBusyId(null);
    }
  };

  const disconnectOAuth = async (server: ManagedMcpServerView) => {
    await mutate(server.id, () => api.delete(`/mcp/servers/${server.id}/oauth`));
  };

  const testDraftConnection = async () => {
    if (!draft) return;
    setConnectionTest({ status: "testing" });
    try {
      const { data } = await api.post<{ tools: unknown[] }>("/mcp/servers/test-configuration", {
        ...(draft.id ? { mcpServerId: draft.id } : {}),
        endpointUrl: draft.endpointUrl,
        authMode: draft.authMode,
        ...(draft.authMode === "headers"
          ? draft.id
            ? { credentialPatch: buildManagedMcpCredentialPatch(draft.headers, draft.persistedHeaderNames) }
            : { headers: managedMcpHeadersForCreate(draft.headers) }
          : {}),
      });
      setConnectionTest({ status: "success", toolCount: data.tools.length });
    } catch (testError) {
      setConnectionTest({ status: "error", message: messageFor(testError, formatMessage({ id: "agent.mcp.errorRequestFailed" })) });
    }
  };

  const deleteServer = async (server: ManagedMcpServerView) => {
    setBusyId(server.id);
    setError(null);
    try {
      await api.delete(`/mcp/servers/${server.id}`);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const draftHeadersIncomplete = draft?.authMode === "headers" ? managedMcpHeadersIncomplete(draft.headers) : false;
  const visibleServers = scope === "agent"
    ? catalog?.servers.filter((server) => server.usage !== null) ?? []
    : catalog?.servers ?? [];

  return (
    <div className={scope === "server" ? "" : "flex-1 overflow-y-auto bg-white px-5 py-4"}>
      <div className="space-y-6">
        {error && <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>}

        <section className="space-y-3">
          <div>
            <SectionHeader
              label={scope === "server"
                ? formatMessage({ id: "agent.mcp.serverTitle" })
                : formatMessage({ id: "agent.mcpUsage.title" })}
              count={visibleServers.length}
              action={
                scope === "server" && canManageServer ? (
                  <Button shape="iconText" onClick={beginAdd}>
                    <Plus size={13} /> {formatMessage({ id: "agent.mcp.addServer" })}
                  </Button>
                ) : loading ? (
                  <span className="text-xs font-bold text-black/50">{formatMessage({ id: "common.loading" })}</span>
                ) : null
              }
            />
            <p className="mt-1 text-xs text-black/60">
              {scope === "server"
                ? formatMessage({ id: "agent.mcp.serverDescription" })
                : formatMessage({ id: "agent.mcpUsage.description" })}
            </p>
          </div>

          {loading ? (
            <div className="font-mono text-xs text-black/40">{formatMessage({ id: "agent.mcp.loadingServers" })}</div>
          ) : visibleServers.length > 0 ? (
            <div className="space-y-3">
              {visibleServers.map((server) => {
                const toolsOpen = expandedTools.has(server.id);
                const connectionReady = server.authMode !== "oauth" || server.oauthStatus === "connected";
                return (
                  <SurfaceListItem key={server.id} interactive={false}>
                    <div className="flex items-start gap-3">
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="break-words text-sm font-bold text-black">{server.name}</h4>
                            {!server.enabled && <span className="border border-black bg-gray-200 px-1.5 py-0.5 text-[10px] font-bold uppercase">{formatMessage({ id: "agent.mcp.disabledBadge" })}</span>}
                            <span className="border border-black bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase">{server.provider}</span>
                            {server.authMode === "oauth" ? (
                              <span className={`border border-black px-1.5 py-0.5 text-[10px] font-bold uppercase ${server.oauthStatus === "connected" ? "bg-brutal-lime" : server.oauthStatus === "error" ? "bg-brutal-red/30" : "bg-brutal-lavender/40"}`}>
                                {formatMessage({ id: "agent.mcp.oauthStatus" }, { status: server.oauthStatus })}
                              </span>
                            ) : server.hasCredentials ? (
                              <span className="border border-black bg-brutal-lavender/40 px-1.5 py-0.5 text-[10px] font-bold uppercase">{formatMessage({ id: "agent.mcp.credentialsStoredBadge" })}</span>
                            ) : null}
                          </div>
                          {server.description && <p className="mt-1 text-sm text-black/70">{server.description}</p>}
                          <p className="mt-1 break-all font-mono text-xs text-black/50">{server.endpointUrl}</p>
                          {scope === "agent" && server.usage && (
                            <dl className="mt-3 grid gap-2 text-xs text-black/65 sm:grid-cols-3">
                              <div>
                                <dt className="font-bold text-black">
                                  {formatMessage({ id: "agent.mcpUsage.callsLabel" })}
                                </dt>
                                <dd>
                                  {formatMessage(
                                    { id: "agent.mcpUsage.callCount" },
                                    { count: server.usage.invocationCount },
                                  )}
                                </dd>
                              </div>
                              <div>
                                <dt className="font-bold text-black">
                                  {formatMessage({ id: "agent.mcpUsage.lastUsedLabel" })}
                                </dt>
                                <dd>
                                  {formatDate(new Date(server.usage.lastInvokedAt), {
                                    year: "numeric",
                                    month: "short",
                                    day: "numeric",
                                  })}{" "}
                                  {formatTime(new Date(server.usage.lastInvokedAt), {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </dd>
                              </div>
                              <div>
                                <dt className="font-bold text-black">
                                  {formatMessage({ id: "agent.mcpUsage.lastToolLabel" })}
                                </dt>
                                <dd className="break-all font-mono">{server.usage.lastToolName}</dd>
                              </div>
                            </dl>
                          )}
                          {server.lastCheckError && (
                            <Banner intent="warning" density="sm" className="mt-3 font-bold">{server.lastCheckError}</Banner>
                          )}
                        </div>
                      </div>
                      {scope === "server" && canManageServer && (
                        <div className="flex shrink-0 items-center gap-1">
                          {server.authMode === "oauth" && server.oauthStatus !== "connected" && (
                            <Tooltip content={formatMessage({ id: "agent.mcp.connectName" }, { name: server.name })}>
                              <Button
                                shape="icon"
                                tone="lime"
                                aria-label={formatMessage({ id: "agent.mcp.connectName" }, { name: server.name })}
                                disabled={busyId === server.id}
                                onClick={() => void connectOAuth(server)}
                              >
                                <Link2 size={14} />
                              </Button>
                            </Tooltip>
                          )}
                          {server.authMode === "oauth" && server.oauthStatus === "connected" && (
                            <Tooltip content={formatMessage({ id: "agent.mcp.disconnectName" }, { name: server.name })}>
                              <Button
                                shape="icon"
                                aria-label={formatMessage({ id: "agent.mcp.disconnectName" }, { name: server.name })}
                                disabled={busyId === server.id}
                                onClick={() => void disconnectOAuth(server)}
                              >
                                <Unplug size={14} />
                              </Button>
                            </Tooltip>
                          )}
                          <Tooltip content={formatMessage({ id: "agent.mcp.testRefreshTools" })}>
                            <Button
                              shape="icon"
                              aria-label={formatMessage({ id: "agent.mcp.testName" }, { name: server.name })}
                              disabled={busyId === server.id || !connectionReady}
                              onClick={() => void mutate(server.id, () => api.post(`/mcp/servers/${server.id}/test`))}
                            >
                              <FlaskConical size={14} />
                            </Button>
                          </Tooltip>
                          <Tooltip content={formatMessage({ id: "agent.mcp.editServer" })}>
                            <Button shape="icon" aria-label={formatMessage({ id: "agent.mcp.editName" }, { name: server.name })} onClick={() => beginEdit(server)}>
                              <Pencil size={14} />
                            </Button>
                          </Tooltip>
                          <Tooltip content={formatMessage({ id: "agent.mcp.deleteServer" })}>
                            <Button shape="icon" tone="red" aria-label={formatMessage({ id: "agent.mcp.deleteName" }, { name: server.name })} onClick={() => setDeleteTarget(server)}>
                              <Trash2 size={14} />
                            </Button>
                          </Tooltip>
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      className="mt-3 flex items-center gap-1 text-xs font-bold text-black/70 underline hover:text-black"
                      aria-expanded={toolsOpen}
                      onClick={() => setExpandedTools((current) => {
                        const next = new Set(current);
                        if (toolsOpen) next.delete(server.id); else next.add(server.id);
                        return next;
                      })}
                    >
                      {toolsOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                      {formatMessage({ id: "agent.mcp.toolCount" }, { count: server.toolCatalog.length })}
                    </button>
                    {toolsOpen && (
                      <div className="mt-2 max-h-80 overflow-y-auto border-y border-black/15 bg-black/[0.015]">
                        <div className="grid grid-cols-1 sm:grid-cols-2">
                          {server.toolCatalog.map((tool) => {
                            const label = tool.title || tool.name;
                            const description = tool.description ? normalizeManagedMcpToolDescription(tool.description) : null;
                            return (
                              <div key={tool.name} className="flex min-h-16 items-start gap-2 border-b border-black/10 px-2.5 py-2 sm:even:border-l sm:even:border-black/10">
                                <span className="min-w-0 flex-1 break-words">
                                  <span className="flex items-start gap-1">
                                    <strong className="min-w-0 flex-1 text-sm leading-5 text-black">{label}</strong>
                                    {description && (
                                      <Tooltip
                                        content={<span className="block text-left">{description}</span>}
                                        contentProps={{
                                          side: "top",
                                          align: "end",
                                          className: "max-h-64 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto border border-black/20 bg-white px-3 py-2 font-normal text-black/70 shadow-sm",
                                        }}
                                      >
                                        <button type="button" className="mt-0.5 shrink-0 text-black/45 hover:text-black" aria-label={formatMessage({ id: "agent.mcp.aboutTool" }, { name: label })}>
                                          <Info size={13} />
                                        </button>
                                      </Tooltip>
                                    )}
                                  </span>
                                  {description && <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-black/55">{description}</span>}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        {server.toolCatalog.length === 0 && (
                          <p className="px-2.5 py-3 text-xs text-black/50">{formatMessage({ id: "agent.mcp.testToDiscoverTools" })}</p>
                        )}
                      </div>
                    )}
                  </SurfaceListItem>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon={<Blocks size={36} />}
              title={formatMessage({
                id: scope === "server"
                  ? "emptyState.noMcpServersTitle"
                  : "agent.mcpUsage.emptyTitle",
              })}
              description={scope === "server"
                ? formatMessage({ id: "agent.mcp.emptyServerDescription" })
                : formatMessage({ id: "agent.mcpUsage.emptyDescription" })}
              action={scope === "server" && canManageServer ? (
                <Button shape="iconText" onClick={beginAdd}>
                  <Plus size={13} /> {formatMessage({ id: "agent.mcp.addServer" })}
                </Button>
              ) : undefined}
            />
          )}
        </section>

        {scope === "server" && canManageServer && catalog && catalog.recommendations.length > 0 && (
          <section className="space-y-3">
            <div>
              <SectionHeader label={formatMessage({ id: "agent.mcp.recommendedTitle" })} count={catalog.recommendations.length} />
              <p className="mt-1 text-xs text-black/60">{formatMessage({ id: "agent.mcp.recommendedDescription" })}</p>
            </div>
            <div className="space-y-3">
              {catalog.recommendations.map((recommendation) => {
                const added = catalog.servers.some((server) => server.provider === recommendation.provider);
                return (
                  <SurfaceListItem key={recommendation.id} interactive={false}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-black">{recommendation.name}</p>
                        <p className="mt-1 text-sm text-black/60">{recommendation.description}</p>
                      </div>
                      <Button
                        shape="iconText"
                        disabled={added}
                        onClick={() => beginRecommendation(recommendation)}
                      >
                        {added ? <Check size={13} /> : <Plus size={13} />}
                        {formatMessage({ id: added ? "agent.mcp.added" : "agent.mcp.add" })}
                      </Button>
                    </div>
                  </SurfaceListItem>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {scope === "server" && canManageServer && draft && (
        <DialogCard
          title={draft.id ? draft.name || formatMessage({ id: "agent.mcp.serverFallbackTitle" }) : formatMessage({ id: "agent.mcp.newServerTitle" })}
          titleId="mcp-server-form-title"
          onClose={closeEditor}
          maxWidthClass="max-w-2xl"
        >
          <form
            onSubmit={save}
            className="space-y-4"
            aria-labelledby="mcp-server-form-title"
          >
            <p className="text-xs text-black/60">{formatMessage({ id: "agent.mcp.formDescription" })}</p>

            {editorError && (
              <Banner intent="warning" density="sm" className="font-bold">
                {editorError}
              </Banner>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={formatMessage({ id: "agent.mcp.providerLabel" })} labelStyle="plain" size="compact" required>
                <Select
                  value={draft.provider}
                  disabled={draft.id !== null}
                  items={providerSelectOptions}
                  onValueChange={(value) => {
                    if (value == null) return;
                    const provider = value as ManagedMcpProvider;
                    updateDraft({
                      ...draft,
                      provider,
                      authMode: provider === "custom" ? "none" : "oauth",
                      endpointUrl: provider === "notion"
                        ? "https://mcp.notion.com/mcp"
                        : provider === "linear"
                          ? "https://mcp.linear.app/mcp"
                          : "",
                      headers: [],
                      persistedHeaderNames: [],
                    });
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={formatMessage({ id: "agent.mcp.providerLabel" })} />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectList>{renderSelectItems(PROVIDER_OPTIONS, formatMessage)}</SelectList>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label={formatMessage({ id: "agent.mcp.authenticationLabel" })} labelStyle="plain" size="compact" required>
                <Select
                  value={draft.authMode}
                  disabled={draft.provider !== "custom"}
                  items={authModeSelectOptions}
                  onValueChange={(value) => {
                    if (value == null) return;
                    const authMode = value as ManagedMcpAuthMode;
                    const firstId = headerSequence + 1;
                    updateDraft({
                      ...draft,
                      authMode,
                      headers: authMode === "headers"
                        ? draft.persistedHeaderNames.map((name, index) => ({
                            id: firstId + index, name, value: "", persistedName: name,
                          }))
                        : [],
                    });
                    if (authMode === "headers") {
                      setHeaderSequence((value) => value + draft.persistedHeaderNames.length);
                    }
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={formatMessage({ id: "agent.mcp.authenticationLabel" })} />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectList>{renderSelectItems(AUTH_MODE_OPTIONS, formatMessage)}</SelectList>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label={formatMessage({ id: "agent.mcp.nameLabel" })} labelStyle="plain" size="compact" required>
                <input required maxLength={120} className="input-brutal w-full text-sm" value={draft.name} onChange={(event) => updateDraft({ ...draft, name: event.target.value })} />
              </FormField>
              <FormField label={formatMessage({ id: "agent.mcp.serverUrlLabel" })} labelStyle="plain" size="compact" required>
                <input required type="url" disabled={draft.provider !== "custom"} className="input-brutal w-full text-sm disabled:bg-gray-100" value={draft.endpointUrl} onChange={(event) => updateDraft({ ...draft, endpointUrl: event.target.value })} />
              </FormField>
            </div>

            <FormField label={formatMessage({ id: "agent.mcp.descriptionLabel" })} labelStyle="plain" size="compact" optional>
              <Textarea rows={2} className="resize-y text-sm" value={draft.description} onChange={(event) => updateDraft({ ...draft, description: event.target.value })} />
            </FormField>

            {draft.authMode === "oauth" && (
              <Banner intent="info" density="sm" withIcon>
                {formatMessage({ id: "agent.mcp.oauthSaveHint" })}
              </Banner>
            )}

            {draft.authMode === "headers" && (
              <FormField label={formatMessage({ id: "agent.mcp.credentialHeadersLabel" })} labelStyle="plain" size="compact" optional>
                <div className="mt-3 space-y-2">
                  {draft.headers.map((header) => (
                    <KeyValueInputRow
                      key={header.id}
                      keyValue={header.name}
                      value={header.value}
                      valueType="password"
                      keyRequired
                      valueRequired={header.persistedName === null || header.name.trim().toLowerCase() !== header.persistedName.toLowerCase()}
                      keyPlaceholder={formatMessage({ id: "agent.mcp.authorizationPlaceholder" })}
                      valuePlaceholder={header.persistedName && header.name.trim().toLowerCase() === header.persistedName.toLowerCase() ? "••••••••" : formatMessage({ id: "agent.mcp.bearerPlaceholder" })}
                      keyLabel={formatMessage({ id: "agent.mcp.headerNameLabel" })}
                      valueLabel={formatMessage({ id: "agent.mcp.headerValueLabel" }, { name: header.name || formatMessage({ id: "agent.mcp.credentialHeaderFallback" }) })}
                      removeLabel={formatMessage({ id: "agent.mcp.removeHeader" })}
                      onKeyChange={(value) => updateDraft({ ...draft, headers: draft.headers.map((item) => item.id === header.id ? { ...item, name: value } : item) })}
                      onValueChange={(value) => updateDraft({ ...draft, headers: draft.headers.map((item) => item.id === header.id ? { ...item, value } : item) })}
                      onRemove={() => updateDraft({ ...draft, headers: draft.headers.filter((item) => item.id !== header.id) })}
                    />
                  ))}
                  <KeyValueAddButton label={formatMessage({ id: "agent.mcp.addHeader" })} onClick={() => {
                    const id = headerSequence + 1;
                    setHeaderSequence(id);
                    updateDraft({ ...draft, headers: [...draft.headers, { id, name: "", value: "", persistedName: null }] });
                  }} />
                  {draft.headers.length === 0 && (
                    <p className="text-xs text-black/50">{formatMessage({ id: "agent.mcp.noCredentialHeaders" })}</p>
                  )}
                </div>
              </FormField>
            )}

            {draft.authMode !== "oauth" && <div className="flex justify-start">
              <Button
                shape="iconText"
                size="sm"
                disabled={connectionTest?.status === "testing" || !draft.endpointUrl.trim() || draftHeadersIncomplete}
                onClick={() => void testDraftConnection()}
              >
                <FlaskConical size={13} /> {formatMessage({ id: connectionTest?.status === "testing" ? "agent.mcp.testingConnection" : "agent.mcp.testConnection" })}
              </Button>
            </div>}

            {connectionTest?.status === "success" && (
              <Banner intent="success" density="sm" withIcon>
                {formatMessage({ id: "agent.mcp.connectionSucceeded" }, { count: connectionTest.toolCount })}
              </Banner>
            )}
            {connectionTest?.status === "error" && (
              <Banner intent="warning" density="sm" withIcon>{connectionTest.message}</Banner>
            )}

            <div className="flex items-center justify-end gap-2 border-t-2 border-black pt-4">
              <Button size="md" onClick={closeEditor}>{formatMessage({ id: "common.confirm.cancel" })}</Button>
              <Button type="submit" shape="iconText" tone="lime" size="md" disabled={busyId !== null}>
                <Check size={14} /> {formatMessage({ id: busyId === (draft.id ?? "new") ? "agent.mcp.saving" : "agent.mcp.save" })}
              </Button>
            </div>
          </form>
        </DialogCard>
      )}

      {scope === "server" && canManageServer && deleteTarget && (
        <ConfirmDialog
          title={formatMessage({ id: "agent.mcp.deleteDialogTitle" })}
          message={formatMessage(
            { id: "settings.mcp.deleteConfirmMessage" },
            { name: deleteTarget.name },
          )}
          confirmLabel={formatMessage({ id: "agent.mcp.deleteConfirmLabel" })}
          loadingLabel={formatMessage({ id: "agent.mcp.deleting" })}
          confirmIcon={<Trash2 size={14} />}
          onConfirm={() => deleteServer(deleteTarget)}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
