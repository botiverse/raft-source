import { AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { AgentContextViewGrant, AgentContextViewGrantCreated } from "@botiverse/raft-shared";
import { Button, ListRow, ListRowBody, ListRowDescription, ListRowGroup, Spinner } from "@botiverse/raft-ui";
import { ScanSearch } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import ConfirmDialog from "../../../components/ConfirmDialog";
import AvatarListRow from "../../../components/ui/AvatarListRow";
import AvatarSlot from "../../../components/ui/AvatarSlot";
import Banner from "../../../components/ui/Banner";
import SectionHeader from "../../../components/ui/SectionHeader";
import { useServerPermissions } from "../../../hooks/useServerPermissions";
import { useTimeFormatter } from "../../../hooks/useTimeFormatter";
import { isAgentInMemberLists, useAgentStore } from "../../../store/agentStore";
import { useServerFeatureFlag } from "../../../store/serverFeatureFlags";
import { useServerStore } from "../../../store/serverStore";
import { GrantContextViewDialog } from "./GrantContextViewDialog";
import { listContextViewGrants, revokeContextViewGrant } from "./contextViewGrantsApi";

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; grants: AgentContextViewGrant[] }
  | { kind: "failed" };

/**
 * Administration › Context access (#13530): the agents an owner or admin has
 * let search and read other agents' context on this server, Grant Access and
 * Revoke. Behind `agent_context_view_v0`, for owners and admins only (the
 * routes refuse anyone else). Every row shows Revoke: the server lets a
 * grant's granter or any owner or admin revoke it, and only owners and admins
 * see this list. A revoke the server no longer has a grant for (404
 * `context_view_grant_not_found`) reads as already gone: the list reloads and
 * says so.
 */
export function ContextViewGrantsSection() {
  const { isAdminOrOwner } = useServerPermissions();
  const enabled = useServerFeatureFlag(AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY).enabled;
  const serverId = useServerStore((s) => s.current?.id);
  if (!enabled || !isAdminOrOwner || !serverId) return null;
  return <ContextViewGrantsCard serverId={serverId} />;
}

