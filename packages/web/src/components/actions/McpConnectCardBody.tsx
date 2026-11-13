/**
 * The body of an `integration:connect_mcp` action card: choosing and granting a Connection happens
 * in the card itself (D1–D5, mcp-app-card.png), not in a dialog.
 *
 * The card row stores only the App and Agent ids. Everything here is read for the person looking at
 * it from `GET /mcp/servers/:appId/connection-authorization?agentId=` on every mount, so a card opened
 * later, or by someone else, shows THEIR options:
 *
 *   D2  observer                    "Someone who can manage this Agent needs to connect this App."
 *   D1  may manage the Agent        candidate radios, Authorize new connection, Grant access to {agent};
 *                                   "Also make this the default for all Agents" only for a server
 *                                   manager (`canSetServerDefault`), disabled with its reason when the
 *                                   chosen Connection cannot become the default (D1b)
 *   D3  no candidates               empty state + Authorize new connection
 *   D4  a finished sign-in          "Ready to grant", Discard connection, Grant access to {agent}. A
 *                                   sign-in never grants by itself: the Agent gets the Connection only
 *                                   from the Grant click (server `pendingGrant` survives a reload)
 *   D5  default box ticked          the impact (`/default/impact`) is confirmed before any write
 *
 * Grant writes the Agent's assignment the way the Apps tab drawer does (`connectionId`, null = follow
 * the server default) plus `enabled: true`, then calls `onGranted`, which marks the card executed
 * (the server re-checks that the Agent is really admitted).
 */
import { Button, Checkbox } from "@botiverse/raft-ui";
import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import api from "../../api/client";
import ConfirmDialog from "../ConfirmDialog";
import Banner from "../ui/Banner";
import { initialMcpCandidate, mcpGrantConnectionId, McpConnectionCandidates } from "../agent/McpConnectionCandidates";
import type { McpConnectionCandidate } from "../agent/McpConnectionCandidates";
import { mcpAppErrorMessage } from "../settings/mcpApps/mcpAppApi";
import type { McpConnectionAuthorizationView, McpDefaultImpact } from "../settings/mcpApps/mcpAppApi";
import { useMcpOAuthSignIn } from "../settings/mcpApps/useMcpOAuthSignIn";
import type { McpOAuthOutcome } from "../settings/mcpApps/useMcpOAuthSignIn";

type Ready = { connectionId: string; name: string | null };

const NO_CANDIDATES: McpConnectionCandidate[] = [];

