import { Badge, Status, Button, IconTile, ListRow, ListRowBody, ListRowBottom, ListRowDescription, ListRowGroup, ListRowTitle, ListRowTop, Separator, Spinner, TextLink } from "@botiverse/raft-ui";
import { Meter, MeterHeader, MeterIndicator, MeterLabel, MeterTrack, MeterValue } from "@botiverse/raft-ui/wip";
import CloseButton from "../ui/CloseButton";
import { isClaudeOAuthAppsWindow, runtimeAuthSignsInPerProvider } from "@botiverse/raft-shared";
import type { Readiness, RuntimeAccountUsageProvider, RuntimeAccountUsageWindow, RuntimeAuthRuntime, RuntimeAuthSignedInProvider, RuntimeAuthStatus } from "@botiverse/raft-shared";
import { formatReadiness, readinessBody, readinessHeading, readinessHolds } from "../../utils/readinessCopy";
import { TriangleAlert, KeyRound, ListChecks, LogIn, LogOut, Plus, RefreshCw, TimerReset, UserRound, X } from "lucide-react";
import { Fragment, useCallback } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { runtimeUsagePercentUsed } from "./bulkChangeModelPlan";
import { hasProviderKey } from "./runtimeProviderKey";
import { RUNTIME_INSTALL_COMMANDS } from "./runtimeInstallCommands";
import { RackCommand } from "../../features/computer/RackCommand";
import { formatRelativeTime } from "../../utils/relativeTime";
import type { RuntimeAccountUsageReadResult, RuntimeAccountUsageRefreshResult } from "../../utils/runtimeAccountUsageClient";
import { runtimeAuthComputerSignsOut, runtimeAuthComputerSupports } from "../../utils/runtimeAuthClient";
import type { RuntimeAuthView } from "../../utils/runtimeAuthClient";
import { accountText } from "../../features/computer/accountText";
import { ICON_BAR_END_PULL } from "../ui/headEdges";

/**
 * The runtime usage card's drawing: the usage block (also the agent move
 * dialog's), the sign-in line, and the one action row. Its state lives in
 * RuntimeAccountUsageChip's `useRuntimeUsageCard`.
 */

export type SurfaceRefreshState = RuntimeAccountUsageRefreshResult["state"] | "idle" | "requesting" | "unconfirmed";

