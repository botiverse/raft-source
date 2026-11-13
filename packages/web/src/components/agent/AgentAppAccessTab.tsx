import { Badge, Button, IconTile, ListRow, ListRowBody, ListRowBottom, ListRowDescription, ListRowGroup, ListRowMeta, ListRowTitle, ListRowTop, toast, ScrollArea } from "@botiverse/raft-ui";
import { AppWindow } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type {
  AgentAppEventDetail,
  AgentAppEventListResponse,
  AgentAppEventSummary,
  ManagedMcpAgentCatalogResponse,
  ManagedMcpServerView,
} from "@botiverse/raft-shared";
import api from "../../api/client";
import { isSecondFactorStepUpCancelled, withSecondFactorStepUp } from "../settings/secondFactorStepUp";
import Banner from "../ui/Banner";
import SectionHeader from "../ui/SectionHeader";
import StatusDot from "../ui/StatusDot";
import SurfaceListItem from "../ui/SurfaceListItem";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import type { MessageId } from "../../i18n/messages";
import { AgentAppGrantsRow } from "./AgentAppGrantsRow";
import type { RevokeAppGrantsTarget } from "./AgentAppGrantsRow";
import { appsToFocusAfterRevoke, groupGrantsByApp, revokeGrantFailure } from "./agentAppGrants";
import type { AgentIntegrationItem, RevokeGrantFailure } from "./agentAppGrants";
import { RevokeAppGrantsDialog } from "./RevokeAppGrantsDialog";
import { AgentMcpAppRow, agentHasMcpApp } from "./AgentMcpAppRow";
import { AppEventFilterButton } from "./AppEventFilterButton";
import { GrantableAppOption } from "./GrantableAppOption";
import { GrantScopeCheckbox } from "./GrantScopeCheckbox";
import { IntegrationActionButton } from "./IntegrationActionButton";
import { McpAgentConnectionDrawer } from "./McpAgentConnectionDrawer";
import { initialMcpCandidate, mcpGrantConnectionId, McpConnectionCandidates } from "./McpConnectionCandidates";
import { mcpAppErrorMessage } from "../settings/mcpApps/mcpAppApi";
import type { McpConnectionAuthorizationView } from "../settings/mcpApps/mcpAppApi";
import { trackUndoOffered, trackUndoUsed } from "../../analytics/confirmUndo";
import { useServerStore } from "../../store/serverStore";

export interface GrantableApp {
  clientId: string;
  clientKey: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  scopes: string[];
  /** An MCP App this Agent does not have: granting it has no scopes to pick. */
  kind?: "mcp";
}

/** An MCP App the Agent does not have, as a Grant access option. */
function mcpGrantableApp(server: ManagedMcpServerView): GrantableApp {
  return { clientId: server.id, clientKey: server.id, name: server.name, description: server.description, logoUrl: server.logoUrl ?? null, scopes: [], kind: "mcp" };
}

const APPROVE_REQUEST_BODY = { remember: true };
const EMPTY_BODY = {};

const EVENT_STATUS_VARIANT: Record<AgentAppEventSummary["status"], "success" | "warning" | "muted"> = {
  delivered: "success",
  queued: "warning",
  expired: "muted",
};

/** The fixed status pixel beside each delivery word (task colours: todo / done / closed). */
const EVENT_STATUS_PIXEL: Record<AgentAppEventSummary["status"], string> = {
  delivered: "bg-task-status-done",
  queued: "bg-task-status-todo",
  expired: "bg-task-status-closed",
};

/**
 * An app row: raft-ui's display-only ListRow (its controls are the targets)
 * with a neutral IconTile and the app's facts, in a ListRowGroup that draws
 * the hairline from the text column (16 + 35 + 12). The facts run onto
 * several lines, so the row hangs them from its top.
 */
function AppRow({ children }: { children: ReactNode }) {
  return (
    <ListRow interactive={false} className="items-start">
      <IconTile>
        <AppWindow />
      </IconTile>
      {children}
    </ListRow>
  );
}

function errorText(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  return typeof message === "string" && message ? message : fallback;
}

function ScopeChips({ scopes }: { scopes: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <Badge key={scope} appearance="outline">
          {scope}
        </Badge>
      ))}
    </div>
  );
}

