import { Spinner } from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import type {
  RuntimeAccountUsageSnapshot,
  RuntimeLimitResetIdempotencyKey,
  RuntimeLimitResetKind,
  RuntimeLimitResetResult,
  RuntimeLimitResetsReadResult,
} from "@botiverse/raft-shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import ConfirmDialog from "../../components/ConfirmDialog";
import Banner from "../../components/ui/Banner";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import { limitResetRequestErrorMessageId, limitResetRequestOutcomeUnknown } from "./limitResetOutcome";
import { claudeKindMeta, claudeKindName, claudeLimitResetNote, claudeLimitResetRefusal, claudeLimitResetsNotSupportedHere } from "./claudeLimitResetCopy";
import type { RuntimeLimitResetOutcome } from "./limitResetOutcome";

/**
 * Claude limit resets on the usage card (claude_limit_reset): the list of
 * kinds the account holds, read on the Computer through Claude Code's own
 * `/limit-reset` only when the person asks, and the confirm that uses one.
 * docs/contracts/runtime-account-usage.md, "Limit resets (Claude)".
 */

/**
 * Confirms using one kind of reset, naming the kind and the account, and that
 * it cannot be undone. Its key comes from the card: one per attempt on that
 * kind, the same one again after a request whose answer never arrived.
 */
