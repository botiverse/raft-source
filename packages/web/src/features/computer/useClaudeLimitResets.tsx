import { CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY, claudeFiveHourLimitOf } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageProvider, RuntimeAuthStatus, RuntimeLimitResetIdempotencyKey, RuntimeLimitResetKind } from "@botiverse/raft-shared";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { SurfaceClaudeLimitReset } from "../../components/machine/RuntimeUsageSurface";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import type { RuntimeAccountUsageReadResult } from "../../utils/runtimeAccountUsageClient";
import type { RuntimeAuthClient, RuntimeAuthView } from "../../utils/runtimeAuthClient";
import { ClaudeLimitResetConfirmDialog, ClaudeLimitResetsDialog } from "./ClaudeLimitResetsDialog";
import { claudeLimitResetsNotSupportedHere } from "./claudeLimitResetCopy";
import { forgetLimitResetAttemptKey, limitResetAttemptKey } from "./limitResetAttemptKey";
import type { RuntimeLimitResetOutcome } from "./limitResetOutcome";

/**
 * Claude limit resets on the usage card (claude_limit_reset;
 * docs/contracts/runtime-account-usage.md): what the card offers, and the
 * list and confirm dialogs. Shown only to a person who may act on the
 * Computer's runtimes, where the flag is on and the server says what this
 * Computer can do (`RuntimeAuthView.claudeLimitResets`).
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
  // Claude limit resets (claude_limit_reset): the list, and the confirm of one kind over it or on its own.
  const [claudeDialog, setClaudeDialog] = useState<{
    subject: string;
    list: boolean;
    confirm: { kind: RuntimeLimitResetKind; key: RuntimeLimitResetIdempotencyKey; account: string | null } | null;
  } | null>(null);
  // The Claude account (on this server and Computer) a read or a redeem showed
  // on the older once-a-week 5-hour program: at the 5-hour limit its card
  // offers only "Use 5-hour reset", since opening the list there would use
  // it. The card's own state, for as long as the card is mounted.
  const [legacyAccount, setLegacyAccount] = useState<string | null>(null);
  // The Computer (on this server, for this provider) answered that Claude
  // limit resets cannot run there (macOS): the card stops offering them.
  const [notSupportedSubject, setNotSupportedSubject] = useState<string | null>(null);
  const markNotSupported = useCallback(() => setNotSupportedSubject(limitResetSubject), [limitResetSubject]);
  // Claude: only where claude_limit_reset is on and the server says what this Computer can do.
  const claudeFlagOn = useServerFeatureFlag(CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY, { serverId }).enabled;
  const claudeAccount = provider === "claude" && result && result.snapshot !== null ? result.snapshot.accounts[0] ?? null : null;
  const claudeAtFiveHourLimit = provider === "claude" && result !== null && result.snapshot !== null
    && claudeFiveHourLimitOf(result.snapshot) === "at_limit";
  const claudeAccountLabel = claudeAccount ? claudeAccount.maskedLabel ?? claudeAccount.displayName ?? null : null;
  const legacySubject = `${limitResetSubject}\0${claudeAccount?.accountKey ?? ""}`;
  // Only the person who connected the Computer spends its Claude resets; an
  // owner or admin views them. An older server does not say: allowed, and it
  // still decides.
  const claudeCanUse = authView?.claudeLimitResetAccess?.canUse ?? true;
  const claudeCanConsent = authView?.claudeLimitResetAccess?.canConsent ?? true;
  const openClaudeList = useCallback(() => {
    onAuthDialog?.();
    setClaudeDialog({ subject: limitResetSubject, list: true, confirm: null });
  }, [limitResetSubject, onAuthDialog]);
  const openClaudeConfirm = useCallback((kind: RuntimeLimitResetKind, fromList: boolean) => {
    onAuthDialog?.();
    setClaudeDialog({
      subject: limitResetSubject,
      list: fromList,
      confirm: { kind, key: limitResetAttemptKey(`${limitResetSubject}\0${kind}`), account: claudeAccountLabel },
    });
  }, [claudeAccountLabel, limitResetSubject, onAuthDialog]);
  const pickClaudeKindFromList = useCallback((kind: RuntimeLimitResetKind) => openClaudeConfirm(kind, true), [openClaudeConfirm]);
  const closeClaudeDialogs = useCallback(() => setClaudeDialog(null), []);
  // Back to the list it came from, if any.
  const closeClaudeConfirm = useCallback(() => setClaudeDialog((current) => (current?.confirm ? { ...current, confirm: null } : current)), []);
  const handleClaudeOutcome = useCallback((outcome: RuntimeLimitResetOutcome & { kind: RuntimeLimitResetKind; note: string | null }) => {
    // Any answer ends the attempt (the Computer remembers a key only until it
    // restarts); a request that got no answer keeps the key for a retry.
    if (outcome.result !== null) forgetLimitResetAttemptKey(`${limitResetSubject}\0${outcome.kind}`);
    if (outcome.result?.kind === "unknown" && outcome.result.fiveHourSpent) setLegacyAccount(legacySubject);
    if (outcome.result && claudeLimitResetsNotSupportedHere(outcome.result)) setNotSupportedSubject(limitResetSubject);
    if (outcome.note !== null) {
      onNote(outcome.note);
      setClaudeDialog(null);
    }
    if (outcome.result !== null) showUsageAfterReset(outcome);
  }, [legacySubject, limitResetSubject, onNote, showUsageAfterReset]);
  const handleClaudeLegacy = useCallback((spent: boolean) => {
    setLegacyAccount(legacySubject);
    if (spent) void refresh();
  }, [legacySubject, refresh]);
  const surfaceClaudeLimitReset = useMemo<SurfaceClaudeLimitReset | null>(() => {
    if (provider !== "claude" || !claudeFlagOn || !canActOnRuntimes || authStatus?.kind === "logged_out") return null;
    const state = authView?.claudeLimitResets;
    if (!state || notSupportedSubject === limitResetSubject) return null;
    if (state === "computer_upgrade_required") return { state };
    const legacyAtLimit = claudeAtFiveHourLimit && legacyAccount === legacySubject;
    return {
      state,
      atFiveHourLimit: claudeAtFiveHourLimit,
      onView: legacyAtLimit ? null : openClaudeList,
      onUseFiveHour: claudeAtFiveHourLimit && claudeCanUse ? () => openClaudeConfirm("five_hour", false) : null,
      ownerOnly: !claudeCanUse,
    };
  }, [authStatus?.kind, authView?.claudeLimitResets, canActOnRuntimes, claudeAtFiveHourLimit, claudeCanUse, claudeFlagOn, legacyAccount, legacySubject, limitResetSubject, notSupportedSubject, openClaudeConfirm, openClaudeList, provider]);

  const dialogs = (
    <>
      {claudeDialog?.subject === limitResetSubject && claudeDialog.list && (
        <ClaudeLimitResetsDialog
          serverId={serverId}
          machineId={machineId}
          atFiveHourLimit={claudeAtFiveHourLimit}
          canUse={claudeCanUse}
          canConsent={claudeCanConsent}
          client={authClient}
          onUse={pickClaudeKindFromList}
          onLegacy={handleClaudeLegacy}
          onNotSupported={markNotSupported}
          onClose={closeClaudeDialogs}
        />
      )}
      {claudeDialog?.subject === limitResetSubject && claudeDialog.confirm && (
        <ClaudeLimitResetConfirmDialog
          serverId={serverId}
          machineId={machineId}
          kind={claudeDialog.confirm.kind}
          account={claudeDialog.confirm.account}
          atFiveHourLimit={claudeAtFiveHourLimit}
          idempotencyKey={claudeDialog.confirm.key}
          client={authClient}
          layer={claudeDialog.list ? 1 : 0}
          onOutcome={handleClaudeOutcome}
          onClose={closeClaudeConfirm}
        />
      )}
    </>
  );
  return { surface: surfaceClaudeLimitReset, dialogs };
}
