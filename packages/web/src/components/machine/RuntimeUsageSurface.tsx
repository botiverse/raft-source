import { Badge, Banner, BannerAction, BannerDescription, Status, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, IconTile, ListRow, ListRowBody, ListRowBottom, ListRowDescription, ListRowGroup, ListRowTitle, ListRowTop, Separator, Spinner, TextLink } from "@botiverse/raft-ui";
import { Meter, MeterHeader, MeterIndicator, MeterLabel, MeterTrack, MeterValue } from "@botiverse/raft-ui/wip";
import CloseButton from "../ui/CloseButton";
import { allModelsUsageAccount, currentTimeMs, getRuntimeDisplayName, isClaudeOAuthAppsWindow, RUNTIME_ACCOUNT_USAGE_TEMPORARILY_UNAVAILABLE_CODE, runtimeAuthSignsInPerProvider, runtimeAuthStatusOnly } from "@botiverse/raft-shared";
import type { Readiness, RuntimeAccountUsageProvider, RuntimeAccountUsageWindow, RuntimeAuthRuntime, RuntimeAuthSignedInProvider, RuntimeAuthStatus, RuntimeUpdateCheck } from "@botiverse/raft-shared";
import { unsupportedReasonBadgeId, unsupportedReasonTextId } from "./runtimeUsageUnsupportedReason";
import { formatReadiness, readinessBody, readinessHeading, readinessHolds } from "../../utils/readinessCopy";
import { Ellipsis, TriangleAlert, KeyRound, ListChecks, LogIn, LogOut, Plus, RefreshCw, TimerReset, UserRound, X } from "lucide-react";
import { Fragment, useCallback } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { runtimeUsagePercentUsed } from "./bulkChangeModelPlan";
import { usageResetText } from "./rack/rackResetText";
import { modelLimitChip, usageCreditsText, usageOnCredits } from "./runtimeUsageCredits";
import { formatRelativeTime } from "../../utils/relativeTime";
import { hasProviderKey } from "./runtimeProviderKey";
import { RUNTIME_INSTALL_COMMANDS } from "./runtimeInstallCommands";
import { RuntimeCredentialsNote } from "./RuntimeCredentialsNote";
import { RackCommand } from "../../features/computer/RackCommand";
import type { RuntimeAccountUsageReadResult, RuntimeAccountUsageRefreshResult } from "../../utils/runtimeAccountUsageClient";
import { runtimeAuthComputerSignsOut, runtimeAuthComputerSupports } from "../../utils/runtimeAuthClient";
import type { RuntimeAuthView } from "../../utils/runtimeAuthClient";
import { accountText, formatRuntimePlanHeading } from "../../features/computer/accountText";
import { ICON_BAR_END_PULL } from "../ui/headEdges";
import { RuntimeVersionLine } from "./RuntimeVersionLine";
import { runtimeUsageWindowLabel } from "./runtimeUsageText";
import type { RuntimeUpgradeState } from "../../features/computer/runtimeUpgradeOutcomeCopy";

/**
 * The runtime usage card's drawing: the usage block (also the agent move
 * dialog's) and the sign-in line. Its state lives in RuntimeAccountUsageChip's
 * `useRuntimeUsageCard`.
 *
 * #oar-raft:3a3f8fc1 (xxchan): a card is read for how much is left and when
 * it comes back, so a healthy card has no action row. Each action sits beside
 * what it acts on, and only while it means something: Upgrade in the version
 * line (a text link, gone once it has an outcome), a limit reset under the
 * account once a window is nearly used up, Sign out in the account's menu,
 * Refresh beside "Updated …". Resets left and credits are always shown.
 */

export type SurfaceRefreshState = RuntimeAccountUsageRefreshResult["state"] | "idle" | "requesting" | "unconfirmed";

/** `onCredits`: the account runs on credits once a window is used up (`usageOnCredits`); a full bar that says so. */
function UsageWindowMeter({ window, onCredits }: { window: RuntimeAccountUsageWindow; onCredits: boolean }) {
  const { formatMessage, locale } = useIntl();
  // Used up by the provider's word or the ratio itself, not by rounding: a
  // window with 0.4% left reads "100% used" (rounded), as the bulk dialog
  // says, not "Used up".
  const usedUp = window.status === "limit_reached" || (window.usedRatio ?? 0) >= 1;
  const used = usedUp ? 100 : (window.usedRatio ?? 0) * 100;
  const percentUsed = runtimeUsagePercentUsed(window.usedRatio ?? 0);
  // Counted as the rack's cell counts it (rackReset: down, to the largest unit); one already passed says how long ago (usageResetText).
  const reset = window.resetsAt
    ? usageResetText(window.resetsAt, locale, currentTimeMs()) ?? formatMessage({ id: "machine.runtimeUsage.later" })
    : null;
  const valueText = usedUp
    ? reset === null
      ? formatMessage({ id: onCredits ? "machine.runtimeUsage.windowUsedUpOnCreditsResetUnavailable" : "machine.runtimeUsage.windowUsedUpResetUnavailable" })
      : formatMessage({ id: onCredits ? "machine.runtimeUsage.windowUsedUpOnCredits" : "machine.runtimeUsage.windowUsedUp" }, { reset })
    : reset === null
      ? formatMessage({ id: "machine.rack.percentUsed" }, { percent: percentUsed })
      : formatMessage({ id: "machine.runtimeUsage.windowUsed" }, { percent: percentUsed, reset });
  return (
    <Meter used={used} valueText={valueText} size="sm">
      <MeterHeader>
        <MeterLabel>{runtimeUsageWindowLabel(window, formatMessage)}</MeterLabel>
        <MeterValue />
      </MeterHeader>
      <MeterTrack>
        <MeterIndicator />
      </MeterTrack>
    </Meter>
  );
}

