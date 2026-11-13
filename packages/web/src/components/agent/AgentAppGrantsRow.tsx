import { Button, ListRow, ListRowBody, ListRowGroup, TextLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import { ChevronDown } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";
import { AgentAppRow } from "./AgentAppRow";
import { AppGrantAbilities } from "./AppGrantAbilities";
import { appAbilities, grantSourceLabelId, grantsBySource } from "./agentAppGrants";
import type { AgentAppGrantGroup, AgentIntegrationItem } from "./agentAppGrants";

/** What a Revoke asks to take: every grant of the App (`whole`), or one grant from its details. */
export interface RevokeAppGrantsTarget {
  clientId: string;
  name: string;
  whole: boolean;
  grantIds: string[];
}

/** One grant in the App's details: what it lets the App do, and its own Revoke. */
function GrantDetailRow({ grant, appName, canRevoke, onRevoke }: {
  grant: AgentIntegrationItem;
  appName: string;
  canRevoke: boolean;
  onRevoke: (target: RevokeAppGrantsTarget) => void;
}) {
  const { formatMessage, formatList } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  // Every grant row has a Revoke: its accessible name says which grant of which App.
  const grantLabel = formatList(
    appAbilities(grant.scopes).map((ability) => (ability.long ? formatMessage({ id: ability.long }) : ability.scopes[0])),
    { type: "conjunction" },
  );
  const handleRevoke = useCallback(
    () => onRevoke({ clientId: grant.clientId, name: appName, whole: false, grantIds: [grant.id] }),
    [grant.clientId, grant.id, appName, onRevoke],
  );
  return (
    <ListRow variant="plain" interactive={false} className="items-start" data-testid={`agent-app-grant-${grant.id}`}>
      <ListRowBody className="stack-y-1">
        <AppGrantAbilities scopes={grant.scopes} />
        <div className="font-mono text-mono-meta text-foreground-hint">{formatShortDateTime(grant.createdAt)}</div>
      </ListRowBody>
      {canRevoke ? (
        <Button
          variant="outline"
          size="md"
          onClick={handleRevoke}
          aria-label={formatMessage({ id: "agent.apps.revokeGrantFor" }, { grant: grantLabel, app: appName })}
          data-testid={`agent-app-revoke-grant-${grant.id}`}
        >
          {formatMessage({ id: "agent.detail.revoke" })}
        </Button>
      ) : null}
    </ListRow>
  );
}

/**
 * One ordinary App on the Agent's Apps tab, however many grants it holds (an App can hold several,
 * e.g. one from the agent's sign-in and one for notifications). The row says in one plain line
 * what the App can do across them ("Can sign in and send notifications"), not raw scopes.
 *
 * Revoke access takes every grant of the App, after a confirmation that lists each one. With more
 * than one grant, Details opens them under the row, grouped by how access was granted, each with
 * its own Revoke. The Apps tab has no pushed pages on a phone, so details are an inline disclosure
 * like the tab's app events. Actions only for someone who may manage this Agent's access.
 */
export function AgentAppGrantsRow({ app, canManageAgentAccess, onRevoke }: {
  app: AgentAppGrantGroup;
  canManageAgentAccess: boolean;
  onRevoke: (target: RevokeAppGrantsTarget) => void;
}) {
  const { formatMessage, formatList } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const multiple = app.grants.length > 1;

  const summary = useMemo(() => {
    const abilities = appAbilities(app.grants.flatMap((grant) => grant.scopes))
      .map((ability) => (ability.short ? formatMessage({ id: ability.short }) : ability.scopes[0]));
    return abilities.length > 0
      ? formatMessage({ id: "agent.apps.canSummary" }, { abilities: formatList(abilities, { type: "conjunction" }) })
      : null;
  }, [app.grants, formatMessage, formatList]);

  // Every grant from one source: the row says how, as before. Several sources: Details says it per grant.
  const sources = new Set(app.grants.map((grant) => grant.grantSource));
  const [onlySource] = sources;
  const source = sources.size === 1 && onlySource ? formatMessage({ id: grantSourceLabelId(onlySource) }) : null;

  const toggle = useCallback(() => setOpen((value) => !value), []);
  const revokeAll = useCallback(
    () => onRevoke({ clientId: app.clientId, name: app.name, whole: true, grantIds: app.grants.map((grant) => grant.id) }),
    [app, onRevoke],
  );

  return (
    <AgentAppRow
      testId={`agent-app-row-${app.clientId}`}
      name={app.name}
      logoUrl={app.logoUrl}
      logoSeed={app.clientId}
      meta={formatShortDateTime(app.since)}
      source={source}
      statusLabel={formatMessage({ id: "agent.detail.active" })}
      statusVariant="success"
      description={app.description}
      actions={canManageAgentAccess || multiple || app.homepageUrl ? (
        <>
          {canManageAgentAccess ? (
            <Button
              variant="outline"
              size="md"
              onClick={revokeAll}
              aria-label={formatMessage({ id: "agent.apps.revokeAccessFor" }, { app: app.name })}
              data-testid={`agent-app-revoke-${app.clientId}`}
            >
              {formatMessage({ id: "agent.apps.revokeAccess" })}
            </Button>
          ) : null}
          {multiple ? (
            <Button
              variant="ghost"
              size="md"
              onClick={toggle}
              aria-expanded={open}
              aria-controls={open ? detailsId : undefined}
              aria-label={formatMessage({ id: "agent.apps.grantDetailsFor" }, { app: app.name })}
              data-testid={`agent-app-details-${app.clientId}`}
            >
              {formatMessage({ id: "agent.apps.grantDetails" })}
              <ChevronDown aria-hidden className={open ? "rotate-180" : undefined} />
            </Button>
          ) : null}
          {app.homepageUrl ? (
            <TextLink render={<a href={app.homepageUrl} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, formatMessage({ id: "agent.detail.viewService" }))} />} className="text-footnote">
              {formatMessage({ id: "agent.detail.viewService" })}
              <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
            </TextLink>
          ) : null}
        </>
      ) : null}
    >
      {summary ? <div className="text-callout text-foreground" data-testid="agent-app-abilities">{summary}</div> : null}
      {app.agentManifestUrl ? (
        <div className="break-all font-mono text-mono-meta text-foreground-hint">
          {formatMessage({ id: "agent.detail.agentManifest" }, { url: app.agentManifestUrl })}
        </div>
      ) : null}
      {multiple && open ? (
        <div id={detailsId} className="stack-y-3" data-testid={`agent-app-grant-details-${app.clientId}`}>
          {grantsBySource(app.grants).map(({ source: grantSource, grants }) => {
            const label = formatMessage({ id: grantSourceLabelId(grantSource) });
            return (
              <section key={grantSource ?? "unknown"} aria-label={label} className="stack-y-1">
                <div className="text-footnote font-semibold text-foreground-muted">{label}</div>
                <ListRowGroup>
                  {grants.map((grant) => (
                    <GrantDetailRow key={grant.id} grant={grant} appName={app.name} canRevoke={canManageAgentAccess} onRevoke={onRevoke} />
                  ))}
                </ListRowGroup>
              </section>
            );
          })}
        </div>
      ) : null}
    </AgentAppRow>
  );
}