const NO_MCP_CANDIDATES: McpConnectionAuthorizationView["candidates"] = [];

/**
 * Granting an MCP App again: which Connection the Agent gets. The server default is preselected when
 * it is signed in, every Connection is listed, and nothing is written until Grant access, which
 * writes what the Connect card's Grant writes (`mcpGrantConnectionId`). A grant never silently
 * reuses the Connection the Agent was pinned to before it was revoked.
 */
function useMcpGrantChoice(agentId: string, appId: string | null) {
  // Both keyed by the App they belong to, so choosing another App starts clean without resetting
  // state in an effect.
  const [result, setResult] = useState<{ appId: string; view: McpConnectionAuthorizationView | "failed" } | null>(null);
  const [pick, setPick] = useState<{ appId: string; connectionId: string } | null>(null);
  useEffect(() => {
    if (appId === null) return undefined;
    let canceled = false;
    api.get<McpConnectionAuthorizationView>(`/mcp/servers/${appId}/connection-authorization`, { params: { agentId } })
      .then(({ data }) => { if (!canceled) setResult({ appId, view: data }); })
      .catch(() => { if (!canceled) setResult({ appId, view: "failed" }); });
    return () => { canceled = true; };
  }, [agentId, appId]);
  const view = result !== null && result.appId === appId ? result.view : null;
  const picked = pick !== null && pick.appId === appId ? pick.connectionId : null;
  const setPicked = useCallback((connectionId: string) => { if (appId !== null) setPick({ appId, connectionId }); }, [appId]);
  const loaded = view !== null && view !== "failed" ? view : null;
  const candidates = loaded?.candidates ?? NO_MCP_CANDIDATES;
  const authKind = loaded?.app?.authKind ?? null;
  const selected = picked ?? initialMcpCandidate(candidates);
  // An App without auth has no Connection to choose. One with no signed-in Connection is granted
  // following the server default; the Agent's first call then asks for sign-in (the Connect card).
  const needsChoice = authKind !== "none";
  return {
    view,
    candidates,
    needsChoice,
    selected,
    setPicked,
    ready: loaded !== null,
    body: (): { enabled: true; connectionId?: string | null } => (
      !needsChoice ? { enabled: true } : { enabled: true, connectionId: selected === null ? null : mcpGrantConnectionId(candidates, selected) }
    ),
  };
}

/**
 * Pick an app usable on this server and the scopes to grant, then confirm. MCP Apps the Agent does
 * not have (never granted automatically, or revoked) are offered here too, exactly where an ordinary
 * App is granted again; they have no scopes, and choose a Connection instead (`useMcpGrantChoice`).
 */
