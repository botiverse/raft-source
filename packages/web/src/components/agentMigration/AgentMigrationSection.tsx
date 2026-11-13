import { useCallback, useEffect, useRef, useState } from "react";
import { currentTimeMs } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import { Badge, Button, Separator, TextLink } from "@botiverse/raft-ui";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import Banner from "../ui/Banner";
import SectionEyebrow from "../ui/SectionEyebrow";
import { openUpgradeDialog } from "../../store/upgradeDialogStore";
import { usePaywallShown } from "../../analytics/paywall";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { agentMigrationRequiresUpgrade } from "./billing";
import { endedComputerMigration, migrationStatusErrorPresentation } from "./presentation";
import {
  canCancelMigration,
  isActiveMigrationState,
  isCanceledMigrationState,
  isCompletedMigrationState,
  isFailedMigrationState,
  isHostedMigration,
} from "./state";
import type { AgentMigrationNotice } from "./realtime";
import { useAgentMigrationStatus } from "./useAgentMigrationStatus";
import { useHostedMigrationAvailable } from "./useHostedMigrationAvailable";
import { AgentMigrationCancelDialog } from "./AgentMigrationCancelDialog";
import { AgentMigrationDialog } from "./AgentMigrationDialog";
import type { MigrationStartResponse } from "./AgentMigrationDialog";
import { MigrationErrorContent } from "./MigrationErrorContent";
import { LastMigration } from "./LastMigration";
import { MigrationProgressPanel } from "./MigrationProgressPanel";

/** How long a finished move to the cloud stays on the cloud agent's profile. */
const HOSTED_ARRIVAL_VISIBLE_MS = 24 * 60 * 60_000;

/**
 * A cloud agent shows this section only for the move that brought it there:
 * while it is switching, and for a day after it ends.
 */
function showsHostedArrival(notice: AgentMigrationNotice | null): boolean {
  if (!notice || !isHostedMigration(notice) || !notice.flippedAt) return false;
  if (isActiveMigrationState(notice.state)) return true;
  // Completion is dated by completedAt; other endings by when the row last changed.
  const endedAt = Date.parse((isCompletedMigrationState(notice.state) ? notice.completedAt : notice.updatedAt) ?? "");
  return Number.isFinite(endedAt) && currentTimeMs() - endedAt < HOSTED_ARRIVAL_VISIBLE_MS;
}

/**
 * Move-to-another-computer (or to the cloud) action, live progress, and its
 * dialogs. The caller mounts this where the viewer can manage a non-external
 * agent, and on a cloud agent with `arrivalOnly` so the end of its move to the
 * cloud stays visible after the switch makes it external.
 */