function UsageWindowMeter({ window }: { window: RuntimeAccountUsageWindow }) {
  const { formatMessage, locale } = useIntl();
  // Used up by the provider's word or the ratio itself, not by rounding: a
  // window with 0.4% left reads "100% used" (rounded), as the bulk dialog
  // says, not "Used up".
  const usedUp = window.status === "limit_reached" || (window.usedRatio ?? 0) >= 1;
  const used = usedUp ? 100 : (window.usedRatio ?? 0) * 100;
  const percentUsed = runtimeUsagePercentUsed(window.usedRatio ?? 0);
  const reset = window.resetsAt
    ? formatRelativeTime(window.resetsAt, locale) ?? formatMessage({ id: "machine.runtimeUsage.later" })
    : null;
  const valueText = usedUp
    ? reset === null
      ? formatMessage({ id: "machine.runtimeUsage.windowUsedUpResetUnavailable" })
      : formatMessage({ id: "machine.runtimeUsage.windowUsedUp" }, { reset })
    : reset === null
      ? formatMessage({ id: "machine.runtimeUsage.windowUsedResetUnavailable" }, { percent: percentUsed })
      : formatMessage({ id: "machine.runtimeUsage.windowUsed" }, { percent: percentUsed, reset });
  return (
    <Meter used={used} valueText={valueText} size="sm">
      <MeterHeader>
        <MeterLabel>{window.label}</MeterLabel>
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
}: {
  result: RuntimeAccountUsageReadResult | null;
  loading: boolean;
  loadError: boolean;
  /** Replaces the closing "Updated …" line (the move dialog's offline computer says when it last reported). */
  metadata?: string;
}) {
  const { formatMessage, locale } = useIntl();
  if (loading && !result) {
    return <div className="px-4 py-5 text-callout text-foreground-muted">{formatMessage({ id: "machine.runtimeUsage.reading" })}</div>;
  }
  if (loadError && !result) {
    return (
      <div className="flex items-start gap-2 px-4 py-5 text-callout text-warning-strong">
        <TriangleAlert size={16} className="mt-0.5 shrink-0" />
        {formatMessage({ id: "machine.runtimeUsage.readFailed" })}
      </div>
    );
  }
  if (!result || result.snapshot === null) {
    return (
      <div className="px-4 py-5">
        <div className="text-callout font-bold text-foreground">{formatMessage({ id: "machine.runtimeUsage.noSnapshot" })}</div>
        <p className="mt-1 text-footnote text-foreground-muted">
          {formatMessage({ id: "machine.runtimeUsage.noSnapshotDescription" })}
        </p>
      </div>
    );
  }

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
          return (
            <Fragment key={account.accountKey}>
            {index > 0 ? <Separator /> : null}
            <div className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-callout font-bold text-foreground">
                    {account.planLabel ?? formatMessage({ id: "machine.runtimeUsage.accountFallback" })}
                  </div>
                  {(identity || resets !== undefined) && (
                    <div className="mt-0.5 flex min-w-0 items-baseline gap-2">
                      {identity && (
                        <span className="min-w-0 truncate font-mono text-mono-meta text-foreground-hint" data-testid="runtime-account-masked-label">
                          {identity}
                        </span>
                      )}
                      {identity && resets !== undefined ? <Separator orientation="vertical" className="h-3 self-center" /> : null}
                      {/* The account's limit resets (Codex), beside the account they belong to. */}
                      {resets !== undefined && (
                        <span className="shrink-0 text-caption text-foreground-muted" data-testid="runtime-account-limit-resets">
                          {resets > 0
                            ? formatMessage({ id: "machine.runtimeUsage.limitResets.left" }, { count: resets })
                            : formatMessage({ id: "machine.runtimeUsage.limitResets.none" })}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {/* Raft DS StatusChip: soft wash, a square pixel, one word. */}
                <Badge
                  appearance="soft"
                  variant={account.health === "ok" ? "success" : "warning"}
                >
                  <Status size="md" variant={account.health === "ok" ? "success" : "warning"} aria-hidden="true" />
                  {formatMessage({ id: `machine.runtimeUsage.health.${account.health}` })}
                </Badge>
              </div>
              {account.health === "unsupported" ? null : account.health === "error" ? (
                <p className="mt-3 text-footnote text-foreground-muted">
                  {formatMessage({ id: "machine.runtimeUsage.readFailed" })}
                </p>
              ) : reauth ? (
                <p className="mt-3 text-footnote text-foreground-muted">
                  {formatMessage({ id: "machine.runtimeUsage.reauthDescription" })}
                </p>
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
                    <UsageWindowMeter key={window.id} window={window} />
                  ))}
                </div>
              )}
            </div>
            </Fragment>
          );
        })}
      </div>
      <Separator />
      <div className="px-4 py-2 text-caption text-foreground-hint">
        {metadata ?? formatMessage(
          { id: "machine.runtimeUsage.updated" },
          {
            updated: formatRelativeTime(result.snapshot.collectedAt, locale) ?? formatMessage({ id: "machine.runtimeUsage.recently" }),
          },
        )}
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
}

/**
 * The sign-in state under the title. The account line shows only when the
 * usage block does not already name the plan and email below. A card with no
 * usage (Qoder) says it is signed in, as nothing else on it would.
 */
function RuntimeAuthHeaderLine({ runtime, status, usageShowsAccount, authOnly }: { runtime: RuntimeAuthRuntime; status: RuntimeAuthStatus | null; usageShowsAccount: boolean; authOnly: boolean }) {
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
  if (hasProviderKey(runtime)) {
    // Presence only: configured or not; anything else (unknown, unavailable) says nothing.
    if (status?.kind !== "logged_in" && status?.kind !== "logged_out") return null;
    const configured = status.kind === "logged_in";
    return (
      <Badge appearance="soft" variant={configured ? "success" : "warning"} className="mt-1" data-testid={configured ? "runtime-provider-configured" : "runtime-provider-not-configured"}>
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
      <Badge appearance="soft" variant="warning" className="mt-1" data-testid="runtime-auth-logged-out">
        {formatMessage({ id: "machine.runtimeAuth.notSignedIn" })}
      </Badge>
    );
  }
  const account = status?.kind === "logged_in" && !usageShowsAccount ? accountText(status.account) : null;
  if (account) {
    return (
      <div className="mt-1 truncate text-callout font-bold text-foreground" data-testid="runtime-auth-account">
        {account}
      </div>
    );
  }
  if (authOnly && status?.kind === "logged_in") {
    return (
      <Badge appearance="soft" variant="success" className="mt-1" data-testid="runtime-auth-logged-in">
        {formatMessage({ id: "machine.runtimeAuth.signedIn" })}
      </Badge>
    );
  }
  return null;
}