function GrantAccessForm({
  agentId,
  mcpApps,
  onDone,
  onCancel,
}: {
  agentId: string;
  mcpApps: GrantableApp[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { formatMessage } = useIntl();
  const [apps, setApps] = useState<GrantableApp[] | null>(null);
  const [selected, setSelected] = useState<GrantableApp | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const mcpChoice = useMcpGrantChoice(agentId, selected?.kind === "mcp" ? selected.clientId : null);

  useEffect(() => {
    let canceled = false;
    api.get(`/integrations/agents/${agentId}/grantable-apps`)
      .then(({ data }) => { if (!canceled) setApps(data.apps ?? []); })
      .catch((err) => { if (!canceled) setError(errorText(err, formatMessage({ id: "agent.apps.loadGrantableFailed" }))); });
    return () => { canceled = true; };
  }, [agentId, formatMessage]);

  const choose = useCallback((app: GrantableApp) => {
    setSelected(app);
    setScopes(app.scopes);
  }, []);

  const toggleScope = useCallback((scope: string, checked: boolean) => {
    setScopes((prev) => checked ? [...prev, scope] : prev.filter((s) => s !== scope));
  }, []);

  const submit = useCallback(async () => {
    if (!selected || (selected.kind !== "mcp" && scopes.length === 0)) return;
    if (selected.kind === "mcp" && !mcpChoice.ready) return;
    setSaving(true);
    setError("");
    try {
      if (selected.kind === "mcp") await api.put(`/mcp/agents/${agentId}/assignments/${selected.clientId}`, mcpChoice.body());
      else await api.post(`/integrations/agents/${agentId}/grants`, { clientId: selected.clientId, scopes });
      onDone();
    } catch (err) {
      setError(selected.kind === "mcp" ? mcpAppErrorMessage(err, formatMessage) : errorText(err, formatMessage({ id: "agent.apps.grantFailed" })));
    } finally {
      setSaving(false);
    }
  }, [agentId, selected, scopes, onDone, formatMessage, mcpChoice]);

  const handleSubmit = useCallback(() => { void submit(); }, [submit]);

  return (
    <SurfaceListItem className="stack-y-3" interactive={false} data-testid="agent-grant-access-form">
      <div>
        <div className="text-subhead font-semibold text-foreground">{formatMessage({ id: "agent.apps.grantTitle" })}</div>
        <div className="mt-0.5 text-callout text-foreground-muted">{formatMessage({ id: "agent.apps.grantDescription" })}</div>
      </div>
      {error && <Banner intent="warning" density="sm">{error}</Banner>}
      {apps === null && mcpApps.length === 0 ? (
        !error && <div className="text-caption text-foreground-hint">{formatMessage({ id: "common.loading" })}</div>
      ) : (apps ?? []).length === 0 && mcpApps.length === 0 ? (
        <div className="text-callout text-foreground-hint">{formatMessage({ id: "agent.apps.noGrantableApps" })}</div>
      ) : (
        <ListRowGroup>
          {[...(apps ?? []), ...mcpApps].map((app) => (
            <GrantableAppOption key={app.clientId} app={app} selected={selected?.clientId === app.clientId} onChoose={choose} />
          ))}
        </ListRowGroup>
      )}
      {selected && selected.kind !== "mcp" && (
        <div className="stack-y-1">
          <div className="text-footnote font-semibold text-foreground-muted">{formatMessage({ id: "agent.apps.grantScopes" })}</div>
          {selected.scopes.map((scope) => (
            <GrantScopeCheckbox key={scope} scope={scope} checked={scopes.includes(scope)} onToggle={toggleScope} />
          ))}
        </div>
      )}
      {selected?.kind === "mcp" ? <McpGrantConnectionSection choice={mcpChoice} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="md" onClick={onCancel}>{formatMessage({ id: "agent.detail.cancel" })}</Button>
        <Button
          variant="primary"
          size="md"
          onClick={handleSubmit}
          disabled={!selected || (selected.kind !== "mcp" && scopes.length === 0) || (selected.kind === "mcp" && !mcpChoice.ready) || saving}
          data-testid="agent-grant-access-confirm"
        >
          {formatMessage({ id: "agent.apps.grantConfirm" })}
        </Button>
      </div>
    </SurfaceListItem>
  );
}

function McpGrantConnectionSection({ choice }: { choice: ReturnType<typeof useMcpGrantChoice> }) {
  const { formatMessage } = useIntl();
  if (choice.view === "failed") return <Banner intent="warning" density="sm">{formatMessage({ id: "agent.mcpApps.drawer.loadFailed" })}</Banner>;
  if (choice.view === null) return <div className="text-caption text-foreground-hint">{formatMessage({ id: "common.loading" })}</div>;
  if (!choice.needsChoice) return null;
  const usable = choice.candidates.some((candidate) => candidate.status === "ready");
  return (
    <div className="stack-y-1" data-testid="agent-grant-mcp-connection">
      <div className="text-footnote font-semibold text-foreground-muted">{formatMessage({ id: "agent.apps.mcpGrantConnection" })}</div>
      {choice.candidates.length > 0 ? (
        <McpConnectionCandidates candidates={choice.candidates} value={choice.selected} onChange={choice.setPicked} testIdPrefix="agent-grant-mcp" />
      ) : null}
      {!usable ? (
        <div className="text-footnote text-foreground-muted" data-testid="agent-grant-mcp-no-connection">
          {formatMessage({ id: "agent.apps.mcpGrantNoConnection" })}
        </div>
      ) : null}
    </div>
  );
}

function AppEventRow({ agentId, event }: { agentId: string; event: AgentAppEventSummary }) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<AgentAppEventDetail | null>(null);
  const [error, setError] = useState("");

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (!next || detail) return;
    try {
      const { data } = await api.get(`/integrations/agents/${agentId}/events/${event.id}`);
      setDetail(data);
    } catch (err) {
      setError(errorText(err, formatMessage({ id: "agent.apps.loadEventFailed" })));
    }
  }, [open, detail, agentId, event.id, formatMessage]);
  const handleToggle = useCallback(() => { void toggle(); }, [toggle]);

  // A raft-ui ListRow (`plain`: no leading block, the hairline from the 16px
  // edge) that opens the event's payload under it. The group is a list, so
  // the hairline runs between two `li`s.
  return (
    <li>
      <ListRow variant="plain" onClick={handleToggle} aria-expanded={open}>
        <ListRowBody>
          <ListRowTop>
            <ListRowTitle>{event.summary}</ListRowTitle>
            <Badge appearance="soft" variant={EVENT_STATUS_VARIANT[event.status]} className="shrink-0">
              <StatusDot tone={EVENT_STATUS_PIXEL[event.status]} />
              {formatMessage({ id: `agent.apps.eventStatus.${event.status}` as MessageId })}
            </Badge>
          </ListRowTop>
          <ListRowBottom>
            <ListRowDescription>{event.app.name}</ListRowDescription>
            <ListRowMeta>{event.kind}</ListRowMeta>
            <ListRowMeta>{formatShortDateTime(event.createdAt)}</ListRowMeta>
          </ListRowBottom>
        </ListRowBody>
      </ListRow>
      {open && (
        <div className="px-4 pb-3">
          {error ? (
            <Banner intent="warning" density="sm">{error}</Banner>
          ) : detail ? (
            // App-supplied data: shown as inert JSON text, never rendered as links or markup.
            // The code frame scrolls in a raft-ui ScrollArea (the <pre> wraps,
            // so only down), named after the event. It sits in the tab's
            // scroller, so a scroll at its end carries on to the page.
            <ScrollArea
              role="region"
              aria-label={event.summary}
              overscroll="auto"
              className="max-h-64 rounded-container border border-line-hairline bg-layer-code"
            >
              <pre className="m-0 whitespace-pre-wrap break-all px-3 py-2 font-mono text-mono-code text-foreground">
                {JSON.stringify(detail.payload, null, 2)}
              </pre>
            </ScrollArea>
          ) : (
            <div className="text-caption text-foreground-hint">{formatMessage({ id: "common.loading" })}</div>
          )}
        </div>
      )}
    </li>
  );
}