export function ClaudeLimitResetConfirmDialog({
  serverId,
  machineId,
  kind,
  account,
  atFiveHourLimit,
  idempotencyKey,
  client,
  layer = 0,
  onOutcome,
  onClose,
}: {
  serverId: string;
  machineId: string;
  kind: RuntimeLimitResetKind;
  account: string | null;
  atFiveHourLimit: boolean;
  idempotencyKey: RuntimeLimitResetIdempotencyKey;
  client: RuntimeAuthClient;
  layer?: number;
  /** An answer the dialog closes on: the card shows `note` and the usage read after it. */
  onOutcome: (outcome: RuntimeLimitResetOutcome & { kind: RuntimeLimitResetKind; note: string | null }) => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const name = claudeKindName(formatMessage, kind);
  const handleConfirm = useCallback(async () => {
    let reply: { result: RuntimeLimitResetResult; snapshot: RuntimeAccountUsageSnapshot | null };
    try {
      reply = await client.redeemLimitReset(serverId, machineId, "claude", idempotencyKey, kind);
    } catch (error) {
      onOutcome({ kind, result: null, snapshot: null, note: null });
      // The Computer may have used it and the answer was lost: never "try again" blindly here.
      // A refusal (4xx) was answered before anything reached the Computer: nothing was used.
      if (limitResetRequestOutcomeUnknown(error)) {
        throw new Error(formatMessage({ id: "machine.runtimeUsage.claudeReset.timeout" }));
      }
      throw new Error(formatMessage({ id: limitResetRequestErrorMessageId(error) }, { runtime: "Claude Code" }));
    }
    const note = claudeLimitResetNote(formatMessage, kind, reply.result);
    onOutcome({ kind, result: reply.result, snapshot: reply.snapshot, note });
    if (note === null) throw new Error(claudeLimitResetRefusal(formatMessage, kind, reply.result, atFiveHourLimit));
  }, [atFiveHourLimit, client, formatMessage, idempotencyKey, kind, machineId, onOutcome, serverId]);
  const accountLabel = account ?? formatMessage({ id: "machine.runtimeUsage.limitReset.accountFallback" });
  return (
    <ConfirmDialog
      title={formatMessage({ id: "machine.runtimeUsage.claudeReset.confirmTitle" }, { kind: name })}
      plainMessage
      message={(
        <p className="text-subhead text-foreground-muted" data-testid="claude-limit-reset-confirm">
          {formatMessage(
            { id: "machine.runtimeUsage.claudeReset.confirmBody" },
            { kind: name, account: <span key="account" className="font-semibold text-foreground">{accountLabel}</span> },
          )}
        </p>
      )}
      confirmLabel={formatMessage({ id: "machine.runtimeUsage.claudeReset.confirm" }, { kind: name })}
      confirmVariant="primary"
      layer={layer}
      maxWidthClass="max-w-md"
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}

type ReadState =
  | { phase: "consent" }
  | { phase: "reading"; consent: boolean }
  | { phase: "read"; result: Extract<RuntimeLimitResetsReadResult, { kind: "read" }> }
  | { phase: "failed"; message: string };

/**
 * "View available resets": at the 5-hour limit it first asks the person to
 * accept that, on Claude's older program, opening the list there uses the
 * 5-hour reset. Then it reads, lists each kind with what Claude Code showed,
 * and hands the chosen one to `onUse` (the confirm). Nothing is retried for
 * the person.
 */
export function ClaudeLimitResetsDialog({
  serverId,
  machineId,
  atFiveHourLimit,
  canUse = true,
  canConsent = true,
  client,
  onUse,
  onLegacy,
  onNotSupported,
  onClose,
}: {
  serverId: string;
  machineId: string;
  /** The card's usage shows the account at its 5-hour limit: ask before reading. */
  atFiveHourLimit: boolean;
  /** The viewer connected this Computer: Use is offered (an owner or admin only views). */
  canUse?: boolean;
  /** The viewer connected this Computer: the read that may spend the 5-hour reset is offered. */
  canConsent?: boolean;
  client: RuntimeAuthClient;
  onUse: (kind: RuntimeLimitResetKind) => void;
  /** The read showed the older program; `spent`: opening the list used its 5-hour reset. */
  onLegacy: (spent: boolean) => void;
  /** The Computer cannot run Claude limit resets at all (macOS): the card stops offering them. */
  onNotSupported?: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const [state, setState] = useState<ReadState>(atFiveHourLimit ? { phase: "consent" } : { phase: "reading", consent: false });
  const [selected, setSelected] = useState<RuntimeLimitResetKind | null>(null);
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => { liveRef.current = false; };
  }, []);

  const read = useCallback(async (consent: boolean) => {
    let result: RuntimeLimitResetsReadResult;
    try {
      result = await client.readLimitResets(serverId, machineId, consent);
    } catch (error) {
      if (!liveRef.current) return;
      setState({
        phase: "failed",
        message: limitResetRequestOutcomeUnknown(error)
          ? formatMessage({ id: "machine.runtimeUsage.claudeReset.readTimeout" })
          : formatMessage({ id: limitResetRequestErrorMessageId(error) }, { runtime: "Claude Code" }),
      });
      return;
    }
    if (!liveRef.current) return;
    switch (result.kind) {
      case "read":
        if (result.program === "legacy") onLegacy(result.fiveHourSpent === true);
        // Nothing chosen for the person: Use stays off until they pick a kind.
        setSelected(null);
        setState({ phase: "read", result });
        return;
      case "unsupported":
        if (result.reason === "consent_required" && !consent) {
          setState({ phase: "consent" });
          return;
        }
        if (claudeLimitResetsNotSupportedHere(result)) {
          onNotSupported?.();
          setState({ phase: "failed", message: formatMessage({ id: "machine.runtimeUsage.claudeReset.notSupportedHere" }) });
          return;
        }
        setState({
          phase: "failed",
          message: result.reason === "not_attempted"
            ? formatMessage({ id: "machine.runtimeUsage.claudeReset.notAttempted" })
            : result.reason === "not_installed"
              ? formatMessage({ id: "machine.runtimeAuth.error.notInstalled" }, { runtime: "Claude Code" })
              : formatMessage({ id: "machine.runtimeUsage.limitReset.unsupported" }, { runtime: "Claude Code" }),
        });
        return;
      case "reauth_required":
        setState({ phase: "failed", message: formatMessage({ id: "machine.runtimeUsage.limitReset.reauth" }, { runtime: "Claude Code" }) });
        return;
      default:
        setState({ phase: "failed", message: formatMessage({ id: "machine.runtimeUsage.claudeReset.readFailed" }) });
    }
  }, [client, formatMessage, machineId, onLegacy, onNotSupported, serverId]);

  // The first read starts on open when no consent is needed; a later one only from Continue.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || state.phase !== "reading") return;
    startedRef.current = true;
    void read(state.consent);
  }, [read, state]);

  // One read with consent per dialog, however often Continue is pressed.
  const consentedRef = useRef(false);
  const confirmConsent = useCallback(() => {
    if (!canConsent || consentedRef.current) return;
    consentedRef.current = true;
    startedRef.current = true;
    setState({ phase: "reading", consent: true });
    void read(true);
  }, [canConsent, read]);
  const listed = state.phase === "read" ? state.result : null;
  const legacy = listed?.program === "legacy";
  const items = useMemo<ChoiceListItem[]>(() => (listed && !legacy
    ? listed.resets.map((reset) => ({
        value: reset.kind,
        label: claudeKindName(formatMessage, reset.kind),
        meta: claudeKindMeta(formatMessage, reset),
        // At the 5-hour limit only a 5-hour reset is used from here (the hint below says where the others are).
        disabled: reset.state !== "available" || (atFiveHourLimit && reset.kind !== "five_hour"),
      }))
    : []), [atFiveHourLimit, formatMessage, legacy, listed]);
  const usable = canUse && selected !== null && items.some((item) => item.value === selected && !item.disabled);
  const useSelected = useCallback(() => {
    if (usable && selected) onUse(selected);
  }, [onUse, selected, usable]);
  const choose = useCallback((value: string) => setSelected(value as RuntimeLimitResetKind), []);

  if (state.phase === "consent" && !canConsent) {
    // An owner or admin who did not connect the Computer: the read could spend
    // the 5-hour reset of someone else's account, so there is no Continue.
    return (
      <ConfirmDialog
        title={formatMessage({ id: "machine.runtimeUsage.claudeReset.consentTitle" })}
        message={(
          <p className="text-subhead text-foreground-muted" data-testid="claude-limit-resets-consent-owner-only">
            {formatMessage({ id: "machine.runtimeUsage.claudeReset.ownerOnly" })}
          </p>
        )}
        plainMessage
        confirmLabel={formatMessage({ id: "machine.runtimeUsage.claudeReset.consentConfirm" })}
        confirmVariant="warning"
        confirmDisabled
        initialFocus="cancel"
        maxWidthClass="max-w-md"
        onConfirm={confirmConsent}
        onClose={onClose}
      />
    );
  }

  if (state.phase === "consent") {
    return (
      <ConfirmDialog
        title={formatMessage({ id: "machine.runtimeUsage.claudeReset.consentTitle" })}
        message={formatMessage({ id: "machine.runtimeUsage.claudeReset.consentBody" })}
        confirmLabel={formatMessage({ id: "machine.runtimeUsage.claudeReset.consentConfirm" })}
        // Disruptive but chosen with eyes open: orange, not the red of a sure loss.
        confirmVariant="warning"
        initialFocus="cancel"
        closeOnConfirm={false}
        maxWidthClass="max-w-md"
        onConfirm={confirmConsent}
        onClose={onClose}
      />
    );
  }

  const title = formatMessage({ id: "machine.runtimeUsage.claudeReset.dialogTitle" });
  const reading = state.phase === "reading";
  return (
    <ConfirmDialog
      title={title}
      plainMessage
      size="md"
      closeOnConfirm={false}
      confirmVariant="primary"
      confirmDisabled={!usable}
      hideCancel={false}
      confirmLabel={formatMessage({ id: "machine.runtimeUsage.claudeReset.useSelectedAction" })}
      onConfirm={useSelected}
      onClose={onClose}
      message={(
        <div className="stack-y-3" data-testid="claude-limit-resets-dialog" aria-busy={reading}>
          {reading && (
            <div className="flex items-center gap-2 text-subhead text-foreground-muted" role="status" data-testid="claude-limit-resets-reading">
              <Spinner size="xs" aria-hidden="true" />
              {formatMessage({ id: "machine.runtimeUsage.claudeReset.reading" })}
            </div>
          )}
          {state.phase === "failed" && (
            <Banner intent="warning" data-testid="claude-limit-resets-failed">{state.message}</Banner>
          )}
          {listed?.fiveHourSpent && (
            <Banner intent="warning" data-testid="claude-limit-resets-five-hour-spent">
              {formatMessage({ id: "machine.runtimeUsage.claudeReset.readFiveHourSpent" })}
            </Banner>
          )}
          {legacy && (
            <p className="text-subhead text-foreground-muted" data-testid="claude-limit-resets-legacy">
              {formatMessage({ id: "machine.runtimeUsage.claudeReset.legacy" })}
            </p>
          )}
          {items.length > 0 && (
            <ChoiceList
              items={items}
              value={selected}
              onValueChange={choose}
              aria-label={formatMessage({ id: "machine.runtimeUsage.claudeReset.listLabel" })}
              searchLabel={formatMessage({ id: "machine.runtimeUsage.claudeReset.listLabel" })}
              clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
            />
          )}
          {items.length > 0 && !canUse && (
            <p className="text-footnote text-foreground-muted" data-testid="claude-limit-resets-owner-only">
              {formatMessage({ id: "machine.runtimeUsage.claudeReset.ownerOnly" })}
            </p>
          )}
          {items.length > 0 && atFiveHourLimit && (
            <p className="text-footnote text-foreground-muted" data-testid="claude-limit-resets-at-limit-hint">
              {formatMessage({ id: "machine.runtimeUsage.claudeReset.atLimitHint" })}
            </p>
          )}
        </div>
      )}
    />
  );
}