/** What stops this runtime here, whose problem it is, who fixes it, and the fixed portal link for a verification. */
function RuntimeReadinessNotice({ readiness, runtimeId }: { readiness: Readiness; runtimeId: string }) {
  const { formatMessage } = useIntl();
  const copy = formatReadiness(formatMessage, readiness, runtimeId);
  return (
    <div className="flex items-start gap-2 border-b border-line-hairline px-4 py-3 text-callout" data-testid="runtime-readiness-notice" data-readiness-code={readiness.primary?.code}>
      <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning-strong" aria-hidden="true" />
      <div className="min-w-0 stack-y-1">
        <div className="font-medium text-foreground">
          {readinessHeading(formatMessage, copy)}
        </div>
        <div className="text-foreground-muted">
          {readinessBody(formatMessage, copy)}
        </div>
        {copy.link ? (
          <TextLink render={<a href={copy.link.href} target="_blank" rel="noopener noreferrer" aria-label={copy.link.text} />} data-testid="runtime-readiness-link">
            {copy.link.text}
          </TextLink>
        ) : null}
      </div>
    </div>
  );
}

export function RuntimeUsageContents({
  result,
  loading,
  loadError,
  metadata,
  accountMenu,
  accountActions,
  footerAction,
}: {
  result: RuntimeAccountUsageReadResult | null;
  loading: boolean;
  loadError: boolean;
  /** Replaces the closing "Updated …" line (the move dialog's offline computer says when it last reported). */
  metadata?: string;
  /** The Computer's own (default) account's menu (Sign out), at the end of its name row. */
  accountMenu?: ReactNode;
  /** Under the Computer's own account: what can be done about its limits (a reset), when it means something. */
  accountActions?: ReactNode;
  /** Beside "Updated …" (Refresh); also drawn when there is nothing read yet. */
  footerAction?: ReactNode;
}) {
  const { formatMessage, locale } = useIntl();
  const bare = (body: ReactNode) => (
    <>
      {body}
      {footerAction ? (
        <>
          <Separator />
          <div className="flex items-center justify-end gap-2 px-4 py-1.5">{footerAction}</div>
        </>
      ) : null}
    </>
  );
  if (loading && !result) {
    return bare(<div className="px-4 py-5 text-callout text-foreground-muted">{formatMessage({ id: "machine.runtimeUsage.reading" })}</div>);
  }
  if (loadError && !result) {
    return bare(
      <div className="flex items-start gap-2 px-4 py-5 text-callout text-warning-strong">
        <TriangleAlert size={16} className="mt-0.5 shrink-0" />
        {formatMessage({ id: "machine.runtimeUsage.readFailed" })}
      </div>,
    );
  }
  if (!result || result.snapshot === null) {
    return bare(
      <div className="px-4 py-5">
        <div className="text-callout font-bold text-foreground">{formatMessage({ id: "machine.runtimeUsage.noSnapshot" })}</div>
      </div>,
    );
  }
  // The Computer's own account (not an agent's own folder's): where its menu and limit actions go.
  const ownAccountKey = result.snapshot.accounts.find((account) => account.agentIds === undefined)?.accountKey ?? null;

  const stale = result.state === "stale";
  return (
    // A stale snapshot sits on the sunken surface under an orange-soft notice
    // (ink text): recoverable, so warning, never red.
    <div className={stale ? "bg-fill-muted" : undefined}>
      {stale && (
        <div className="border-b border-line-hairline bg-warning-soft px-4 py-2 text-caption font-bold text-foreground">
          {formatMessage({ id: "machine.runtimeUsage.stale" })}
        </div>
      )}
      <div>
        {result.snapshot.accounts.map((account, index) => {
          const reauth = account.health === "reauth_required";
          const identity = account.maskedLabel ?? account.displayName;
          const resets = account.limitResetsAvailable;
          const credits = usageCreditsText(account.credits, formatMessage);
          const onCredits = usageOnCredits(account);
          // "Used up" on the all-models basis only; a model's own window at its
          // limit is "some models used up" (below), its row saying which.
          const health = allModelsUsageAccount(account).account.health;
          // Not read this time, read again later (Kimi's token awaiting refresh): no error.
          const notReadYet = account.parseErrorCode === RUNTIME_ACCOUNT_USAGE_TEMPORARILY_UNAVAILABLE_CODE;
          // A model or group used up while the account runs others, or every group used up (`modelLimitChip`).
          const modelChip = health === "ok" && !notReadYet ? modelLimitChip(account) : null;
          const badgeOk = health === "ok" && !notReadYet && modelChip === null;
          // Why an unsupported account has no reading (OAR's reason), when the Computer said.
          const unsupportedLabel = health === "unsupported" ? unsupportedReasonBadgeId(account.unsupportedReason) : null;
          const unsupportedText = health === "unsupported" ? unsupportedReasonTextId(account.unsupportedReason) : null;
          const own = account.accountKey === ownAccountKey;
          return (
            <Fragment key={account.accountKey}>
            {index > 0 ? <Separator /> : null}
            <div className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-callout font-bold text-foreground" data-testid="runtime-account-plan">
                    {formatRuntimePlanHeading(account.planLabel, formatMessage)}
                  </div>
                  {identity && (
                    <div className="mt-0.5 min-w-0 truncate font-mono text-mono-meta text-foreground-hint" data-testid="runtime-account-masked-label">
                      {identity}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {/* Raft DS StatusChip: soft wash, a square pixel, one word. Only for a problem: a healthy account needs no word. */}
                  {badgeOk ? null : (
                    <Badge appearance="soft" variant="warning" data-testid="runtime-account-health">
                      <Status size="md" variant="warning" aria-hidden="true" />
                      {formatMessage({ id: notReadYet ? "machine.runtimeUsage.health.temporarilyUnavailable" : modelChip ? `machine.runtimeUsage.health.${modelChip}` : unsupportedLabel ?? `machine.runtimeUsage.health.${health}` })}
                    </Badge>
                  )}
                  {own ? accountMenu : null}
                </div>
              </div>
              {account.health === "unsupported" ? (unsupportedText ? (
                <p className="mt-3 text-footnote text-foreground-muted" data-testid="runtime-account-unsupported-reason">
                  {formatMessage({ id: unsupportedText })}
                </p>
              ) : null) : notReadYet ? (
                <p className="mt-3 text-footnote text-foreground-muted">
                  {formatMessage({ id: "machine.runtimeUsage.temporarilyUnavailable" })}
                </p>
              ) : account.health === "error" || reauth ? (
                // Its tag says it ("error", "sign in again"; Sign in under the Computer's own account): no
                // sentence repeating it, and no last-known meters until the provider reads it again.
                null
              ) : (
                <div className="mt-3 stack-y-3">
                  {/* Claude's OAuth apps' window (third-party apps' use) is never listed. */}
                  {account.windows.filter((window) => !isClaudeOAuthAppsWindow(window)).map((window) => window.status === "parse_unavailable" ? (
                    <div key={window.id} className="flex flex-col gap-0.5 text-footnote sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                      <span className="font-semibold text-foreground">{window.label}</span>
                      <span className="text-warning-strong">{formatMessage({ id: "machine.runtimeUsage.parseUnavailable" })}</span>
                    </div>
                  ) : (
                    // Raft DS Meter (raft-ui 0.50): what is used, filling as
                    // it is used; cyan, orange from 80% used, a full orange
                    // bar when used up.
                    <UsageWindowMeter key={window.id} window={window} onCredits={onCredits} />
                  ))}
                </div>
              )}
              {/* Always in sight: the resets the account has left and its credits (Codex), one line of secondary text
                  under the meters (Kirby: two numbers, not chips that look pressable). No credits left reads orange. */}
              {(resets !== undefined || credits !== null) && (
                <p className="mt-3 truncate text-footnote text-foreground-muted tabular-nums" data-testid="runtime-account-facts">
                  {resets !== undefined && (
                    <span data-testid="runtime-account-limit-resets">
                      {resets > 0
                        ? formatMessage({ id: "machine.runtimeUsage.limitResets.left" }, { count: resets })
                        : formatMessage({ id: "machine.runtimeUsage.limitResets.none" })}
                    </span>
                  )}
                  {resets !== undefined && credits !== null ? <>{" "}<span aria-hidden="true">·</span>{" "}</> : null}
                  {credits !== null && (
                    <span className={account.credits?.available === false ? "text-warning-strong" : undefined} data-testid="runtime-account-credits">
                      {credits}
                    </span>
                  )}
                </p>
              )}
              {own && accountActions ? <div className="mt-3">{accountActions}</div> : null}
            </div>
            </Fragment>
          );
        })}
      </div>
      <Separator />
      <div className="flex items-center justify-between gap-2 px-4 py-1.5">
        <span className="min-w-0 py-0.5 text-caption text-foreground-hint">
          {metadata ?? formatMessage(
            { id: "machine.runtimeUsage.updated" },
            {
              updated: formatRelativeTime(result.snapshot.collectedAt, locale) ?? formatMessage({ id: "machine.runtimeUsage.recently" }),
            },
          )}
        </span>
        {footerAction}
      </div>
    </div>
  );
}

/**
 * task #17: what the card knows about signing this runtime in or out from the
 * web. Only for the runtimes OAR can log in (Claude Code, Codex, Kimi, Qoder),
 * or connect to a provider with an API key (Qwen Code).
 */
export interface SurfaceAuth {
  /** The runtime whose sign-in this is (OAR's `kimi` for Kimi Code). */
  runtime: RuntimeAuthRuntime;
  status: RuntimeAuthStatus | null;
  view: RuntimeAuthView;
  onSignIn: () => void;
  onSignOut: () => void;
  onConnectProvider: () => void;
  /** A per-provider runtime's (Pi's) Sign Out (an account) or Remove (a key) for one provider. */
  onSignOutProvider: (provider: RuntimeAuthSignedInProvider) => void;
  /**
   * Upgrade (runtime_upgrade_button), when the server offers it to this
   * viewer for this runtime (the Computer reports it can upgrade it): what
   * the last press learned, and the press. Absent: no Upgrade on the card.
   */
  upgrade?: { state: RuntimeUpgradeState; onUpgrade: () => void } | null;
  /**
   * With `upgrade`: the Computer's update check for this runtime
   * (`runtimeUpdateOf`). Upgrade shows only where it found a newer version;
   * null (an older Computer or server): Upgrade as before.
   */
  update?: RuntimeUpdateCheck | null;
}

/**
 * The signed-in account named under the title, only when the usage block does
 * not already name the plan and email below. One rule for the line and the chip:
 * a card shows the account line or the "Signed in" chip, never both.
 */
function headerAccountText(runtime: RuntimeAuthRuntime, status: RuntimeAuthStatus | null, usageShowsAccount: boolean): string | null {
  if (runtimeAuthSignsInPerProvider(runtime) || hasProviderKey(runtime)) return null;
  return status?.kind === "logged_in" && !usageShowsAccount ? accountText(status.account) : null;
}

/**
 * The runtime's sign-in state as a chip, at the end of the card's title line
 * (Kirby: where an account's "Used up" sits on its row), so the version line
 * stays the second line. A card with no usage (Qoder) and no account line says
 * it is signed in, as nothing else on it would.
 */
function RuntimeAuthHeaderBadge({ runtime, status, usageShowsAccount, authOnly }: { runtime: RuntimeAuthRuntime; status: RuntimeAuthStatus | null; usageShowsAccount: boolean; authOnly: boolean }) {
  const { formatMessage } = useIntl();
  if (runtimeAuthSignsInPerProvider(runtime)) return null;
  if (hasProviderKey(runtime)) {
    // Presence only: configured or not; anything else (unknown, unavailable) says nothing.
    if (status?.kind !== "logged_in" && status?.kind !== "logged_out") return null;
    const configured = status.kind === "logged_in";
    return (
      <Badge appearance="soft" variant={configured ? "success" : "warning"} className="shrink-0" data-testid={configured ? "runtime-provider-configured" : "runtime-provider-not-configured"}>
        <Status size="md" variant={configured ? "success" : "warning"} aria-hidden="true" />
        {formatMessage({ id: configured ? "machine.runtimeAuth.provider.configured" : "machine.runtimeAuth.provider.notConfigured" })}
      </Badge>
    );
  }
  if (status?.kind === "logged_out") {
    return (
      // A soft chip in words, no pixel: a status light is for presence and
      // task status, not for a runtime's sign-in (Raft DS Status), as the
      // runtime chip says it.
      <Badge appearance="soft" variant="warning" className="shrink-0" data-testid="runtime-auth-logged-out">
        {formatMessage({ id: "machine.runtimeAuth.notSignedIn" })}
      </Badge>
    );
  }
  if (authOnly && status?.kind === "logged_in" && !headerAccountText(runtime, status, usageShowsAccount)) {
    return (
      <Badge appearance="soft" variant="success" className="shrink-0" data-testid="runtime-auth-logged-in">
        {formatMessage({ id: "machine.runtimeAuth.signedIn" })}
      </Badge>
    );
  }
  return null;
}

/** The sign-in state in words under the title: Pi's "no providers", or the signed-in account when usage draws none. */
function RuntimeAuthHeaderLine({ runtime, status, usageShowsAccount }: { runtime: RuntimeAuthRuntime; status: RuntimeAuthStatus | null; usageShowsAccount: boolean }) {
  const { formatMessage } = useIntl();
  if (runtimeAuthSignsInPerProvider(runtime)) {
    // Its providers are listed below. None stored is no "signed out": a key in the
    // Computer's environment or Pi's models.json may still sign it in, unseen here.
    if (status?.kind !== "logged_out") return null;
    return (
      <div className="mt-1 text-callout text-foreground-muted" data-testid="runtime-auth-no-providers">
        {formatMessage({ id: "machine.runtimeAuth.pi.noProviders" })}
      </div>
    );
  }
  const account = headerAccountText(runtime, status, usageShowsAccount);
  if (!account) return null;
  return (
    <div className="mt-1 truncate text-callout font-bold text-foreground" data-testid="runtime-auth-account">
      {account}
    </div>
  );
}

/**
 * Sign-in is unavailable on the Computer (its CLI is missing, too old or an
 * installation OAR can't use): say so, and how to install it, instead of
 * leaving the card without an action (#triage:#253). A runtime with no known
 * install command gets the sentence alone.
 */
function RuntimeAuthUnavailable({ runtimeId, reason, upgrade }: { runtimeId: string; reason: Extract<RuntimeAuthStatus, { kind: "unavailable" }>["reason"]; upgrade: SurfaceAuth["upgrade"] }) {
  const { formatMessage } = useIntl();
  // Too old, where Upgrade is offered: the card's Upgrade (runtimeAuthAction) replaces the "update it there" guidance.
  if (reason === "version_unsupported" && upgrade) {
    return (
      <p className="text-caption text-foreground-hint" data-testid="runtime-auth-cli-unavailable">
        {formatMessage({ id: "machine.runtimeUpgrade.tooOld" })}
      </p>
    );
  }
  const install = reason === "unsupported_installation" ? undefined : RUNTIME_INSTALL_COMMANDS[runtimeId];
  return (
    <div className="stack-y-1 min-w-0" data-testid="runtime-auth-cli-unavailable">
      <p className="text-caption text-foreground-hint">
        {formatMessage({ id: reason === "not_installed"
          ? "machine.runtimeAuth.unavailable.notInstalled"
          : reason === "version_unsupported"
            // OpenCode 1 has no sign-in API: it is the 2.x line, not a newer 1.x, that signs in from here.
            ? runtimeId === "opencode" ? "machine.runtimeAuth.opencode.versionUnsupported" : "machine.runtimeAuth.unavailable.versionUnsupported"
            : "machine.runtimeAuth.unavailable.unsupportedInstallation" })}
      </p>
      {install && (
        <>
          <p className="text-caption text-foreground-hint">{formatMessage({ id: "machine.runtimeAuth.unavailable.installOn" })}</p>
          <RackCommand command={install} testId="runtime-auth-install-line" />
        </>
      )}
    </div>
  );
}

/** The card's one thing to do while signed out, or while the provider wants a sign-in again: a full-width call to action (Raft DS Button `xl`). */
function signInButton(auth: SurfaceAuth, runtimeId: string, formatMessage: IntlShape["formatMessage"]): ReactNode {
  return (
    <Button size="xl" variant="primary" type="button" onClick={auth.onSignIn} data-testid="runtime-auth-sign-in">
      <LogIn size={16} aria-hidden="true" />
      {formatMessage({ id: "machine.runtimeAuth.signIn.title" }, { runtime: getRuntimeDisplayName(runtimeId) })}
    </Button>
  );
}

/** Whether this viewer can sign this runtime in from the card (the Sign in a signed-out card offers). */
function canSignInHere(auth: SurfaceAuth): boolean {
  const { runtime, status, view } = auth;
  return view.canAct && view.availability === "ok" && runtimeAuthComputerSupports(view, runtime) && status?.kind !== "unavailable"
    && !runtimeAuthStatusOnly(runtime) && !runtimeAuthSignsInPerProvider(runtime) && !hasProviderKey(runtime);
}

function runtimeAuthAction(auth: SurfaceAuth, runtimeId: string, formatMessage: IntlShape["formatMessage"]): ReactNode {
  const { runtime, status, view } = auth;
  // Nothing to sign in from here (DeepSeek Harness): a missing or too-old CLI as for any runtime, else how its key is set (every viewer).
  if (runtimeAuthStatusOnly(runtime)) return status?.kind === "unavailable" && view.availability === "ok"
    ? <RuntimeAuthUnavailable runtimeId={runtimeId} reason={status.reason} upgrade={auth.upgrade} />
    : <RuntimeCredentialsNote runtime={runtime} />;
  if (!view.canAct) return null;
  // A daemon that predates this runtime's sign-in from the web (Kimi, Qoder) would drop a start.
  const needsNewerComputer = view.availability === "ok" && !runtimeAuthComputerSupports(view, runtime);
  const providerKey = hasProviderKey(runtime);
  if (view.availability === "computer_upgrade_required" || view.availability === "computer_not_attached" || needsNewerComputer) {
    return (
      <span className="text-caption text-foreground-hint" data-testid="runtime-auth-unavailable">
        {formatMessage({ id: view.availability === "computer_not_attached"
          ? providerKey ? "machine.runtimeAuth.provider.notAttached" : "machine.runtimeAuth.notAttached"
          : providerKey ? "machine.runtimeAuth.provider.upgradeRequired" : "machine.runtimeAuth.upgradeRequired" })}
      </span>
    );
  }
  if (view.availability !== "ok") return null;
  // Before the provider button too: Qwen Code with no usable CLI can't connect a provider either.
  if (status?.kind === "unavailable") return <RuntimeAuthUnavailable runtimeId={runtimeId} reason={status.reason} upgrade={auth.upgrade} />;
  if (runtimeAuthSignsInPerProvider(runtime)) {
    // Pi: one more provider at a time (an account or a key), from pi's own list.
    return (
      <Button size="md" variant={status?.kind === "logged_in" ? "outline" : "primary"} type="button" onClick={auth.onSignIn} data-testid="runtime-auth-add-provider">
        <Plus size={16} aria-hidden="true" />
        {formatMessage({ id: "machine.runtimeAuth.pi.addProvider" })}
      </Button>
    );
  }
  if (providerKey) {
    // One provider is enough; connecting another is the quieter action then.
    return (
      <Button size="md" variant={status?.kind === "logged_in" ? "outline" : "primary"} type="button" onClick={auth.onConnectProvider}>
        <KeyRound size={16} aria-hidden="true" />
        {formatMessage({ id: "machine.runtimeAuth.provider.connectAction" })}
      </Button>
    );
  }
  if (status?.kind === "logged_in") {
    // Qoder has no sign-out (OAR has none for it); a Computer from before
    // Antigravity's (OAR 0.97) signs it in but not out.
    if (!runtimeAuthComputerSignsOut(view, runtime)) return null;
    return (
      // Raft DS Button: red is for the confirm button of what cannot be
      // undone, and a log-out can be (sign in again). The confirm dialog
      // carries the warning tone; on the card it is a quiet ghost action.
      <Button size="md" variant="ghost" type="button" className="-ml-2" onClick={auth.onSignOut}>
        <LogOut size={16} aria-hidden="true" />
        {formatMessage({ id: "machine.runtimeAuth.signOutAction" })}
      </Button>
    );
  }
  if (status === null || status.kind === "logged_out" || status.kind === "unknown") return signInButton(auth, runtimeId, formatMessage);
  return null;
}

/**
 * A per-provider runtime's (Pi's) stored sign-ins, one row each: the
 * provider, how it is signed in, and its own Sign Out (an account) or Remove
 * (a key) for a person who may act here. Stored, not known to work: Pi
 * checks a sign-in when an agent runs.
 */
function PerProviderRows({ auth }: { auth: SurfaceAuth }) {
  const { runtime, status, view } = auth;
  if (!runtimeAuthSignsInPerProvider(runtime) || status?.kind !== "logged_in" || !status.providers?.length) return null;
  const canAct = view.canAct && view.availability === "ok" && runtimeAuthComputerSignsOut(view, runtime);
  return (
    <ListRowGroup className="px-2 pt-2" data-testid="runtime-auth-providers">
      {status.providers.map((provider) => (
        <PerProviderRow key={provider.id} provider={provider} onSignOut={canAct ? auth.onSignOutProvider : null} />
      ))}
    </ListRowGroup>
  );
}

function PerProviderRow({ provider, onSignOut }: { provider: RuntimeAuthSignedInProvider; onSignOut: ((provider: RuntimeAuthSignedInProvider) => void) | null }) {
  const { formatMessage } = useIntl();
  const handleSignOut = useCallback(() => onSignOut?.(provider), [onSignOut, provider]);
  const key = provider.method === "api_key";
  return (
    <ListRow variant="plain" render={<div />} data-testid={`runtime-auth-provider-${provider.id}`}>
      <IconTile size="sm">{key ? <KeyRound aria-hidden /> : <UserRound aria-hidden />}</IconTile>
      <ListRowBody>
        <ListRowTop><ListRowTitle>{provider.label}</ListRowTitle></ListRowTop>
        {/* Only what the row says nothing else of: a key, or a subscription. A plain account, or one OpenCode
            does not say is a subscription, gets no line (being listed is being signed in; Kirby). */}
        {key || provider.subscription ? (
          <ListRowBottom>
            <ListRowDescription>
              {formatMessage({ id: key ? "machine.runtimeAuth.pi.method.apiKey" : "machine.runtimeAuth.pi.method.subscription" })}
            </ListRowDescription>
          </ListRowBottom>
        ) : null}
      </ListRowBody>
      {onSignOut ? (
        <Button size="md" variant="ghost" type="button" onClick={handleSignOut} data-testid={`runtime-auth-provider-sign-out-${provider.id}`}>
          {key ? null : <LogOut size={16} aria-hidden="true" />}
          {formatMessage({ id: key ? "machine.runtimeAuth.pi.removeKey.confirm" : "machine.runtimeAuth.signOutAction" })}
        </Button>
      ) : null}
    </ListRow>
  );
}

/** The card's limit-reset action: shown only to a person who may act, while the account holds a reset. */
export interface SurfaceLimitReset {
  /** The account is rate-limited right now: the reset is the card's main action then. */
  primary: boolean;
  onUse: () => void;
  /** The account keeps running on credits past its used-up window: its agents are not waiting, the reset saves credits. */
  onCredits?: boolean;
}

/**
 * Claude limit resets on the card (claude_limit_reset_v2), for a person who may
 * act, on a Computer that can run them; null: nothing is drawn. One entry
 * (`onOpen`), as Claude Code's one `/limit-reset`: "Use a limit reset" for a
 * viewer who may use them (`canUse`), the card's main action at the 5-hour
 * limit; "View available resets" (a read-only list) for one who may not, who
 * is offered nothing at the limit (`claudeLimitResetOffer`).
 */
export interface SurfaceClaudeLimitReset {
  atFiveHourLimit: boolean;
  canUse: boolean;
  onOpen: () => void;
}

export function RuntimeUsageSurface({
  runtimeId,
  provider,
  runtimeVersion,
  result,
  loading,
  loadError,
  refreshState,
  cooldownLeftMs,
  onRefresh,
  onClose,
  auth,
  runtimeName,
  limitReset,
  claudeLimitReset = null,
  note,
  readiness = null,
}: {
  /**
   * #proj-raft-computer:#68: this runtime's readiness on the Computer
   * (Computer → runtime → machine login), trimmed for the viewer. When it
   * can't work, what is stuck leads the card; usage stays below as detail.
   */
  readiness?: Readiness | null;
  auth: SurfaceAuth | null;
  claudeLimitReset?: SurfaceClaudeLimitReset | null;
  /** Null when there is no reset to use, or the viewer may not act on this Computer's runtimes. */
  limitReset: SurfaceLimitReset | null;
  /** What the last limit reset did, said once in the action row. */
  note: string | null;
  /** The runtime's display name ("Claude Code"): the title once there is no usage to name. */
  runtimeName: string;
  runtimeId: string;
  /** Null for a runtime with no usage to read (Qoder): the card is its sign-in alone. */
  provider: RuntimeAccountUsageProvider | null;
  runtimeVersion?: string | null;
  result: RuntimeAccountUsageReadResult | null;
  loading: boolean;
  loadError: boolean;
  refreshState: SurfaceRefreshState;
  /** Task #704: ms left in the refresh window; > 0 disables the button and
   *  replaces the refused-click copy with a countdown. */
  cooldownLeftMs: number;
  onRefresh: () => void;
  /** The close button; none on a card in place (the rack's list of cards). */
  onClose?: () => void;
}) {
  const { formatMessage } = useIntl();
  // Signed out: there is no usage to show, only the way to sign in.
  const signedOut = auth?.status?.kind === "logged_out";
  // `unsupported`: this Computer reads no usage for it, as a runtime with none.
  const showsUsage = provider !== null && !signedOut && result?.state !== "unsupported";
  const usageShowsAccount = showsUsage && result !== null && result.snapshot !== null && result.snapshot.accounts.some((account) => account.agentIds === undefined);
  const version = runtimeVersion?.trim() || null;
  // Signed in with usage drawn: Sign out lives in the account's menu, not as a button on the card.
  const signOutInMenu = usageShowsAccount && auth !== null && auth.view.canAct && auth.view.availability === "ok"
    && auth.status?.kind === "logged_in" && !runtimeAuthSignsInPerProvider(auth.runtime) && !hasProviderKey(auth.runtime)
    && runtimeAuthComputerSupports(auth.view, auth.runtime) && runtimeAuthComputerSignsOut(auth.view, auth.runtime);
  const authAction = auth && !signOutInMenu ? runtimeAuthAction(auth, runtimeId, formatMessage) : null;
  // Only a state worth saying: a refresh refused or unanswered, the Computer
  // offline, or what the last limit reset did. One in flight says nothing:
  // Refresh's spinner shows it.
  const statusText = note
    ?? (refreshState === "unconfirmed"
        ? formatMessage({ id: "machine.runtimeUsage.refreshUnconfirmed" })
      : refreshState === "timeout"
        ? formatMessage({ id: "machine.runtimeUsage.refreshTimeout" })
      : cooldownLeftMs > 0
        ? formatMessage(
            { id: "machine.runtimeUsage.refreshCooldownCountdown" },
            { seconds: Math.ceil(cooldownLeftMs / 1000) },
          )
      : refreshState === "computer_offline"
        ? formatMessage({ id: "machine.runtimeUsage.computerOffline" })
        : null);
  const accountMenu = signOutInMenu && auth ? (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button size="icon-md" variant="ghost" type="button" aria-label={formatMessage({ id: "machine.runtimeUsage.accountMenu" })} data-testid="runtime-account-menu" />
        )}
      >
        <Ellipsis size={16} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" sideOffset={4}>
        <DropdownMenuItem onClick={auth.onSignOut} data-testid="runtime-auth-sign-out">
          <LogOut size={16} aria-hidden="true" />
          {formatMessage({ id: "machine.runtimeAuth.signOutAction" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;
  // Limits: a used-up account gets the reset as the card's one main action,
  // with why; nearly used up, a quiet button (the chip offers it from 80%).
  // Claude: "Use a limit reset" leads at the 5-hour limit for someone who may use it.
  const claudePrimary = claudeLimitReset?.canUse === true && claudeLimitReset.atFiveHourLimit;
  const limitPrimary = limitReset?.primary === true || claudePrimary;
  const limitButtons = (
    <>
      {limitReset ? (
        <Button size="md"
          variant={limitReset.primary ? "primary" : "outline"}
          type="button"
          onClick={limitReset.onUse}
          className="shrink-0"
          data-testid="runtime-limit-reset-action"
          data-primary-action={limitReset.primary ? "" : undefined}
        >
          <TimerReset size={16} aria-hidden="true" />
          {/* No count: the facts line above says how many are left. */}
          {formatMessage({ id: "machine.runtimeUsage.limitReset.action" })}
        </Button>
      ) : null}
      {claudeLimitReset ? (
        <Button size="md"
          variant={claudePrimary ? "primary" : "outline"}
          type="button"
          onClick={claudeLimitReset.onOpen}
          className="shrink-0"
          data-testid={claudeLimitReset.canUse ? "claude-limit-reset-action" : "claude-limit-resets-view-action"}
          data-primary-action={claudePrimary ? "" : undefined}
        >
          {claudeLimitReset.canUse ? <TimerReset size={16} aria-hidden="true" /> : <ListChecks size={16} aria-hidden="true" />}
          {formatMessage({ id: claudeLimitReset.canUse ? "machine.runtimeUsage.claudeReset.useAction" : "machine.runtimeUsage.claudeReset.viewAction" })}
        </Button>
      ) : null}
    </>
  );
  const hasLimitActions = Boolean(limitReset || claudeLimitReset);
  // The provider wants the Computer's own account signed in again: its tag says so, Sign in under it does it.
  const ownReauth = showsUsage && result?.snapshot?.accounts.some((account) => account.agentIds === undefined && account.health === "reauth_required") === true;
  const reauthSignIn = ownReauth && auth && canSignInHere(auth) ? signInButton(auth, runtimeId, formatMessage) : null;
  const limitActions = hasLimitActions ? (
    limitPrimary && limitReset?.onCredits ? (
      // Raft DS Banner: only for what the "used up" tag can't say (it is spending credits).
      // A plain used-up account gets the primary button alone: the tag already says agents wait.
      <Banner status="warning" size="sm" data-testid="runtime-limit-callout">
        <TriangleAlert aria-hidden="true" />
        <BannerDescription>
          {formatMessage({ id: "machine.runtimeUsage.limitReset.calloutOnCredits" })}
        </BannerDescription>
        <BannerAction>{limitButtons}</BannerAction>
      </Banner>
    ) : (
      <div className="flex flex-wrap items-center gap-2">{limitButtons}</div>
    )
  ) : null;
  const accountActions = reauthSignIn && limitActions
    ? <div className="flex flex-col items-stretch gap-2">{reauthSignIn}{limitActions}</div>
    : reauthSignIn ?? limitActions;
  const refreshButton = (
    <Button size="md"
      variant="ghost"
      type="button"
      onClick={onRefresh}
      disabled={refreshState === "requesting" || cooldownLeftMs > 0}
      className="-mr-2 shrink-0"
      data-testid="runtime-usage-refresh"
    >
      {/* Waiting with no known end: the pixel spinner (Raft DS Loading), also while a requested read is awaited. */}
      {refreshState === "requesting" || refreshState === "requested"
        ? <Spinner size="xs" aria-hidden="true" />
        : <RefreshCw size={16} aria-hidden="true" />}
      {formatMessage({ id: "machine.runtimeUsage.refresh" })}
    </Button>
  );
  const privateLine = <div className="px-4 pb-2.5 text-caption text-foreground-hint">{formatMessage({ id: "machine.runtimeUsage.private" })}</div>;
  return (
    <div data-testid={provider ? `runtime-usage-surface-${provider}` : `runtime-auth-surface-${runtimeId}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line-hairline px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-headline text-foreground" data-testid="runtime-usage-title">
              {showsUsage ? formatMessage({ id: "machine.runtimeUsage.title" }, { runtime: runtimeName }) : runtimeName}
            </div>
            {auth ? <RuntimeAuthHeaderBadge runtime={auth.runtime} status={auth.status} usageShowsAccount={usageShowsAccount} authOnly={provider === null || result?.state === "unsupported"} /> : null}
          </div>
          {auth ? <RuntimeAuthHeaderLine runtime={auth.runtime} status={auth.status} usageShowsAccount={usageShowsAccount} /> : null}
          <RuntimeVersionLine runtimeId={runtimeId} provider={provider} version={version} auth={auth} />
        </div>
        {onClose ? (
          <CloseButton type="button" className={ICON_BAR_END_PULL} onClick={onClose} aria-label={formatMessage({ id: "machine.runtimeUsage.close" })}>
            <X size={16} />
          </CloseButton>
        ) : null}
      </div>
      {readinessHolds(readiness) ? <RuntimeReadinessNotice readiness={readiness} runtimeId={runtimeId} /> : null}
      {showsUsage ? (
        <>
          <RuntimeUsageContents
            result={result}
            loading={loading}
            loadError={loadError}
            accountMenu={accountMenu}
            accountActions={usageShowsAccount ? accountActions : null}
            footerAction={refreshButton}
          />
          {/* No own account drawn (nothing read yet): the limit and sign-in actions under the usage. */}
          {(!usageShowsAccount && accountActions) || authAction ? (
            <div className="flex flex-col items-start gap-2 border-t border-line-hairline px-4 py-2.5" data-testid="runtime-usage-actions">
              {usageShowsAccount ? null : accountActions}
              {authAction}
            </div>
          ) : null}
          {statusText ? (
            <p className="px-4 pb-1 text-caption text-foreground-hint" role="status" data-testid="runtime-usage-status">{statusText}</p>
          ) : null}
          {privateLine}
        </>
      ) : (
        <>
          {auth ? <PerProviderRows auth={auth} /> : null}
          {authAction ? (
            <div className="flex flex-col items-stretch gap-1.5 px-4 py-2.5">
              {authAction}
            </div>
          ) : null}
          {privateLine}
        </>
      )}
    </div>
  );
}