export function McpConnectCardBody({
  appId,
  agentId,
  agentName,
  actionCardMessageId,
  onGranted,
}: {
  appId: string;
  agentId: string;
  agentName: string;
  actionCardMessageId: string;
  /** The Agent's assignment was written; the caller marks the card executed. */
  onGranted: () => Promise<void> | void;
}) {
  const { formatMessage } = useIntl();
  const [view, setView] = useState<McpConnectionAuthorizationView | "failed" | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  /** A Connection signed in from this card (popup) that is not granted yet. */
  const [signedIn, setSignedIn] = useState<Ready | null>(null);
  /** The person's own choice for the default checkbox; until they touch it, checked only when the App has no default. */
  const [makeDefaultPicked, setMakeDefault] = useState<boolean | null>(null);
  const [impact, setImpact] = useState<{ connection: Ready; impact: McpDefaultImpact } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<McpConnectionAuthorizationView>(`/mcp/servers/${appId}/connection-authorization`, { params: { agentId } });
      setView(data);
    } catch {
      setView("failed");
    }
  }, [agentId, appId]);
  useEffect(() => { void load(); }, [load]);

  const loaded = view !== null && view !== "failed" ? view : null;
  const unnamed = formatMessage({ id: "settings.mcpApp.connections.unnamed" });
  const appName = loaded?.app?.name ?? "";
  const candidates = loaded?.candidates ?? NO_CANDIDATES;
  // D4: this card's own sign-in first, else one the server remembers for this viewer.
  const ready: Ready | null = signedIn ?? loaded?.pendingGrant ?? null;
  // D1: the server default when it is usable, else the first usable Connection.
  const selectedId = ready?.connectionId ?? picked ?? initialMcpCandidate(candidates);
  const selected: McpConnectionCandidate | null = candidates.find((candidate) => candidate.connectionId === selectedId) ?? null;
  const selectedName = (ready?.name ?? selected?.name)?.trim() || unnamed;
  const selectedIsDefault = selected?.isServerDefault === true;

  const handleOAuthOutcome = useCallback((outcome: McpOAuthOutcome) => {
    if (outcome.kind === "connected" && outcome.connectionId) {
      setError("");
      setSignedIn({ connectionId: outcome.connectionId, name: appName || null });
      void load();
      return;
    }
    setError(formatMessage({
      id: outcome.kind === "expired"
        ? "settings.mcpApp.connections.signInExpired"
        : outcome.kind === "closed" ? "settings.mcpApp.connections.signInWindowClosed" : "agent.mcpApps.drawer.signInFailed",
    }));
  }, [appName, formatMessage, load]);
  const handleStartError = useCallback((err: unknown) => setError(mcpAppErrorMessage(err, formatMessage)), [formatMessage]);
  const { start, cancel, openSignInPage, blockedUrl, waiting, starting } = useMcpOAuthSignIn({
    appId,
    onOutcome: handleOAuthOutcome,
    onStartError: handleStartError,
    onLateResult: () => { void load(); },
  });
  // Leaving the card (scroll-away unmount, channel switch) ends a sign-in in progress.
  useEffect(() => cancel, [cancel]);

  // An App with no default at all: the "make this the default" box starts CHECKED for a server
  // manager, who may uncheck it (then the Agent is pinned to this Connection only). Nothing becomes
  // the default without that box: a sign-in never sets one, and an App may well run with several
  // pinned Connections and no default.
  const noServerDefault = !candidates.some((candidate) => candidate.isServerDefault);
  // A Connection this viewer just signed in is theirs: if they are not this Agent's owner, the Agent
  // may use it only as the server default, so Grant makes it the default (the box is locked checked,
  // and the impact is still confirmed first).
  const signedInMustBeDefault = signedIn !== null && loaded?.newConnectionPinnable === false && loaded.canSetServerDefault;
  const makeDefault = signedInMustBeDefault || (makeDefaultPicked ?? noServerDefault);
  const handleAuthorizeNew = useCallback(() => {
    setError("");
    void start({ name: appName || unnamed, makeDefault: false, intent: { agentId, actionCardMessageId } });
  }, [actionCardMessageId, agentId, appName, start, unnamed]);

  /** Writes the Agent's assignment. Following the default is how the server default is granted. */
  const writeGrant = useCallback(async (connectionId: string | null) => {
    await api.put(`/mcp/agents/${agentId}/assignments/${appId}`, { connectionId, enabled: true });
    await onGranted();
  }, [agentId, appId, onGranted]);

  const handleGrant = useCallback(async () => {
    if (!selectedId) return;
    setError("");
    setBusy(true);
    try {
      if (makeDefault && loaded?.canSetServerDefault && !selectedIsDefault) {
        // D5: show what changes for every Agent before anything is written. With no default before
        // and no Agent following one, nothing changes for anyone else: the confirmation is skipped.
        const { data } = await api.get<McpDefaultImpact>(`/mcp/apps/${appId}/default/impact`, { params: { connectionId: selectedId } });
        if (data.currentDefaultConnectionId === null && data.agentsChangingNow === 0) {
          await api.put(`/mcp/apps/${appId}/default`, { connectionId: selectedId });
          await writeGrant(null);
          return;
        }
        setImpact({ connection: { connectionId: selectedId, name: ready?.name ?? selected?.name ?? null }, impact: data });
        return;
      }
      await writeGrant(mcpGrantConnectionId(candidates, selectedId));
    } catch (err) {
      setError(mcpAppErrorMessage(err, formatMessage));
    } finally {
      setBusy(false);
    }
  }, [appId, candidates, formatMessage, loaded?.canSetServerDefault, makeDefault, ready?.name, selected?.name, selectedId, selectedIsDefault, writeGrant]);

  const handleConfirmDefault = useCallback(async () => {
    if (!impact) return;
    try {
      await api.put(`/mcp/apps/${appId}/default`, { connectionId: impact.connection.connectionId });
      await writeGrant(null);
    } catch (err) {
      throw new Error(mcpAppErrorMessage(err, formatMessage));
    }
  }, [appId, formatMessage, impact, writeGrant]);
  const handleCloseImpact = useCallback(() => setImpact(null), []);

  const handleDiscard = useCallback(async () => {
    if (!ready) return;
    setError("");
    setBusy(true);
    try {
      await api.delete(`/mcp/apps/${appId}/connections/${ready.connectionId}`);
      setSignedIn(null);
      setPicked(null);
      await load();
    } catch (err) {
      setError(mcpAppErrorMessage(err, formatMessage));
    } finally {
      setBusy(false);
    }
  }, [appId, formatMessage, load, ready]);

  const handlePick = useCallback((value: string) => { setPicked(value); setError(""); }, []);
  const handleMakeDefault = useCallback((checked: boolean) => setMakeDefault(checked), []);
  const handleGrantClick = useCallback(() => { void handleGrant(); }, [handleGrant]);
  const handleDiscardClick = useCallback(() => { void handleDiscard(); }, [handleDiscard]);

  if (view === "failed") {
    return <Banner intent="warning" density="sm" className="mt-2">{formatMessage({ id: "agent.mcpApps.drawer.loadFailed" })}</Banner>;
  }
  if (loaded === null) {
    return <div className="mt-2 text-caption text-foreground-muted">{formatMessage({ id: "common.loading" })}</div>;
  }
  if (loaded.viewerRole === "observer") {
    return (
      <Banner intent="info" density="sm" className="mt-2" data-testid="mcp-card-locked">
        {formatMessage({ id: "actionCard.mcp.locked" })}
      </Banner>
    );
  }

  const authKind = loaded.app?.authKind ?? "oauth";
  const newBlockedReason = !loaded.canAuthorizeNew
    ? formatMessage({ id: "agent.mcpApps.drawer.newNotAllowed" })
    : authKind === "headers"
      ? formatMessage({ id: "agent.mcpApps.drawer.newHeadersElsewhere" })
      : null;
  const signingIn = waiting || starting;
  const grantLabel = formatMessage({ id: busy ? "actionCard.mcp.granting" : "actionCard.mcp.grant" }, { agent: agentName });

  return (
    <div className="mt-2 stack-y-2" data-testid="mcp-connect-card">
      {error ? <Banner intent="warning" density="sm" className="font-bold" data-testid="mcp-card-error">{error}</Banner> : null}

      {ready ? (
        <div className="stack-y-1" data-testid="mcp-card-ready">
          <div className="text-subhead font-bold text-foreground">{formatMessage({ id: "actionCard.mcp.readyTitle" })}</div>
          <div className="text-caption text-foreground-muted">
            {formatMessage({ id: "actionCard.mcp.readyBody" }, { name: selectedName, agent: agentName })}
          </div>
        </div>
      ) : candidates.length === 0 ? (
        <div className="text-caption text-foreground-muted" data-testid="mcp-card-empty">
          {formatMessage({ id: "actionCard.mcp.empty" }, { app: appName })}
        </div>
      ) : (
        <McpConnectionCandidates
          candidates={candidates}
          value={selectedId}
          onChange={handlePick}
          disabled={signingIn || busy}
          testIdPrefix="mcp-card"
        />
      )}

      {/* Only a server manager may move the default for every Agent; an Agent manager never sees this
          (D1b). When the chosen connection already is the default there is nothing to tick: one line says so. */}
      {loaded.canSetServerDefault && selectedId ? (
        selectedIsDefault ? (
          <div className="text-caption text-foreground-muted" data-testid="mcp-card-is-default">
            {formatMessage({ id: "settings.mcpApp.connections.currentDefault" }, { name: selectedName })}
          </div>
        ) : (
          <label className="flex items-start gap-2 text-caption">
            <Checkbox
              checked={makeDefault}
              disabled={busy || signedInMustBeDefault}
              onCheckedChange={handleMakeDefault}
              aria-label={formatMessage({ id: "settings.mcpApp.connections.makeDefaultLabel" })}
              data-testid="mcp-card-make-default"
            />
            <span>
              <span className="block font-bold text-foreground">{formatMessage({ id: "settings.mcpApp.connections.makeDefaultLabel" })}</span>
              <span className="mt-1 block text-caption text-foreground-muted" data-testid="mcp-card-make-default-hint">
                {formatMessage({ id: signedInMustBeDefault ? "agent.mcpApps.drawer.newMustBeDefault" : "settings.mcpApp.connections.makeDefaultHint" })}
              </span>
            </span>
          </label>
        )
      ) : null}

      {waiting ? (
        <Banner
          intent="info"
          density="sm"
          data-testid="mcp-card-oauth-waiting"
          actions={(
            <>
              {blockedUrl ? (
                <Button type="button" size="md" variant="outline" onClick={openSignInPage}>
                  {formatMessage({ id: "settings.mcpApp.connections.openSignInPage" })}
                </Button>
              ) : null}
              <Button type="button" size="md" variant="outline" onClick={cancel}>
                {formatMessage({ id: "settings.mcpApp.connections.cancelSignIn" })}
              </Button>
            </>
          )}
        >
          {formatMessage({ id: blockedUrl ? "settings.mcpApp.connections.popupBlocked" : "agent.mcpApps.drawer.waiting" })}
        </Banner>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {ready ? (
          loaded.canAuthorizeNew ? (
            <Button type="button" size="md" variant="outline" onClick={handleDiscardClick} disabled={busy} data-testid="mcp-card-discard">
              {formatMessage({ id: "actionCard.mcp.discard" })}
            </Button>
          ) : null
        ) : newBlockedReason !== null ? null : (
          <Button type="button" size="md" variant="outline" onClick={handleAuthorizeNew} disabled={signingIn || busy} data-testid="mcp-card-authorize-new">
            {formatMessage({ id: "actionCard.mcp.authorizeNew" })}
          </Button>
        )}
        {ready || candidates.length > 0 ? (
          <Button type="button" size="md" variant="outline" onClick={handleGrantClick} disabled={!selectedId || busy || signingIn} data-testid="mcp-card-grant">
            {grantLabel}
          </Button>
        ) : null}
      </div>
      {!ready && newBlockedReason !== null && candidates.length === 0 ? (
        <div className="text-caption text-foreground-muted" data-testid="mcp-card-new-blocked">{newBlockedReason}</div>
      ) : null}

      {impact ? (
        <ConfirmDialog
          title={formatMessage({ id: "actionCard.mcp.impactTitle" }, { name: impact.connection.name?.trim() || unnamed })}
          message={(
            <div className="stack-y-2" data-testid="mcp-card-default-impact">
              <p>{formatMessage({ id: "settings.mcpApp.connections.makeDefaultHint" })}</p>
              <p>{formatMessage({ id: "settings.mcpApp.connections.defaultImpactFollowing" }, { count: impact.impact.agentsChangingNow, name: impact.connection.name?.trim() || unnamed })}</p>
              <p>{formatMessage({ id: "settings.mcpApp.connections.defaultImpactUnchanged" }, { pinned: impact.impact.pinnedUnchanged, off: impact.impact.offUnchanged })}</p>
            </div>
          )}
          confirmLabel={formatMessage({ id: "actionCard.mcp.impactConfirm" })}
          confirmVariant="primary"
          confirmTestId="mcp-card-default-confirm"
          onConfirm={handleConfirmDefault}
          onClose={handleCloseImpact}
          maxWidthClass="max-w-md"
        />
      ) : null}
    </div>
  );
}
