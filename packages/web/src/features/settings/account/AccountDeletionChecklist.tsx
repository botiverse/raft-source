/**
 * The Delete Account page's body (v7, #triage:d10ace06), from GET
 * /me/account/deletion (fields from Archer's #12416, #12468; all optional):
 * one list, a row per thing of the person's, "now → after the deletion":
 *
 * - Needs action, what holds up the deletion: each server the person is the
 *   only owner of, with other members (`soleOwnerServers`, or the 409's list
 *   from an older server), gets another Owner here (SoleOwnerTransferRow; a
 *   handled row stays, marked Done); then other members' agents on the
 *   person's computers (OthersAgentsOnComputers, from `computers`, or the
 *   409 `others_agents_on_computers` until the next read): only their owners
 *   can move them, the person can only have Raft notify them. A row goes once
 *   its agent has left.
 * - The rest happens by itself: the servers that close with the account
 *   (`soleMemberServers`); the person's agents, by computer of theirs, then by
 *   server (`agents`, `computers`; AccountDeletionAgentRow, with the optional
 *   Move and Archive); paid servers whose billing stops at the end of the
 *   period (`paidServersEndingAtPeriodEnd`).
 *
 * While other people's agents are on the person's computers, Force Unbind
 * and Request Deletion is the other way on: it confirms the list
 * (ForceUnbindAgentsDialog) and sends the request with `forceAgentIds`.
 *
 * Then "Learn more" (messages, signing out, keys, the profile), the red
 * button (off, with the reason under it, until every server is handed over
 * and every other member's agent has left the person's computers)
 * and how to cancel. With the server's `graceDays` the intro, the button and
 * the cancel line say when ("Delete Account · Effective November 9"); an
 * older server's GET has none, and they name no date. A long list scrolls with the page.
 */
import { Button, Card, Separator } from "@botiverse/raft-ui";
import { Bot, Building2, ChevronRight, CreditCard, Trash2, Undo2, Unlink } from "lucide-react";
import { currentDate } from "@botiverse/raft-shared";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";

import AttentionDot from "../../../components/ui/AttentionDot";
import type { AccountDeletionChecklist as Checklist, OthersAgentOnComputer, SoleOwnerServer } from "./accountDeletionApi";
import { accountDeletionAgentGroups, othersAgentOrder, othersAgentsOnComputers } from "./accountDeletionAgentGroups";
import { AccountDeletionAgentRow } from "./AccountDeletionAgentRow";
import { AccountDeletionChecklistRow, AccountDeletionRowNote } from "./AccountDeletionChecklistRow";
import { ForceUnbindAgentsDialog } from "../../computer/ForceUnbindAgentsDialog";
import { useDeletionDate } from "./deleteAccountFlow";
import { OthersAgentsOnComputers } from "./OthersAgentsOnComputers";
import { SoleOwnerTransferRow } from "./SoleOwnerTransferRow";

/** The list's group labels: headings, so a screen reader can jump between the two groups. */
function GroupLabel({ todo = false, children }: { todo?: boolean; children: ReactNode }) {
  return (
    <h2 className={`m-0 flex items-center gap-2 px-4 pb-0.5 pt-3 text-footnote font-semibold ${todo ? "text-attention-strong" : "text-foreground-hint"}`}>
      {todo ? <AttentionDot aria-hidden /> : null}
      {children}
    </h2>
  );
}