function ContextViewGrantsCard({ serverId }: { serverId: string }) {
  const { formatMessage } = useIntl();
  const allAgents = useAgentStore((s) => s.agents);
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<AgentContextViewGrant | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listContextViewGrants(serverId).then(
      (grants) => { if (!cancelled) setList({ kind: "ready", grants }); },
      () => { if (!cancelled) setList({ kind: "failed" }); },
    );
    return () => { cancelled = true; };
  }, [serverId, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  const grants = list.kind === "ready" ? list.grants : null;
  const agentsById = useMemo(() => new Map(allAgents.map((agent) => [agent.id, agent])), [allAgents]);
  // The agent's display name where this server's agents list has it; the grant's own name otherwise.
  const agentLabel = useCallback(
    (grant: AgentContextViewGrant) => agentsById.get(grant.agent.id)?.displayName || grant.agent.name,
    [agentsById],
  );
  // Ordinary agents only (the server refuses the rest): not a personal
  // assistant, not an App Bot, not deleted, and not one that already has access.
  const candidates = useMemo(() => {
    const granted = new Set(grants?.map((grant) => grant.agent.id));
    return allAgents.filter((agent) => isAgentInMemberLists(agent) && !agent.managedByAppInstallId && !granted.has(agent.id));
  }, [allAgents, grants]);

  const openGrant = useCallback(() => {
    setNote(null);
    setGranting(true);
  }, []);
  const closeGrant = useCallback(() => setGranting(false), []);
  const handleGranted = useCallback((result: AgentContextViewGrantCreated) => {
    setList((current) => current.kind === "ready" && !current.grants.some((grant) => grant.id === result.grant.id)
      ? { kind: "ready", grants: [...current.grants, result.grant] }
      : current);
  }, []);
  const closeRevoke = useCallback(() => setRevoking(null), []);
  const confirmRevoke = useCallback(async () => {
    if (!revoking) return;
    const outcome = await revokeContextViewGrant(serverId, revoking.id);
    setNote(outcome === "gone" ? formatMessage({ id: "settings.contextViewGrants.alreadyRevoked" }, { agent: agentLabel(revoking) }) : null);
    if (outcome === "gone") reload();
    else setList((current) => current.kind === "ready"
      ? { kind: "ready", grants: current.grants.filter((grant) => grant.id !== revoking.id) }
      : current);
  }, [agentLabel, formatMessage, reload, revoking, serverId]);

  return (
    <div className="mb-6" id="context-view-grants" data-testid="context-view-grants-section">
      <SectionHeader
        className="mb-3"
        icon={<ScanSearch size={16} />}
        label={formatMessage({ id: "settings.contextViewGrants.sectionLabel" })}
        count={grants?.length ?? null}
      />
      {/* One ListRowGroup (DS Forms › A setting's row; cindyz, #proj-raft-ui:#220): what
          the list is, with Grant Access at its end (under the text where the row is under
          32rem wide) and the list's state under the text, then a row per grant. */}
      {/* The first row has no avatar, so the line under it starts at the row's
          edge (16px), not at the next row's text. */}
      <ListRowGroup className="@container [&>[data-slot=list-row]:nth-child(2)]:[--list-row-rule-start:16px]" data-testid="context-view-grants-rows">
        <ListRow variant="plain" interactive={false} className="@max-lg:flex-wrap">
          <ListRowBody>
            <ListRowDescription wrap>
              {formatMessage({ id: "settings.contextViewGrants.description" })}
            </ListRowDescription>
            {grants && grants.length === 0 && (
              <ListRowDescription wrap data-testid="context-view-grants-empty">
                {formatMessage({ id: "settings.contextViewGrants.empty" })}
              </ListRowDescription>
            )}
            {list.kind === "loading" && <span className="pt-2"><Spinner size="sm" aria-label={formatMessage({ id: "common.loading" })} /></span>}
            {note && <Banner intent="info" density="sm" live={false} className="mt-2">{note}</Banner>}
            {list.kind === "failed" && (
              <Banner
                intent="warning"
                density="sm"
                className="mt-2"
                actions={(
                  <Button variant="default" size="md" type="button" onClick={reload}>
                    {formatMessage({ id: "settings.contextViewGrants.retry" })}
                  </Button>
                )}
              >
                {formatMessage({ id: "settings.contextViewGrants.loadFailed" })}
              </Banner>
            )}
          </ListRowBody>
          <div className="shrink-0 @max-lg:basis-full">
            <Button variant="accent" size="md" type="button" onClick={openGrant} disabled={!grants} data-testid="context-view-grant-open">
              {formatMessage({ id: "settings.contextViewGrants.grant" })}
            </Button>
          </div>
        </ListRow>
        {grants?.map((grant) => (
          <ContextViewGrantRow
            key={grant.id}
            grant={grant}
            avatarUrl={agentsById.get(grant.agent.id)?.avatarUrl ?? null}
            displayName={agentLabel(grant)}
            onRevoke={setRevoking}
          />
        ))}
      </ListRowGroup>
      {granting && (
        <GrantContextViewDialog serverId={serverId} candidates={candidates} onGranted={handleGranted} onClose={closeGrant} />
      )}
      {revoking && (
        <ConfirmDialog
          title={formatMessage({ id: "settings.contextViewGrants.revokeTitle" }, { agent: agentLabel(revoking) })}
          message={formatMessage({ id: "settings.contextViewGrants.revokeMessage" }, { agent: agentLabel(revoking) })}
          confirmLabel={formatMessage({ id: "settings.contextViewGrants.revoke" })}
          loadingLabel={formatMessage({ id: "settings.contextViewGrants.revoking" })}
          confirmVariant="warning"
          confirmTestId="context-view-revoke-confirm"
          onConfirm={confirmRevoke}
          onClose={closeRevoke}
        />
      )}
    </div>
  );
}

function ContextViewGrantRow({
  grant,
  avatarUrl,
  displayName,
  onRevoke,
}: {
  grant: AgentContextViewGrant;
  avatarUrl: string | null;
  displayName: string;
  onRevoke: (grant: AgentContextViewGrant) => void;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const handleRevoke = useCallback(() => onRevoke(grant), [grant, onRevoke]);
  const when = formatShortDateTime(grant.grantedAt);
  return (
    <AvatarListRow
      avatar={<AvatarSlot context="list-row" type="agent" agentAvatarUrl={avatarUrl} />}
      name={displayName}
      subtitle={grant.granter
        ? formatMessage({ id: "settings.contextViewGrants.grantedBy" }, { name: grant.granter.name, when })
        : formatMessage({ id: "settings.contextViewGrants.grantedByFormer" }, { when })}
      rightContent={(
        <Button variant="outline" size="md" type="button" onClick={handleRevoke} className="shrink-0">
          {formatMessage({ id: "settings.contextViewGrants.revoke" })}
        </Button>
      )}
    />
  );
}