/** Recent events apps sent to this agent, newest first, filterable by app. */
function AgentAppEventsSection({ agentId }: { agentId: string }) {
  const { formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const [events, setEvents] = useState<AgentAppEventSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [appFilter, setAppFilter] = useState<string | null>(null);
  const [apps, setApps] = useState<Array<{ clientId: string; name: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (cursor: string | null) => {
    setLoading(true);
    setError("");
    try {
      const params: Record<string, string> = {};
      if (appFilter) params.clientId = appFilter;
      if (cursor) params.before = cursor;
      const { data } = await api.get(`/integrations/agents/${agentId}/events`, { params });
      const page = data as AgentAppEventListResponse;
      setEvents((prev) => cursor ? [...prev, ...page.events] : page.events);
      setNextCursor(page.nextCursor);
      if (!appFilter) {
        // Filter chips come from the apps seen so far in the unfiltered list.
        setApps((prev) => {
          const byId = new Map(prev.map((app) => [app.clientId, app]));
          for (const event of page.events) byId.set(event.app.clientId, { clientId: event.app.clientId, name: event.app.name });
          return [...byId.values()];
        });
      }
    } catch (err) {
      setError(errorText(err, formatMessageRef.current({ id: "agent.apps.loadEventsFailed" })));
    } finally {
      setLoading(false);
    }
  }, [agentId, appFilter]);

  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-derived-state -- async loading indicator, same pattern as the grants list
    void load(null);
  }, [load]);

  const reload = useCallback(() => { void load(null); }, [load]);
  const loadMore = useCallback(() => { void load(nextCursor); }, [load, nextCursor]);

  return (
    <div className="stack-y-3" data-testid="agent-app-events">
      <div>
        <SectionHeader
          label={formatMessage({ id: "agent.apps.eventsTitle" })}
          action={
            <Button variant="outline" size="md" onClick={reload} disabled={loading}>
              {loading ? formatMessage({ id: "common.loading" }) : formatMessage({ id: "agent.apps.refresh" })}
            </Button>
          }
        />
        <div className="mt-1 text-callout text-foreground-muted">{formatMessage({ id: "agent.apps.eventsDescription" })}</div>
      </div>
      {apps.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <AppEventFilterButton clientId={null} active={appFilter === null} onSelect={setAppFilter}>
            {formatMessage({ id: "agent.apps.allApps" })}
          </AppEventFilterButton>
          {apps.map((app) => (
            <AppEventFilterButton key={app.clientId} clientId={app.clientId} active={appFilter === app.clientId} onSelect={setAppFilter}>
              {app.name}
            </AppEventFilterButton>
          ))}
        </div>
      )}
      {error && <Banner intent="warning" density="sm">{error}</Banner>}
      {events.length === 0 && !loading && !error ? (
        <div className="text-callout text-foreground-hint">{formatMessage({ id: "agent.apps.noEvents" })}</div>
      ) : events.length > 0 ? (
        <ListRowGroup render={<ul />}>
          {events.map((event) => <AppEventRow key={event.id} agentId={agentId} event={event} />)}
        </ListRowGroup>
      ) : null}
      {nextCursor && (
        <Button variant="outline" size="md" onClick={loadMore} disabled={loading}>
          {formatMessage({ id: "agent.apps.loadMore" })}
        </Button>
      )}
    </div>
  );
}

