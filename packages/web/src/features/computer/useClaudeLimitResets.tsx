import { CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY, claudeFiveHourLimitOf, defaultRuntimeUsageAccount } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageProvider, RuntimeAuthStatus, RuntimeLimitResetIdempotencyKey, RuntimeLimitResetKind } from "@botiverse/raft-shared";
import { useCallback, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import type { ReactNode } from "react";
import type { SurfaceClaudeLimitReset } from "../../components/machine/RuntimeUsageSurface";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import type { RuntimeAccountUsageReadResult } from "../../utils/runtimeAccountUsageClient";
import type { RuntimeAuthClient, RuntimeAuthView } from "../../utils/runtimeAuthClient";
import { ClaudeLimitResetConfirmDialog, ClaudeLimitResetsDialog } from "./ClaudeLimitResetsDialog";
import { claudeLimitResetKeptNote, claudeLimitResetsNotSupportedHere } from "./claudeLimitResetCopy";
import type { ClaudeLimitResetAvailable } from "./claudeLimitResetCopy";
import { claudeLimitResetOffer } from "./claudeLimitResetOffer";
import { forgetLimitResetAttemptKey, limitResetAttemptKey } from "./limitResetAttemptKey";
import type { RuntimeLimitResetOutcome } from "./limitResetOutcome";

/**
 * Claude limit resets on the usage card (claude_limit_reset_v2;
 * docs/contracts/runtime-account-usage.md): what the card offers, and the
 * list and confirm dialogs. Shown only to a person who may act on the
 * Computer's runtimes, where the flag is on and the server says what this
 * Computer can do (`RuntimeAuthView.claudeLimitResets`). What this viewer is
 * offered ("Use a limit reset", the list only, or nothing) is
 * `claudeLimitResetOffer`. "Use a limit reset" goes as Claude Code's
 * `/limit-reset`: read, then the confirm of the one usable kind (or the
 * chosen one), or a line on the card.
 */
export function useClaudeLimitResets({
  serverId,
  machineId,
  provider,
  result,
  authView,
  authStatus,
  canActOnRuntimes,
  limitResetSubject,
  authClient,
  onAuthDialog,
  refresh,
  showUsageAfterReset,
  onNote,
}: {
  serverId: string;
  machineId: string;
  provider: RuntimeAccountUsageProvider | null;
  result: RuntimeAccountUsageReadResult | null;
  authView: RuntimeAuthView | null;
  authStatus: RuntimeAuthStatus | null;
  canActOnRuntimes: boolean;
  /** Server, Computer and provider: keys and notes never cross them. */
  limitResetSubject: string;
  authClient: RuntimeAuthClient;
  onAuthDialog?: () => void;
  refresh: () => Promise<void>;
  showUsageAfterReset: (outcome: RuntimeLimitResetOutcome) => void;
  onNote: (text: string) => void;
}): { surface: SurfaceClaudeLimitReset | null; dialogs: ReactNode } {
  const { formatMessage } = useIntl();
  // Claude limit resets (claude_limit_reset_v2): the read (and the choice, if any), then the confirm of one kind in its place.
  const [claudeDialog, setClaudeDialog] = useState<
    | { subject: string; step: "read" }
    | { subject: string; step: "confirm"; status: ClaudeLimitResetAvailable; atLimit: boolean; key: RuntimeLimitResetIdempotencyKey; account: string | null }
    | null
  >(null);
  // The Computer (on this server, for this provider) answered that Claude
  // limit resets cannot run there (macOS): the card stops offering them.
  const [notSupportedSubject, setNotSupportedSubject] = useState<string | null>(null);
  const markNotSupported = useCallback(() => setNotSupportedSubject(limitResetSubject), [limitResetSubject]);
  // Claude: only where claude_limit_reset_v2 is on and the server says what this Computer can do.
  const claudeFlagOn = useServerFeatureFlag(CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY, { serverId }).enabled;
  // Limit resets act on the Computer's default account only, never an agent's own folder's.
  const claudeAccount = provider === "claude" && result && result.snapshot !== null ? defaultRuntimeUsageAccount(result.snapshot) : null;
  const claudeAtFiveHourLimit = provider === "claude" && result !== null && result.snapshot !== null
    && claudeFiveHourLimitOf(result.snapshot) === "at_limit";
  const claudeAccountLabel = claudeAccount ? claudeAccount.maskedLabel ?? claudeAccount.displayName ?? null : null;
  const openClaudeRead = useCallback(() => {
    onAuthDialog?.();
    setClaudeDialog({ subject: limitResetSubject, step: "read" });
  }, [limitResetSubject, onAuthDialog]);
  // The read's one usable kind, or the one chosen: its confirm takes the read's place.
  const openClaudeConfirm = useCallback((status: ClaudeLimitResetAvailable, atLimit: boolean) => {
    setClaudeDialog({
      subject: limitResetSubject,
      step: "confirm",
      status,
      atLimit,
      key: limitResetAttemptKey(`${limitResetSubject}\0${status.kind}`),
      account: claudeAccountLabel,
    });
  }, [claudeAccountLabel, limitResetSubject]);
  const closeClaudeDialogs = useCallback(() => setClaudeDialog(null), []);
  const handleClaudeReadNote = useCallback((text: string, usageChanged: boolean) => {
    onNote(text);
    setClaudeDialog(null);
    if (usageChanged) void refresh();
  }, [onNote, refresh]);
  const closeClaudeConfirm = useCallback((kept: boolean) => {
    // "No, keep it" before anything was sent: said as Claude Code says it.
    if (kept && claudeDialog?.step === "confirm") onNote(claudeLimitResetKeptNote(formatMessage, claudeDialog.status.kind, claudeDialog.status));
    setClaudeDialog(null);
  }, [claudeDialog, formatMessage, onNote]);
  const handleClaudeOutcome = useCallback((outcome: RuntimeLimitResetOutcome & { kind: RuntimeLimitResetKind; note: string | null }) => {
    // Any answer ends the attempt (the Computer remembers a key only until it
    // restarts); a request that got no answer keeps the key for a retry.
    if (outcome.result !== null) forgetLimitResetAttemptKey(`${limitResetSubject}\0${outcome.kind}`);
    if (outcome.result && claudeLimitResetsNotSupportedHere(outcome.result)) setNotSupportedSubject(limitResetSubject);
    if (outcome.note !== null) {
      onNote(outcome.note);
      setClaudeDialog(null);
    }
    if (outcome.result !== null) showUsageAfterReset(outcome);
  }, [limitResetSubject, onNote, showUsageAfterReset]);
  // What this viewer is offered: use, the list only, or nothing.
  const offer = claudeLimitResetOffer({
    provider,
    flagOn: claudeFlagOn,
    canActOnRuntimes,
    authStatus,
    authView,
    atFiveHourLimit: claudeAtFiveHourLimit,
    notSupportedHere: notSupportedSubject === limitResetSubject,
  });
  const surfaceClaudeLimitReset = useMemo<SurfaceClaudeLimitReset | null>(() => (offer === null ? null : {
    atFiveHourLimit: claudeAtFiveHourLimit,
    canUse: offer === "ok",
    onOpen: openClaudeRead,
  }), [claudeAtFiveHourLimit, offer, openClaudeRead]);

  const dialogs = claudeDialog?.subject !== limitResetSubject ? null : claudeDialog.step === "read" ? (
    <ClaudeLimitResetsDialog
      serverId={serverId}
      machineId={machineId}
      atFiveHourLimit={claudeAtFiveHourLimit}
      canUse={authView?.claudeLimitResetAccess?.canUse ?? true}
      client={authClient}
      onUse={openClaudeConfirm}
      onNote={handleClaudeReadNote}
      onNotSupported={markNotSupported}
      onClose={closeClaudeDialogs}
    />
  ) : (
    <ClaudeLimitResetConfirmDialog
      serverId={serverId}
      machineId={machineId}
      kind={claudeDialog.status.kind}
      status={claudeDialog.status}
      account={claudeDialog.account}
      atFiveHourLimit={claudeAtFiveHourLimit || claudeDialog.atLimit}
      idempotencyKey={claudeDialog.key}
      client={authClient}
      onOutcome={handleClaudeOutcome}
      onClose={closeClaudeConfirm}
    />
  );
  return { surface: surfaceClaudeLimitReset, dialogs };
}
