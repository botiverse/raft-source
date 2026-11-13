import {
  Badge,
  Button,
  Checkbox,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Input,
  RadioGroup,
  RadioGroupItem,
} from "@botiverse/raft-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import type { ManagedMcpServerView } from "@botiverse/raft-shared";
import api from "../../api/client";
import Banner from "../ui/Banner";
import { mcpAppErrorMessage } from "../settings/mcpApps/mcpAppApi";
import type { McpConnectionAuthorizationView } from "../settings/mcpApps/mcpAppApi";
import { useMcpOAuthSignIn } from "../settings/mcpApps/useMcpOAuthSignIn";
import type { McpOAuthOutcome } from "../settings/mcpApps/useMcpOAuthSignIn";
import { agentMcpConnection } from "./AgentMcpAppRow";
import { CONNECTION_STATUS_MESSAGE_ID } from "./mcpConnectionStatusMessages";

type Choice = "default" | "new" | `pin:${string}`;

const PIN_PREFIX = "pin:";

function Option({ value, testId, label, description, disabled = false }: { value: Choice; testId: string; label: string; description?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? "opacity-60" : ""}`}>
      <RadioGroupItem value={value} disabled={disabled} className="mt-0.5 shrink-0" data-testid={testId} />
      <span className="min-w-0">
        <span className="block text-subhead font-bold text-foreground">{label}</span>
        {description ? <span className="mt-0.5 block text-caption text-foreground-muted">{description}</span> : null}
      </span>
    </label>
  );
}

/**
 * Choose which Connection ONE Agent uses for an MCP App it has (E2): follow the server default, pin
 * one Connection, or authorize a new Connection (OAuth) and pin it. Revoking the App for the Agent
 * is the row's Revoke, as for an ordinary App, not a choice here.
 *
 * Every option comes from the viewer-scoped `connection-authorization` projection. A save sends
 * only `connectionId` (null = the server default), so a tool restriction is never lifted by
 * changing the Connection. `enabled: true` is added only if the Agent does not have the App.
 */
export function McpAgentConnectionDrawer({
  agentId,
  server,
  onClose,
  onSaved,
}: {
  agentId: string;
  server: ManagedMcpServerView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { formatMessage } = useIntl();
  const current = agentMcpConnection(server);
  const isOff = current.mode === "off";
  const [loaded, setLoaded] = useState<{ view: McpConnectionAuthorizationView } | "failed" | null>(null);
  /** What the person picked; `undefined` until they pick, so the current choice shows first. */
  const [picked, setPicked] = useState<Choice | null | undefined>(undefined);
  /** The new Connection's name as typed; until then the App's name. */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let canceled = false;
    api.get<McpConnectionAuthorizationView>(`/mcp/servers/${server.id}/connection-authorization`, { params: { agentId } })
      .then(({ data }) => { if (!canceled) setLoaded({ view: data }); })
      .catch(() => { if (!canceled) setLoaded("failed"); });
    return () => { canceled = true; };
  }, [agentId, server.id]);

  const view = loaded !== null && loaded !== "failed" ? loaded.view : null;
  const loadFailed = loaded === "failed";
  // The current choice is preselected; a pin this viewer cannot see (or that is gone) is not, and
  // neither is "the server default" while the App has none (nothing would be chosen by it).
  const hasServerDefault = server.authMode === "none" || (view?.candidates.some((candidate) => candidate.isServerDefault) ?? false);
  const initialChoice: Choice | null = view === null
    ? null
    : isOff
      ? null
      : view.binding.present
        ? view.binding.visibleToViewer && view.binding.connectionId ? `${PIN_PREFIX}${view.binding.connectionId}` : null
        : hasServerDefault ? "default" : null;
  const choice = picked === undefined ? initialChoice : picked;
  const newName = nameDraft ?? server.name;

  const put = useCallback(async (body: { connectionId?: string | null; enabled?: boolean }) => {
    await api.put(`/mcp/agents/${agentId}/assignments/${server.id}`, body);
  }, [agentId, server.id]);


  /** Whether the sign-in being waited for asked to become the App's server default. */
  const makeDefaultRef = useRef(false);
  // The box for a new Connection: only when the App has no default and the viewer may set one
  // (with a default, changing it belongs to the Connect card or the App's settings, with the impact
  // shown); pre-checked, and the person may uncheck it.
  const offerMakeDefault = !hasServerDefault && view?.canSetServerDefault === true;
  const [makeNewDefault, setMakeNewDefault] = useState(true);
  // A Connection this viewer authorizes is theirs: this Agent may use it only if they are its owner,
  // or as the server default. So for anyone else it must become the default (the box is locked
  // checked), and where they cannot make it one the option is not offered.
  const newNotPinnable = view?.newConnectionPinnable === false;
  const newMustBeDefault = newNotPinnable && offerMakeDefault;
  const makeNewDefaultChecked = newMustBeDefault || makeNewDefault;
  const handleMakeNewDefault = useCallback((checked: boolean) => setMakeNewDefault(checked), []);
  const isServerDefaultNow = useCallback(async (connectionId: string) => {
    try {
      const { data } = await api.get<McpConnectionAuthorizationView>(`/mcp/servers/${server.id}/connection-authorization`, { params: { agentId } });
      return data.candidates.some((candidate) => candidate.connectionId === connectionId && candidate.isServerDefault);
    } catch {
      return false;
    }
  }, [agentId, server.id]);

  const handleOAuthOutcome = useCallback(async (outcome: McpOAuthOutcome) => {
    if (outcome.kind === "expired" || outcome.kind === "closed") {
      setError(formatMessage({
        id: outcome.kind === "expired" ? "settings.mcpApp.connections.signInExpired" : "settings.mcpApp.connections.signInWindowClosed",
      }));
      return;
    }
    if (outcome.kind !== "connected" || !outcome.connectionId) {
      setError(formatMessage({ id: "agent.mcpApps.drawer.signInFailed" }));
      return;
    }
    // The server never binds an Agent on sign-in; this step does. A sign-in started as the App's
    // first default (see `save`) is followed if the server really made it the default; otherwise,
    // and whenever the App already had a default, the new Connection is pinned to this Agent.
    setSaving(true);
    try {
      const becameDefault = makeDefaultRef.current && await isServerDefaultNow(outcome.connectionId);
      await put({ connectionId: becameDefault ? null : outcome.connectionId, ...(isOff ? { enabled: true } : {}) });
      onSaved();
    } catch (err) {
      setError(mcpAppErrorMessage(err, formatMessage));
    } finally {
      setSaving(false);
    }
  }, [formatMessage, isOff, isServerDefaultNow, onSaved, put]);
  const handleOAuthStartError = useCallback((err: unknown) => setError(mcpAppErrorMessage(err, formatMessage)), [formatMessage]);
  const { start: startOAuth, cancel: cancelOAuth, openSignInPage, blockedUrl, waiting, starting } = useMcpOAuthSignIn({
    appId: server.id,
    onOutcome: (outcome) => { void handleOAuthOutcome(outcome); },
    onStartError: handleOAuthStartError,
  });

  const save = useCallback(async () => {
    if (!choice) return;
    setError("");
    if (choice === "new") {
      // Only the person's checked box makes it the default (offered, pre-checked, when the App has
      // none and they may set one); otherwise the new Connection is pinned to this Agent.
      makeDefaultRef.current = offerMakeDefault && makeNewDefaultChecked;
      await startOAuth({ name: newName.trim(), makeDefault: makeDefaultRef.current });
      return;
    }
    setSaving(true);
    try {
      // Turning an Agent back on is a separate fact from choosing a Connection: sent only when it is off.
      const reenable = isOff ? { enabled: true } : {};
      if (choice === "default") await put({ connectionId: null, ...reenable });
      else await put({ connectionId: choice.slice(PIN_PREFIX.length), ...reenable });
      onSaved();
    } catch (err) {
      setError(mcpAppErrorMessage(err, formatMessage));
    } finally {
      setSaving(false);
    }
  }, [choice, formatMessage, isOff, makeNewDefaultChecked, newName, offerMakeDefault, onSaved, put, startOAuth]);

  // Closing the drawer (Cancel, Esc, swipe, outside click) also ends a sign-in in progress, so the
  // popup is closed and a later "connected" cannot pin a Connection behind the person's back.
  const close = useCallback(() => {
    cancelOAuth();
    onClose();
  }, [cancelOAuth, onClose]);
  const handleOpenChange = useCallback((open: boolean) => { if (!open) close(); }, [close]);
  const handleChoice = useCallback((value: unknown) => { setPicked(value as Choice); setError(""); }, []);
  const handleNameChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setNameDraft(event.target.value), []);
  const handleSave = useCallback(() => { void save(); }, [save]);

  const unnamed = formatMessage({ id: "settings.mcpApp.connections.unnamed" });
  const defaultCandidate = view?.candidates.find((candidate) => candidate.isServerDefault) ?? null;
  const needsConnection = server.authMode !== "none";
  const canManage = view !== null && view.viewerRole !== "observer";
  const newDisabledReason = !view?.canAuthorizeNew
    ? formatMessage({ id: "agent.mcpApps.drawer.newNotAllowed" })
    : server.authMode === "headers"
      ? formatMessage({ id: "agent.mcpApps.drawer.newHeadersElsewhere" })
      : newNotPinnable && !offerMakeDefault
        ? formatMessage({ id: "agent.mcpApps.drawer.newNotOwner" })
        : null;
  const unchanged = choice === initialChoice;
  const busy = saving || starting || waiting;

  return (
    <Drawer open onOpenChange={handleOpenChange} swipeDirection="right">
      <DrawerContent data-testid="mcp-agent-connection-drawer">
        <DrawerHeader>
          {/* A side drawer's header is a row (title | close); the title fills its cell. */}
          <div className="min-w-0 flex-1" data-testid="mcp-agent-connection-heading">
            <DrawerTitle>{formatMessage({ id: "agent.mcpApps.drawer.title" }, { name: server.name })}</DrawerTitle>
          </div>
        </DrawerHeader>
        <DrawerBody className="stack-y-4 md:pointer-fine:stack-y-3">
          {error ? <Banner intent="warning" density="sm" className="font-bold" data-testid="mcp-agent-connection-error">{error}</Banner> : null}
          {loadFailed ? (
            <Banner intent="warning" density="sm">{formatMessage({ id: "agent.mcpApps.drawer.loadFailed" })}</Banner>
          ) : view === null ? (
            <div className="text-caption font-bold text-foreground-muted">{formatMessage({ id: "common.loading" })}</div>
          ) : !canManage ? (
            <Banner intent="info" density="sm">{formatMessage({ id: "agent.mcpApps.drawer.readOnly" })}</Banner>
          ) : (
            <>
              {view.binding.present && !view.binding.visibleToViewer && !isOff ? (
                <Banner intent="info" density="sm" data-testid="mcp-agent-connection-dead-pin">
                  {formatMessage({ id: "agent.mcpApps.drawer.deadPin" })}
                </Banner>
              ) : null}
              <RadioGroup
                value={choice ?? ""}
                onValueChange={handleChoice}
                // Locked while a sign-in is pending: what happens on success was decided when it started.
                disabled={waiting}
                aria-label={formatMessage({ id: "agent.mcpApps.drawer.title" }, { name: server.name })}
                className="gap-3"
              >
                <Option
                  value="default"
                  testId="mcp-agent-choice-default"
                  // Nothing to follow: the option says so and cannot be chosen.
                  disabled={!hasServerDefault}
                  label={formatMessage({ id: "agent.mcpApps.drawer.default" })}
                  description={!needsConnection
                    ? formatMessage({ id: "agent.mcpApps.row.noConnectionNeeded" })
                    : defaultCandidate
                      ? formatMessage({ id: "agent.mcpApps.drawer.defaultNamed" }, { name: defaultCandidate.name?.trim() || unnamed })
                      : formatMessage({ id: "agent.mcpApps.drawer.defaultNone" })}
                />
                {needsConnection ? (
                  <div className="stack-y-2">
                    <div className="text-subhead font-bold text-foreground">{formatMessage({ id: "agent.mcpApps.drawer.pin" })}</div>
                    <p className="text-caption text-foreground-muted">{formatMessage({ id: "agent.mcpApps.connection.pinnedHint" })}</p>
                    {view.candidates.length === 0 ? (
                      <div className="pl-7 text-caption text-foreground-muted">{formatMessage({ id: "agent.mcpApps.drawer.pinNone" })}</div>
                    ) : (
                      <div className="stack-y-2 pl-7">
                        {view.candidates.map((candidate) => (
                          <Option
                            key={candidate.connectionId}
                            value={`${PIN_PREFIX}${candidate.connectionId}`}
                            testId={`mcp-agent-choice-pin-${candidate.connectionId}`}
                            label={candidate.name?.trim() || unnamed}
                            description={(
                              <span className="inline-flex flex-wrap items-center gap-1.5">
                                {candidate.isServerDefault ? <Badge variant="success">{formatMessage({ id: "settings.mcpApp.connections.defaultBadge" })}</Badge> : null}
                                <span>{formatMessage({ id: CONNECTION_STATUS_MESSAGE_ID[candidate.status] })}</span>
                              </span>
                            )}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
                {needsConnection ? (
                  <Option
                    value="new"
                    testId="mcp-agent-choice-new"
                    disabled={newDisabledReason !== null}
                    label={formatMessage({ id: "agent.mcpApps.drawer.new" })}
                    description={newDisabledReason ?? formatMessage({ id: "agent.mcpApps.drawer.newDescription" })}
                  />
                ) : null}
              </RadioGroup>
              {choice === "new" ? (
                <label className="block stack-y-1 pl-7">
                  <span className="block text-footnote font-bold text-foreground">{formatMessage({ id: "agent.mcpApps.drawer.newName" })}</span>
                  <Input value={newName} onChange={handleNameChange} maxLength={120} className="w-full" data-testid="mcp-agent-new-name" />
                </label>
              ) : null}
              {choice === "new" && offerMakeDefault ? (
                <label className="flex items-start gap-2 pl-7 text-caption">
                  <Checkbox
                    checked={makeNewDefaultChecked}
                    disabled={waiting || newMustBeDefault}
                    onCheckedChange={handleMakeNewDefault}
                    aria-label={formatMessage({ id: "settings.mcpApp.connections.makeDefaultLabel" })}
                    data-testid="mcp-agent-new-make-default"
                  />
                  <span>
                    <span className="block font-bold text-foreground">{formatMessage({ id: "settings.mcpApp.connections.makeDefaultLabel" })}</span>
                    <span className="mt-1 block text-caption text-foreground-muted" data-testid="mcp-agent-new-make-default-hint">
                      {formatMessage({ id: newMustBeDefault ? "agent.mcpApps.drawer.newMustBeDefault" : "settings.mcpApp.connections.makeDefaultHint" })}
                    </span>
                  </span>
                </label>
              ) : null}
              {waiting ? (
                <Banner
                  intent="info"
                  density="sm"
                  data-testid="mcp-agent-oauth-waiting"
                  actions={(
                    <>
                      {blockedUrl ? (
                        <Button type="button" size="md" variant="primary" onClick={openSignInPage} data-testid="mcp-agent-open-sign-in">
                          {formatMessage({ id: "settings.mcpApp.connections.openSignInPage" })}
                        </Button>
                      ) : null}
                      <Button type="button" size="md" variant="outline" onClick={cancelOAuth} data-testid="mcp-agent-cancel-sign-in">
                        {formatMessage({ id: "settings.mcpApp.connections.cancelSignIn" })}
                      </Button>
                    </>
                  )}
                >
                  {formatMessage({ id: blockedUrl ? "settings.mcpApp.connections.popupBlocked" : "agent.mcpApps.drawer.waiting" })}
                </Banner>
              ) : null}
            </>
          )}
        </DrawerBody>
        <DrawerFooter className="flex justify-end gap-2">
          <Button variant="outline" size="md" onClick={close} data-testid="mcp-agent-connection-cancel">{formatMessage({ id: "common.confirm.cancel" })}</Button>
          {canManage ? (
            <Button
              size="md"
              onClick={handleSave}
              disabled={choice === null || unchanged || busy || (choice === "new" && !newName.trim())}
              data-testid="mcp-agent-connection-save"
            >
              {formatMessage({ id: saving ? "agent.mcpApps.drawer.saving" : "agent.mcpApps.drawer.save" })}
            </Button>
          ) : null}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