export function AgentMigrationSection({ agent, arrivalOnly = false }: { agent: Agent; arrivalOnly?: boolean }) {
  const { formatMessage } = useIntl();
  const machines = useMachineStore((s) => s.machines);
  const billing = useServerStore((s) => s.billing);
  const serverRole = useServerStore((s) => s.current?.role);
  const appNav = useAppNavigate();
  const openMigrationLog = useCallback(() => appNav.toMigrationLog({ agent: agent.id }), [appNav, agent.id]);
  const loadingBilling = useServerStore((s) => s.loadingBilling);
  const loadBilling = useServerStore((s) => s.loadBilling);
  const canSeeMigrationLog = serverRole === "owner" || serverRole === "admin";
  // An agent on no Computer (forced off one, or never placed), or on one whose
  // access was revoked (reconciler step 15: it never connects again), is placed
  // on the target by the same Move: nothing to bring over, not a Pro migration.
  const sourceAccessRevoked = agent.blockedReason === "computer_access_revoked";
  const placesWithoutSource = !arrivalOnly && agent.executionMode === "byoc" && (!agent.machineId || sourceAccessRevoked);
  const enabled = arrivalOnly || Boolean(agent.machineId) || placesWithoutSource;
  const hostedAvailable = useHostedMigrationAvailable(enabled && !arrivalOnly && !placesWithoutSource);
  const [showDialog, setShowDialog] = useState(false);
  // Try Again reopens the dialog on the computer that failed; another migration starts fresh.
  const [retryTarget, setRetryTarget] = useState<string | null>(null);
  const [showCancel, setShowCancel] = useState(false);

  const presentStatusError = useCallback(
    (error: { code?: string; message?: string }) => migrationStatusErrorPresentation(error, formatMessage),
    [formatMessage],
  );
  const { model, error: statusError, refresh } = useAgentMigrationStatus({
    agentId: agent.id,
    enabled,
    presentError: presentStatusError,
  });
  const notice = model.migration?.agentId === agent.id ? model.migration : null;
  const agentName = agent.displayName || agent.name;
  const active = notice ? isActiveMigrationState(notice.state) : false;
  const canRetry = notice ? isFailedMigrationState(notice.state) : false;
  const ended = notice ? endedComputerMigration(notice) : null;
  // Try Again on the same computer only makes sense if the agent never left the
  // source; after the switch it is already there. A move to the cloud keeps one button.
  const retryOnTarget = ended === "failed" && !notice?.flippedAt;
  const requiresUpgrade = !placesWithoutSource && agentMigrationRequiresUpgrade(billing?.plan);
  // On Free, a server with two or more computers (offline ones count) could
  // move agents today: the section says so in a banner with the upgrade, in
  // place of the Pro tag, the description and Move. With one computer the
  // section stays as it is. So does a section that already shows a problem or
  // a move under way (one banner in one place): its Pro tag and Move remain,
  // and Move opens the same upgrade.
  const upgradeBanner = requiresUpgrade && machines.length >= 2 && !arrivalOnly
    && !statusError && (!notice || ended === "completed" || ended === "canceled");
  // On Free the section shows migration as a Pro feature: the paywall is on
  // screen, when the section renders at all (enabled, not the arrival-only view).
  usePaywallShown(enabled && !arrivalOnly && requiresUpgrade && "agent_migration");
  const billingChecking = billing == null && loadingBilling;

  useEffect(() => {
    if (!enabled || arrivalOnly) return;
    void loadBilling();
  }, [enabled, arrivalOnly, loadBilling]);

  // A completed migration moves the agent to another computer, but no agent
  // update is broadcast for it. When this view watched the migration finish,
  // re-read agents once so the Computer row and sidebar grouping follow it.
  const loadAgents = useAgentStore((s) => s.loadAgents);
  // The switch to the cloud is the same: the agent turns into a cloud agent at
  // the switch (before completion), so re-read once when that is seen.
  const watchedActiveRef = useRef<string | null>(null);
  const watchedHostedSwitchRef = useRef<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    if (
      isHostedMigration(notice) && notice.flippedAt && !arrivalOnly
      && watchedActiveRef.current === notice.migrationRef
      && watchedHostedSwitchRef.current !== notice.migrationRef
    ) {
      watchedHostedSwitchRef.current = notice.migrationRef;
      void loadAgents();
    }
    if (isActiveMigrationState(notice.state)) {
      watchedActiveRef.current = notice.migrationRef;
    } else if (isCompletedMigrationState(notice.state) && watchedActiveRef.current === notice.migrationRef) {
      watchedActiveRef.current = null;
      void loadAgents();
    }
  }, [notice, arrivalOnly, loadAgents]);

  const openMigrationTo = useCallback((target: string | null) => {
    if (requiresUpgrade) {
      openUpgradeDialog("agent_migration");
      return;
    }
    setRetryTarget(target);
    setShowDialog(true);
  }, [requiresUpgrade]);
  const openMigration = useCallback(() => openMigrationTo(null), [openMigrationTo]);
  const retryMigration = useCallback(
    () => openMigrationTo(notice?.targetMachineId ?? null),
    [openMigrationTo, notice?.targetMachineId],
  );
  const showCancelDialog = useCallback(() => setShowCancel(true), []);
  const closeCancelDialog = useCallback(() => setShowCancel(false), []);
  const closeMigrationDialog = useCallback(() => setShowDialog(false), []);
  // The server says Pro is required even if the plan we hold is stale: offer the upgrade.
  // Nobody clicked Upgrade, so it is no `upgrade` action; the section records
  // `paywall_shown` once the reloaded plan says Free.
  const handleProRequired = useCallback(() => {
    setShowDialog(false);
    openUpgradeDialog("agent_migration", { unprompted: true });
    void loadBilling();
  }, [loadBilling]);
  const handleMigrationStarted = useCallback(async (result: MigrationStartResponse) => {
    setShowDialog(false);
    // Placed at once: no migration to follow; re-read agents so the Computer row follows it.
    if (result.outcome === "placed_without_source") void loadAgents();
    await refresh();
  }, [refresh, loadAgents]);

  if (!enabled) return null;
  if (arrivalOnly && !showsHostedArrival(notice)) return null;

  return (
    <>
    <Separator />
    <section
      aria-labelledby="agent-migration-section-title"
      className="px-(--surface-inset) py-4"
      data-testid="agent-migration-section"
    >
      <div className="flex items-center gap-2">
        <h3 id="agent-migration-section-title">
          <SectionEyebrow>{formatMessage({ id: "agent.migration.sectionTitle" })}</SectionEyebrow>
        </h3>
        {/* Migration is a Pro feature; on other plans Migrate opens the upgrade prompt.
            A neutral tag (DS `.rf-tag`): pink stays for the one action and unread counts.
            The upgrade banner says it in words instead. */}
        {upgradeBanner || placesWithoutSource ? null : (
          <Badge appearance="outline" data-testid="agent-migration-pro-badge">
            {formatMessage({ id: "billing.pro" })}
          </Badge>
        )}
      </div>
      {/* What migration does, unless a running (or unsettled) migration's block,
          or the upgrade banner, is shown instead. */}
      {arrivalOnly || upgradeBanner || (notice && !ended && !isCompletedMigrationState(notice.state) && !isCanceledMigrationState(notice.state)) ? null : (
        <p className="mt-1 text-caption text-foreground-hint">
          {formatMessage({ id: "agent.migration.sectionDescription" })}
        </p>
      )}
      {/* An ended move between computers (other than a cancel) folds into one line here. */}
      {notice && (ended === "completed" || ended === "failed") && !arrivalOnly ? (
        <LastMigration
          key={notice.migrationRef}
          notice={notice}
          agentName={agentName}
          machines={machines}
          onShowCancel={showCancelDialog}
          onRefresh={refresh}
        />
      ) : null}
      {/* Running moves, moves to the cloud and unsettled cancels keep the progress block. */}
      {notice && !ended ? (
        <div className="mt-3">
          <MigrationProgressPanel
            notice={notice}
            agentName={agentName}
            machines={machines}
            onShowCancel={showCancelDialog}
            onRefresh={refresh}
          />
        </div>
      ) : null}
      {statusError && !arrivalOnly ? (
        <Banner
          intent="warning"
          density="sm"
          className="mt-3"
          title={formatMessage({ id: "agent.detail.migrationStatusUnavailable" })}
        >
          <MigrationErrorContent presentation={statusError} />
        </Banner>
      ) : null}
      {/* While a migration runs, the progress block owns the only action (Cancel). */}
      {active || arrivalOnly ? null : upgradeBanner ? (
        <>
        {/* DS Banner: info is for limits; its one button is outlined, never pink. */}
        <Banner
          intent="info"
          density="sm"
          withIcon
          live={false}
          className="mt-3"
          title={formatMessage({ id: "agent.migration.upgradeBanner.title" })}
          actions={
            <Button variant="outline" size="md" type="button" onClick={openMigration} data-testid="agent-migration-upgrade">
              {formatMessage({ id: "billing.upgradeToPro" })}
            </Button>
          }
          data-testid="agent-migration-upgrade-banner"
        >
          {formatMessage({ id: "agent.migration.upgradeBanner.description" }, { count: machines.length })}
        </Banner>
        {/* The log keeps past moves readable on Free (owners and admins). */}
        {canSeeMigrationLog ? (
          <div className="mt-3">
            <TextLink className="text-caption" onClick={openMigrationLog} data-testid="agent-migration-log-link">
              {formatMessage({ id: "agent.migrationLog.viewLog" })}
            </TextLink>
          </div>
        ) : null}
        </>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {/* The server's migration log, opened on this agent (owners and admins). */}
          {canSeeMigrationLog ? (
            <TextLink className="mr-auto text-caption" onClick={openMigrationLog} data-testid="agent-migration-log-link">
              {formatMessage({ id: "agent.migrationLog.viewLog" })}
            </TextLink>
          ) : null}
          {retryOnTarget ? (
            <Button variant="outline" size="md"
              type="button"
              onClick={retryMigration}
              disabled={billingChecking}
              aria-busy={billingChecking}
            >
              {formatMessage({ id: "agent.detail.tryMigrationAgain" })}
            </Button>
          ) : null}
          <Button variant="outline" size="md"
            type="button"
            onClick={openMigration}
            disabled={billingChecking}
            aria-busy={billingChecking}
          >
            {formatMessage({
              id: retryOnTarget
                ? "agent.migration.migrateElsewhere"
                // A failed move to the cloud keeps its single Try Again; a computer move
                // that failed after the switch starts over from where the agent now is.
                : canRetry && ended !== "failed"
                  ? "agent.detail.tryMigrationAgain"
                  : hostedAvailable ? "agent.migration.hosted.startEntry" : "agent.detail.startMigration",
            })}
          </Button>
        </div>
      )}

      {showDialog && (
        <AgentMigrationDialog
          agent={agent}
          machines={machines}
          sourceMachineId={agent.machineId ?? null}
          placesWithoutSource={placesWithoutSource}
          hostedAvailable={hostedAvailable}
          initialTarget={retryTarget}
          onClose={closeMigrationDialog}
          onProRequired={handleProRequired}
          onStarted={handleMigrationStarted}
        />
      )}

      {showCancel && notice && canCancelMigration(notice) && (
        <AgentMigrationCancelDialog
          agentId={agent.id}
          notice={notice}
          machines={machines}
          onClose={closeCancelDialog}
          onRefresh={refresh}
        />
      )}
    </section>
    </>
  );
}