/**
 * The Agent panel's Apps tab, one list for every kind of App: each MCP App with this Agent's
 * Connection state (the server default, pinned, needs sign-in, authorization expired, switched off)
 * and the apps that can act for this agent (and how they got access); then pending requests,
 * granting access on the agent's behalf, and the events apps sent to it.
 *
 * An MCP App is shown like an ordinary App's grant: only while the Agent has it (granted
 * automatically or by a person), with the same source line, status and Revoke; a revoked or never
 * granted one is offered by Grant access, as an ordinary App is. Its one extra is the Connection.
 *
 * `canManageAgentAccess` -- the agent's creator or `manageExternalAuth` -- governs every action for
 * both kinds (grant, revoke, approve, and an MCP App's Connection). The server enforces the same
 * rule; without it the rows are read-only.
 */
export default function AgentAppAccessTab({
  agentId,
  canManageAgentAccess,
}: {
  agentId: string;
  canManageAgentAccess: boolean;
}) {
  const { formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const { formatShortDateTime } = useTimeFormatter();
  const [items, setItems] = useState<AgentIntegrationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [granting, setGranting] = useState(false);
  const [mcpApps, setMcpApps] = useState<ManagedMcpServerView[]>([]);
  const [mcpError, setMcpError] = useState("");
  const [changing, setChanging] = useState<ManagedMcpServerView | null>(null);
  /** An ordinary App's Revoke being confirmed: the grants still to revoke, and whether a try failed. */
  const [revoking, setRevoking] = useState<(RevokeAppGrantsTarget & { failures: Record<string, RevokeGrantFailure> | null }) | null>(null);
  /** Where focus goes when a revoke closes its dialog (set just before); null returns it to the opener. */
  const revokeFocusRef = useRef<HTMLElement | null>(null);
  const appsSectionRef = useRef<HTMLDivElement | null>(null);
  const grantAccessRef = useRef<HTMLButtonElement | null>(null);
  // Another Agent: drop everything shown for the previous one at once (during render, before paint),
  // so neither its rows nor an open form or drawer carry over while the new Agent's Apps load.
  // oxlint-disable-next-line react-doctor/no-derived-useState -- deliberately the PREVIOUS agentId, compared below to reset on change (React's "adjust state during render" pattern).
  const [shownAgentId, setShownAgentId] = useState(agentId);
  if (shownAgentId !== agentId) {
    setShownAgentId(agentId);
    setItems([]);
    setMcpApps([]);
    setGranting(false);
    setChanging(null);
    setRevoking(null);
  }

  // Each load is numbered; only the latest one may write. Switching Agents also clears the lists at
  // once, so a slow answer (or a failure) for one Agent never shows another Agent's Apps.
  const mcpRequestRef = useRef(0);
  const loadMcpApps = useCallback(async () => {
    const request = ++mcpRequestRef.current;
    setMcpError("");
    try {
      const { data } = await api.get<ManagedMcpAgentCatalogResponse>(`/mcp/agents/${agentId}`);
      if (request === mcpRequestRef.current) setMcpApps(data.servers);
    } catch (err) {
      if (request === mcpRequestRef.current) setMcpError(errorText(err, formatMessageRef.current({ id: "agent.mcpApps.loadFailed" })));
    }
  }, [agentId]);

  useEffect(() => {
    void loadMcpApps();
  }, [loadMcpApps]);

  // An MCP App's Revoke changes the Agent (others) and can be changed back exactly: the
  // assignment keeps its Connection and tool restriction, and `enabled: true` with nothing else
  // restores them (managedMcpService.setManagedMcpAssignment). So it acts at once and offers
  // Undo (Raft DS › Feedback, "Confirming"). An ordinary App's Revoke can't be (below).
  // The Undo toast outlives a switch to another Agent: its write still goes to the Agent it was
  // revoked on, but only that Agent's tab may reload or show its error.
  const shownAgentRef = useRef(agentId);
  shownAgentRef.current = agentId;
  const setMcpEnabled = useCallback(async (server: ManagedMcpServerView, enabled: boolean) => {
    const stillShown = () => shownAgentRef.current === agentId;
    if (stillShown()) setMcpError("");
    try {
      await api.put(`/mcp/agents/${agentId}/assignments/${server.id}`, { enabled });
      if (stillShown()) await loadMcpApps();
      return true;
    } catch (err) {
      if (stillShown()) setMcpError(errorText(err, formatMessageRef.current({ id: enabled ? "agent.mcpApps.undoRevokeFailed" : "agent.detail.revokeIntegrationFailed" })));
      return false;
    }
  }, [agentId, loadMcpApps]);
  const handleRevokeMcpApp = useCallback((server: ManagedMcpServerView) => {
    // The undo events stay on the server the revoke was made on (the toast lasts 8 seconds).
    const serverId = useServerStore.getState().current?.id;
    void setMcpEnabled(server, false).then((revoked) => {
      if (!revoked) return;
      trackUndoOffered("mcp_app_revoke", serverId);
      const toastId = toast.success(formatMessageRef.current({ id: "agent.mcpApps.revokedToast" }, { app: server.name }), {
        action: {
          label: formatMessageRef.current({ id: "agent.mcpApps.revokeUndo" }),
          onClick: () => {
            toast.dismiss(toastId);
            void setMcpEnabled(server, true).then((restored) => {
              trackUndoUsed("mcp_app_revoke", restored ? "undone" : "failed", serverId);
            });
          },
        },
      });
    });
  }, [setMcpEnabled]);
  // An ordinary App's Revoke takes what granting again doesn't give back: its tokens are revoked
  // and its automatic grant is blocked (oauthService.revokeGrant), so the App has to ask again.
  // So it asks first (Raft DS › Feedback, "Confirming": a key others hold stops working).
  const closeRevoke = useCallback(() => setRevoking(null), []);

  const closeChange = useCallback(() => setChanging(null), []);
  const finishChange = useCallback(() => {
    setChanging(null);
    void loadMcpApps();
  }, [loadMcpApps]);

  const grantsRequestRef = useRef(0);
  /** Loads the Agent's requests and grants; resolves to them, or null when the load failed. */
  const load = useCallback(async (): Promise<AgentIntegrationItem[] | null> => {
    const request = ++grantsRequestRef.current;
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get<AgentIntegrationItem[]>(`/integrations/agents/${agentId}`);
      if (request === grantsRequestRef.current) setItems(data);
      return data;
    } catch (err) {
      if (request === grantsRequestRef.current) setError(errorText(err, formatMessageRef.current({ id: "agent.detail.loadIntegrationsFailed" })));
      return null;
    } finally {
      if (request === grantsRequestRef.current) setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-derived-state -- async loading indicator (set at request start, cleared in finally)
    void load();
  }, [load]);

  const act = useCallback(async (path: string, body: unknown, fallbackId: MessageId) => {
    setError("");
    try {
      // Approving an app's access: a sign-in that passed the second step (403
      // second_factor_step_up_required otherwise); deny and revoke never are.
      await withSecondFactorStepUp(() => api.post(path, body), "agentAccess");
      await load();
    } catch (err) {
      if (isSecondFactorStepUpCancelled(err)) return;
      setError(errorText(err, formatMessage({ id: fallbackId })));
    }
  }, [load, formatMessage]);

  // The API revokes one grant at a time, so an App's Revoke access revokes each of its grants in
  // turn. A grant that revoked leaves the list at once, as does one the server no longer has (404
  // "Grant not found": there is nothing left to revoke, and keeping it would offer a Try again
  // that can only fail the same way while the reload is down). Then the list is reloaded, and
  // whatever still stands of the failed ones stays in the dialog with why. A failed write may
  // still have landed (its outcome unknown), so nothing is retried without a press; the reload
  // drops it if it did land. A refused grant (403) is not retried by Try again either.
  const confirmRevoke = useCallback(async () => {
    if (!revoking) return;
    const target = revoking;
    const failures: Record<string, RevokeGrantFailure> = {};
    const revoked: string[] = [];
    for (const grantId of target.grantIds) {
      const earlier = target.failures?.[grantId];
      if (earlier?.kind === "refused") {
        failures[grantId] = earlier;
        continue;
      }
      try {
        await api.post(`/integrations/grants/${grantId}/revoke`, EMPTY_BODY);
        revoked.push(grantId);
      } catch (err) {
        if ((err as { response?: { status?: number } })?.response?.status === 404) revoked.push(grantId);
        else failures[grantId] = revokeGrantFailure(err);
      }
    }
    if (shownAgentRef.current !== agentId) return;
    setItems((prev) => prev.filter((item) => !revoked.includes(item.id)));
    const fresh = await load();
    if (shownAgentRef.current !== agentId) return;
    const standing = fresh === null ? null : new Set(fresh.filter((item) => item.type === "active").map((item) => item.id));
    const remaining = Object.keys(failures).filter((grantId) => standing === null || standing.has(grantId));
    if (remaining.length > 0) {
      setRevoking({ ...target, grantIds: remaining, failures: Object.fromEntries(remaining.map((grantId) => [grantId, failures[grantId]!])) });
      return;
    }
    // Done: the control that opened the dialog is gone with what it revoked. Focus goes to the
    // nearest related one (Raft DS › Accessibility): this App's own Revoke access when it keeps
    // other grants, else the next App's (the previous one's at the end of the list), else the
    // section's Grant access, else the Apps section itself.
    const left = (fresh ?? items).filter((item) => !revoked.includes(item.id));
    const section = appsSectionRef.current;
    const nextRevoke = appsToFocusAfterRevoke(items, left, target)
      .map((clientId) => section?.querySelector<HTMLElement>(`[data-testid="agent-app-revoke-${CSS.escape(clientId)}"]`) ?? null)
      .find((element) => element !== null);
    revokeFocusRef.current = nextRevoke ?? grantAccessRef.current ?? section;
    setRevoking(null);
  }, [agentId, items, load, revoking]);
  const startRevoke = useCallback((target: RevokeAppGrantsTarget) => {
    revokeFocusRef.current = null;
    setRevoking({ ...target, failures: null });
  }, []);

  const startGranting = useCallback(() => setGranting(true), []);
  const cancelGranting = useCallback(() => setGranting(false), []);
  const finishGranting = useCallback(() => {
    setGranting(false);
    void load();
    void loadMcpApps();
  }, [load, loadMcpApps]);

  const pending = items.filter((item) => item.type === "pending");
  // One row per App (`clientId`), however many grants it holds.
  const apps = useMemo(() => groupGrantsByApp(items), [items]);
  /** The grants the open Revoke still has to take, as the list now has them (revoked ones gone). */
  const revokingGrants = useMemo(
    () => (revoking ? items.filter((item) => item.type === "active" && revoking.grantIds.includes(item.id)) : []),
    [items, revoking],
  );
  const grantedMcpApps = useMemo(() => mcpApps.filter(agentHasMcpApp), [mcpApps]);
  const grantableMcpApps = useMemo(() => mcpApps.filter((server) => !agentHasMcpApp(server)).map(mcpGrantableApp), [mcpApps]);

  return (
    // The Apps tab scrolls in a raft-ui ScrollArea, its padding and spacing
    // on the content; a tab stop once it overflows, named like the tab.
    <ScrollArea
      role="region"
      aria-label={formatMessage({ id: "agent.detail.tab.apps" })}
      className="flex-1 bg-layer-canvas"
      contentClassName="stack-y-6 px-(--surface-inset) py-4"
    >
      {error && <Banner intent="warning" density="sm">{error}</Banner>}
      {mcpError && <Banner intent="warning" density="sm">{mcpError}</Banner>}

      {pending.length > 0 && (
        <div className="stack-y-3" data-testid="agent-app-pending">
          <SectionHeader label={formatMessage({ id: "agent.apps.pendingTitle" })} count={pending.length} />
          <ListRowGroup>
            {pending.map((item) => (
              <AppRow key={item.id}>
                <div className="min-w-0 flex-1 stack-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="break-words text-subhead font-semibold text-foreground">{item.clientName}</div>
                      <div className="font-mono text-mono-meta text-foreground-hint">{formatShortDateTime(item.createdAt)}</div>
                    </div>
                    <Badge appearance="soft" variant="warning">
                      <StatusDot tone="bg-task-status-todo" />
                      {formatMessage({ id: "agent.apps.pending" })}
                    </Badge>
                  </div>
                  <ScopeChips scopes={item.scopes} />
                  {canManageAgentAccess && (
                    <div className="flex flex-wrap gap-2">
                      <IntegrationActionButton path={`/integrations/requests/${item.id}/approve`} body={APPROVE_REQUEST_BODY} failureMessageId="agent.apps.approveFailed" onAct={act}>
                        {formatMessage({ id: "agent.apps.approve" })}
                      </IntegrationActionButton>
                      <IntegrationActionButton variant="outline" path={`/integrations/requests/${item.id}/deny`} body={EMPTY_BODY} failureMessageId="agent.apps.denyFailed" onAct={act}>
                        {formatMessage({ id: "agent.apps.deny" })}
                      </IntegrationActionButton>
                    </div>
                  )}
                </div>
              </AppRow>
            ))}
          </ListRowGroup>
        </div>
      )}

      <div
        ref={appsSectionRef}
        tabIndex={-1}
        role="group"
        aria-label={formatMessage({ id: "agent.detail.applications" })}
        className="stack-y-3 outline-none"
        data-testid="agent-apps-section"
      >
        <SectionHeader
          label={formatMessage({ id: "agent.detail.applications" })}
          action={loading
            ? <span className="text-caption text-foreground-hint">{formatMessage({ id: "common.loading" })}</span>
            : canManageAgentAccess && !granting
              ? <Button ref={grantAccessRef} variant="outline" size="md" onClick={startGranting}>{formatMessage({ id: "agent.apps.grantAccess" })}</Button>
              : null}
        />
        {granting && (
          <GrantAccessForm
            agentId={agentId}
            mcpApps={grantableMcpApps}
            onCancel={cancelGranting}
            onDone={finishGranting}
          />
        )}
        {apps.length === 0 && grantedMcpApps.length === 0 ? (
          <div className="text-callout text-foreground-hint">{formatMessage({ id: "agent.detail.noConnectedApps" })}</div>
        ) : (
          <ListRowGroup data-testid="agent-apps-list">
            {grantedMcpApps.map((server) => (
              <AgentMcpAppRow key={server.id} server={server} canChange={canManageAgentAccess} onChange={setChanging} onRevoke={handleRevokeMcpApp} />
            ))}
            {apps.map((app) => (
              <AgentAppGrantsRow key={app.clientId} app={app} canManageAgentAccess={canManageAgentAccess} onRevoke={startRevoke} />
            ))}
          </ListRowGroup>
        )}
      </div>

      <AgentAppEventsSection agentId={agentId} />

      {revoking && canManageAgentAccess ? (
        <RevokeAppGrantsDialog
          appName={revoking.name}
          whole={revoking.whole}
          grants={revokingGrants}
          failures={revoking.failures}
          finalFocus={revokeFocusRef}
          onConfirm={confirmRevoke}
          onClose={closeRevoke}
        />
      ) : null}

      {changing && canManageAgentAccess ? (
        <McpAgentConnectionDrawer agentId={agentId} server={changing} onClose={closeChange} onSaved={finishChange} />
      ) : null}
    </ScrollArea>
  );
}