export function AccountDeletionChecklist({
  checklist, loaded, refusedSoleOwners, refusedOthersAgents, autoMoveAgentId, onAutoMoveHandled, onReload, onDelete, onForceUnbind, busy, notice,
}: {
  /** What GET answered; null before it does, or when it failed (the list is then the general lines). */
  checklist: Checklist | null;
  /** GET has settled, either way: until then Delete Account waits. */
  loaded: boolean;
  /** The 409's servers, when the request was refused (an older server sends no `soleOwnerServers`). */
  refusedSoleOwners: SoleOwnerServer[];
  /** The 409's other members' agents on the person's computers; null once a read lands after it (GET says again). */
  refusedOthersAgents: OthersAgentOnComputer[] | null;
  /** An agent whose Move to Another Computer opens on arrival (`?move=`). */
  autoMoveAgentId: string | null;
  onAutoMoveHandled: () => void;
  onReload: () => void;
  onDelete: () => void;
  /** Force Unbind and Request Deletion, confirmed for exactly these agents. */
  onForceUnbind: (agentIds: readonly string[]) => void;
  busy: boolean;
  /** A failed request's banner, under the button. */
  notice: ReactNode;
}) {
  const { formatMessage, formatList, formatDate } = useIntl();
  // Servers handed over here, kept as done rows after GET stops listing them.
  const [transferred, setTransferred] = useState<ReadonlyMap<string, { server: SoleOwnerServer; newOwnerName: string }>>(new Map());

  const listed = useMemo(() => {
    const fromGet = checklist?.soleOwnerServers ?? [];
    const ids = new Set(fromGet.map((server) => server.id));
    return [...fromGet, ...refusedSoleOwners.filter((server) => !ids.has(server.id))];
  }, [checklist?.soleOwnerServers, refusedSoleOwners]);
  const mustResolve = useMemo(() => {
    const ids = new Set(listed.map((server) => server.id));
    // A fixed order, so a done row stays where it was once GET stops listing it.
    return [...listed, ...[...transferred.values()].map((entry) => entry.server).filter((server) => !ids.has(server.id))]
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }, [listed, transferred]);
  const blocking = listed.filter((server) => !transferred.has(server.id));
  const othersAgents = useMemo(
    () => (refusedOthersAgents ? [...refusedOthersAgents].sort(othersAgentOrder) : othersAgentsOnComputers(checklist)),
    [checklist, refusedOthersAgents],
  );
  const needsAction = blocking.length + othersAgents.length;
  // The force list is frozen when the dialog opens: the request sends exactly what it showed.
  const [forcing, setForcing] = useState<OthersAgentOnComputer[] | null>(null);
  const openForce = useCallback(() => setForcing(othersAgents), [othersAgents]);
  const closeForce = useCallback(() => setForcing(null), []);
  const confirmForce = useCallback(() => {
    if (forcing) onForceUnbind(forcing.map((agent) => agent.id));
  }, [forcing, onForceUnbind]);
  const forceLabel = formatMessage({ id: "accountDeletion.forceUnbindAndRequest" });

  const handleTransferred = useCallback((serverId: string, newOwnerName: string) => {
    const server = listed.find((entry) => entry.id === serverId);
    if (!server) return;
    setTransferred((current) => new Map(current).set(serverId, { server, newOwnerName }));
    onReload();
  }, [listed, onReload]);

  const newOwners = useMemo(
    () => new Map([...transferred].map(([serverId, entry]) => [serverId, entry.newOwnerName])),
    [transferred],
  );
  // v7: the date a request made now takes effect, from the server's grace period (never counted here).
  const graceDays = checklist?.graceDays ?? null;
  const deletionDate = useDeletionDate();
  const effectiveDate = graceDays ? deletionDate(new Date(currentDate().getTime() + graceDays * 24 * 60 * 60_000).toISOString()) : "";
  const agentGroups = useMemo(() => accountDeletionAgentGroups(checklist, newOwners), [checklist, newOwners]);
  const soleMemberServers = checklist?.soleMemberServers ?? [];
  const paidServers = checklist?.paidServersEndingAtPeriodEnd ?? [];
  // The general agents line stands in when GET didn't list them (an older server, or a failed read).
  const automatic = soleMemberServers.length + (agentGroups ? agentGroups.length : 1) + paidServers.length;

  return (
    <div className="stack-y-5" data-testid="account-deletion-page">
      <p className="m-0 text-body text-foreground-muted" data-testid="account-deletion-lead">
        {graceDays ? formatMessage({ id: "accountDeletion.leadDays" }, { count: graceDays }) : formatMessage({ id: "accountDeletion.lead" })}
      </p>
      <Card className="overflow-hidden p-0">
        {needsAction > 0 ? (
          <GroupLabel todo>{formatMessage({ id: "accountDeletion.groupNeedsAction" }, { count: needsAction })}</GroupLabel>
        ) : null}
        {mustResolve.length > 0 ? (
          <ul className="m-0 p-0" data-testid="account-deletion-must-resolve">
            {mustResolve.map((server) => (
              <SoleOwnerTransferRow
                key={server.id}
                server={server}
                newOwnerName={transferred.get(server.id)?.newOwnerName ?? null}
                onTransferred={handleTransferred}
              />
            ))}
          </ul>
        ) : null}
        {othersAgents.length > 0 ? <OthersAgentsOnComputers agents={othersAgents} onChanged={onReload} /> : null}
        {needsAction > 0 && automatic > 0 ? <Separator className="mt-3" /> : null}
        {needsAction > 0 && automatic > 0 ? (
          <GroupLabel>{formatMessage({ id: "accountDeletion.groupAutomatic" }, { count: automatic })}</GroupLabel>
        ) : null}
        {/* Handled rows above with no group labels: the hairline between the two lists, as between rows. */}
        <ul className={`m-0 p-0 ${mustResolve.length > 0 && needsAction === 0 ? "border-t border-line-hairline" : ""}`} data-testid="account-deletion-effects">
          {soleMemberServers.map((server) => (
            <AccountDeletionChecklistRow
              key={server.id}
              icon={<Building2 />}
              testId={`account-deletion-sole-member-${server.id}`}
              name={server.name}
              detail={formatMessage({ id: "accountDeletion.serverOnlyYou" })}
              outcome={formatMessage({ id: "accountDeletion.serverCloses" })}
            />
          ))}
          {agentGroups === null ? (
            <AccountDeletionChecklistRow
              icon={<Bot />}
              testId="account-deletion-agents-general"
              name={formatMessage({ id: "accountDeletion.yourAgents" })}
              outcome={formatMessage({ id: "accountDeletion.agentsGeneral" })}
            >
              <AccountDeletionRowNote>{formatMessage({ id: "accountDeletion.agentsGeneralNote" })}</AccountDeletionRowNote>
            </AccountDeletionChecklistRow>
          ) : agentGroups.map((group) => (
            <AccountDeletionAgentRow
              key={group.key}
              group={group}
              autoMoveAgentId={autoMoveAgentId}
              onAutoMoveHandled={onAutoMoveHandled}
              onChanged={onReload}
            />
          ))}
          {paidServers.map((server) => (
            <AccountDeletionChecklistRow
              key={server.id}
              icon={<CreditCard />}
              testId={`account-deletion-paid-${server.id}`}
              name={formatMessage({ id: "accountDeletion.billingOf" }, { serverName: server.name })}
              detail={formatMessage({ id: "accountDeletion.billingPaidByYou" })}
              outcome={server.periodEnd
                ? formatMessage({ id: "accountDeletion.billingStopsOn" }, { date: formatDate(server.periodEnd, { month: "long", day: "numeric" }) })
                : formatMessage({ id: "accountDeletion.billingStopsAtPeriodEnd" })}
            />
          ))}
        </ul>
      </Card>
      <details className="group" data-testid="account-deletion-more">
        <summary className="inline-flex list-none items-center gap-1.5 rounded-control text-body font-semibold text-foreground-muted outline-none focus-visible:shadow-focus [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden className="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
          {formatMessage({ id: "accountDeletion.learnMore" })}
        </summary>
        <ul className="m-0 mt-2.5 list-disc stack-y-1.5 pl-5 text-callout text-foreground-muted marker:text-foreground-hint">
          <li>{formatMessage({ id: "accountDeletion.moreMessages" })}</li>
          <li>{formatMessage({ id: "accountDeletion.moreSignedOut" })}</li>
          <li>{formatMessage({ id: "accountDeletion.moreKeys" })}</li>
          <li>{formatMessage({ id: "accountDeletion.moreProfile" })}</li>
        </ul>
      </details>
      <div className="stack-y-2">
        <Button
          type="button"
          size="lg"
          variant="danger"
          className="w-full"
          loading={busy}
          disabled={!loaded || needsAction > 0 || busy}
          onClick={onDelete}
          aria-describedby={needsAction > 0 ? "account-deletion-why" : undefined}
          data-testid="account-deletion-confirm"
        >
          <Trash2 size={14} />
          {effectiveDate
            ? formatMessage({ id: "accountDeletion.actionWithDate" }, { date: effectiveDate })
            : formatMessage({ id: "accountDeletion.action" })}
        </Button>
        {needsAction > 0 ? (
          <div id="account-deletion-why" className="stack-y-1" data-testid="account-deletion-why">
            {blocking.length > 0 ? (
              <p className="m-0 flex items-center gap-2 text-body text-foreground">
                <AttentionDot aria-hidden />
                {formatMessage({ id: "accountDeletion.whyBlocked" }, { servers: formatList(blocking.map((server) => server.name), { type: "conjunction" }) })}
              </p>
            ) : null}
            {othersAgents.length > 0 ? (
              <p className="m-0 flex items-center gap-2 text-body text-foreground" data-testid="account-deletion-why-others-agents">
                <AttentionDot aria-hidden />
                {formatMessage({ id: "accountDeletion.whyBlockedOthersAgents" }, { count: othersAgents.length })}
              </p>
            ) : null}
          </div>
        ) : null}
        {othersAgents.length > 0 ? (
          <Button
            type="button"
            size="lg"
            // An ink border: only the dialog's own confirm is red (DS Button: danger is a confirm dialog's button).
            variant="outline"
            className="w-full"
            // Only the server's other block left: forcing can't get past a server to hand over.
            disabled={!loaded || blocking.length > 0 || busy}
            onClick={openForce}
            data-testid="account-deletion-force-unbind"
          >
            <Unlink size={14} />
            {forceLabel}
          </Button>
        ) : null}
        <p className="m-0 flex items-center gap-1.5 text-callout text-foreground-muted">
          <Undo2 aria-hidden className="size-4 shrink-0 text-foreground-hint" />
          {graceDays
            ? formatMessage({ id: "accountDeletion.effectGraceDays" }, { count: graceDays })
            : formatMessage({ id: "accountDeletion.effectGrace" })}
        </p>
        {notice}
      </div>
      {forcing ? (
        <ForceUnbindAgentsDialog agents={forcing} confirmLabel={forceLabel} onConfirm={confirmForce} onClose={closeForce} />
      ) : null}
    </div>
  );
}