/**
 * Sign-in is unavailable on the Computer (its CLI is missing, too old or an
 * installation OAR can't use): say so, and how to install it, instead of
 * leaving the card without an action (#triage:#253). A runtime with no known
 * install command gets the sentence alone.
 */
function RuntimeAuthUnavailable({ runtimeId, reason }: { runtimeId: string; reason: Extract<RuntimeAuthStatus, { kind: "unavailable" }>["reason"] }) {
  const { formatMessage } = useIntl();
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

/**
 * The card's sign-in action for a person who may act on the Computer's
 * runtimes: a button (sign in, sign out, connect a provider), or the hint
 * that says why there is none here. Nothing for anyone else.
 */
function runtimeAuthAction(auth: SurfaceAuth, runtimeId: string, formatMessage: IntlShape["formatMessage"]): ReactNode {
  const { runtime, status, view } = auth;
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
  if (status?.kind === "unavailable") return <RuntimeAuthUnavailable runtimeId={runtimeId} reason={status.reason} />;
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
  if (status === null || status.kind === "logged_out" || status.kind === "unknown") {
    return (
      <Button size="md" variant="primary" type="button" onClick={auth.onSignIn}>
        <LogIn size={16} aria-hidden="true" />
        {formatMessage({ id: "machine.runtimeAuth.signInAction" })}
      </Button>
    );
  }
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
        <ListRowBottom>
          <ListRowDescription>
            {formatMessage({ id: key
              ? "machine.runtimeAuth.pi.method.apiKey"
              // OpenCode does not say whether an account is a subscription: neither is claimed.
              : provider.subscription === undefined ? "machine.runtimeAuth.signedIn"
                : provider.subscription ? "machine.runtimeAuth.pi.method.subscription" : "machine.runtimeAuth.pi.method.account" })}
          </ListRowDescription>
        </ListRowBottom>
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
}

/**
 * Claude limit resets on the card (claude_limit_reset), for a person who may
 * act: `computer_upgrade_required` says the one step (upgrade); `ok` offers
 * "View available resets" and, at the 5-hour limit, "Use 5-hour reset" as the
 * card's main action. `onView` is null for an account known to be on Claude's
 * older program at its 5-hour limit, where opening the list would use it.
 * `ownerOnly`: the viewer (an owner or admin) did not connect this Computer,
 * so they may view its resets but not use one; the card says so.
 */
export type SurfaceClaudeLimitReset =
  | { state: "computer_upgrade_required" }
  | { state: "ok"; atFiveHourLimit: boolean; onView: (() => void) | null; onUseFiveHour: (() => void) | null; ownerOnly?: boolean };

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
  const usageShowsAccount = showsUsage && result !== null && result.snapshot !== null && result.snapshot.accounts.length > 0;
  const version = runtimeVersion?.trim() || null;
  const authAction = auth ? runtimeAuthAction(auth, runtimeId, formatMessage) : null;
  // Only a state worth saying: a refresh in flight or refused, the
  // Computer offline, or what the last limit reset did.
  const statusText = note
    ?? (refreshState === "requested"
      ? formatMessage({ id: "machine.runtimeUsage.refreshRequested" })
      : refreshState === "unconfirmed"
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
  return (
    <div data-testid={provider ? `runtime-usage-surface-${provider}` : `runtime-auth-surface-${runtimeId}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line-hairline px-4 py-3">
        <div className="min-w-0">
          <div className="text-headline text-foreground" data-testid="runtime-usage-title">
            {showsUsage ? formatMessage({ id: "machine.runtimeUsage.title" }, { runtime: runtimeName }) : runtimeName}
          </div>
          {auth ? <RuntimeAuthHeaderLine runtime={auth.runtime} status={auth.status} usageShowsAccount={usageShowsAccount} authOnly={provider === null || result?.state === "unsupported"} /> : null}
          {/* The bare version number, quiet: a mono meta line says what it is. None when unknown. */}
          {version ? (
            <div data-testid={`runtime-version-${provider ?? runtimeId}`} className="font-mono text-mono-meta text-foreground-hint">
              {version}
            </div>
          ) : null}
          <div className="text-caption text-foreground-hint">{formatMessage({ id: "machine.runtimeUsage.private" })}</div>
        </div>
        {onClose ? (
          <CloseButton type="button" className={ICON_BAR_END_PULL} onClick={onClose} aria-label={formatMessage({ id: "machine.runtimeUsage.close" })}>
            <X size={16} />
          </CloseButton>
        ) : null}
      </div>
      {readinessHolds(readiness) ? <RuntimeReadinessNotice readiness={readiness} runtimeId={runtimeId} /> : null}
      {showsUsage ? <RuntimeUsageContents result={result} loading={loading} loadError={loadError} /> : null}
      {showsUsage ? (
        // One action row: the quiet sign-in action on the left, Refresh and
        // Use a reset on the right (the reset is the primary action only while
        // the account is rate-limited). What just happened, if anything, is
        // one caption line under it; nothing by default.
        <div className="border-t border-line-hairline px-4 py-2.5" data-testid="runtime-usage-actions">
          <div className="flex flex-wrap items-center gap-2">
            {authAction}
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <Button size="md"
                variant="outline"
                type="button"
                onClick={onRefresh}
                disabled={refreshState === "requesting" || cooldownLeftMs > 0}
                className="shrink-0"
              >
                {/* Waiting with no known end: the pixel spinner (Raft DS Loading). */}
                {refreshState === "requesting"
                  ? <Spinner size="xs" aria-hidden="true" />
                  : <RefreshCw size={16} aria-hidden="true" />}
                {formatMessage({ id: "machine.runtimeUsage.refresh" })}
              </Button>
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
                  {formatMessage({ id: "machine.runtimeUsage.limitReset.action" })}
                </Button>
              ) : null}
              {claudeLimitReset?.state === "ok" && claudeLimitReset.onView ? (
                <Button size="md"
                  variant="outline"
                  type="button"
                  onClick={claudeLimitReset.onView}
                  className="shrink-0"
                  data-testid="claude-limit-resets-view-action"
                >
                  <ListChecks size={16} aria-hidden="true" />
                  {formatMessage({ id: "machine.runtimeUsage.claudeReset.viewAction" })}
                </Button>
              ) : null}
              {claudeLimitReset?.state === "ok" && claudeLimitReset.onUseFiveHour ? (
                <Button size="md"
                  variant="primary"
                  type="button"
                  onClick={claudeLimitReset.onUseFiveHour}
                  className="shrink-0"
                  data-testid="claude-limit-reset-five-hour-action"
                  data-primary-action=""
                >
                  <TimerReset size={16} aria-hidden="true" />
                  {formatMessage({ id: "machine.runtimeUsage.claudeReset.useFiveHourAction" })}
                </Button>
              ) : null}
            </div>
          </div>
          {claudeLimitReset?.state === "ok" && claudeLimitReset.ownerOnly ? (
            <p className="mt-1.5 text-caption text-foreground-hint" data-testid="claude-limit-resets-owner-only">
              {formatMessage({ id: "machine.runtimeUsage.claudeReset.ownerOnly" })}
            </p>
          ) : null}
          {statusText ? (
            <p className="mt-1.5 text-caption text-foreground-hint" role="status" data-testid="runtime-usage-status">{statusText}</p>
          ) : null}
        </div>
      ) : (
        <>
          {auth ? <PerProviderRows auth={auth} /> : null}
          {authAction ? (
            <div className="flex flex-col items-start gap-1.5 px-4 py-2.5">
              {authAction}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
