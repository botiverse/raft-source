import { ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle, Spinner } from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import type {
  RuntimeAccountUsageSnapshot,
  RuntimeLimitResetIdempotencyKey,
  RuntimeLimitResetKind,
  RuntimeLimitResetKindStatus,
  RuntimeLimitResetResult,
  RuntimeLimitResetsReadResult,
} from "@botiverse/raft-shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import ConfirmDialog from "../../components/ConfirmDialog";
import Banner from "../../components/ui/Banner";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import { limitResetRequestErrorMessageId, limitResetRequestOutcomeUnknown } from "./limitResetOutcome";
import {
  claudeKindMeta,
  claudeKindName,
  claudeLimitResetNote,
  claudeLimitResetReadStep,
  claudeLimitResetRefusal,
  claudeLimitResetsNotSupportedHere,
  claudeLimitResetsNotSupportedMessageId,
} from "./claudeLimitResetCopy";
import type { ClaudeLimitResetAvailable } from "./claudeLimitResetCopy";
import type { RuntimeLimitResetOutcome } from "./limitResetOutcome";

/**
 * Claude limit resets on the usage card (claude_limit_reset_v2), as Claude
 * Code's own `/limit-reset` goes: "Use a limit reset" reads the kinds the
 * account holds on the Computer (the read is a bare `/limit-reset` there),
 * then one usable kind goes straight to its confirm, several to "Which reset
 * do you want to use?", and anything else ends with a line on the card.
 * docs/contracts/runtime-account-usage.md, "Limit resets (Claude)".
 */

/**
 * Confirms using one kind of reset in Claude Code's words ("Use a weekly
 * reset?", "Yes, use my weekly reset" / "No, keep it"), naming the account
 * (Raft acts on another machine's account) and what the read said of the
 * kind. Its key comes from the card: one per attempt on that kind, the same
 * one again after a request whose answer never arrived. Closed before
 * anything was sent, `onClose(true)`: the reset was kept.
 */
export function ClaudeLimitResetConfirmDialog({
  serverId,
  machineId,
  kind,
  status = null,
  account,
  atFiveHourLimit,
  idempotencyKey,
  client,
  onOutcome,
  onClose,
}: {
  serverId: string;
  machineId: string;
  kind: RuntimeLimitResetKind;
  /** What the read said of this kind: its "2 left · use by …" line. */
  status?: RuntimeLimitResetKindStatus | null;
  account: string | null;
  atFiveHourLimit: boolean;
  idempotencyKey: RuntimeLimitResetIdempotencyKey;
  client: RuntimeAuthClient;
  /** An answer the dialog closes on: the card shows `note` and the usage read after it. */
  onOutcome: (outcome: RuntimeLimitResetOutcome & { kind: RuntimeLimitResetKind; note: string | null }) => void;
  /** `kept`: closed before any request was sent ("No, keep it"). */
  onClose: (kept: boolean) => void;
}) {
  const { formatMessage } = useIntl();
  const name = claudeKindName(formatMessage, kind);
  const sentRef = useRef(false);
  const handleConfirm = useCallback(async () => {
    sentRef.current = true;
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
  const close = useCallback(() => onClose(!sentRef.current), [onClose]);
  const accountLabel = account ?? formatMessage({ id: "machine.runtimeUsage.limitReset.accountFallback" });
  const detail = status?.state === "available" ? claudeKindMeta(formatMessage, status, "useBy") : null;
  return (
    <ConfirmDialog
      title={formatMessage({ id: "machine.runtimeUsage.claudeReset.confirmTitle" }, { kind: name })}
      plainMessage
      message={(
        <div className="stack-y-1" data-testid="claude-limit-reset-confirm">
          <p className="text-subhead text-foreground-muted">
            {formatMessage(
              { id: "machine.runtimeUsage.claudeReset.confirmBody" },
              { account: <span key="account" className="font-semibold text-foreground">{accountLabel}</span> },
            )}
          </p>
          {detail && <p className="text-footnote text-foreground-muted" data-testid="claude-limit-reset-confirm-detail">{detail}</p>}
        </div>
      )}
      confirmLabel={formatMessage({ id: "machine.runtimeUsage.claudeReset.confirm" }, { kind: name })}
      cancelLabel={formatMessage({ id: "machine.runtimeUsage.claudeReset.keep" })}
      confirmVariant="primary"
      maxWidthClass="max-w-md"
      onConfirm={handleConfirm}
      onClose={close}
    />
  );
}

type ReadState =
  | { phase: "reading"; consent: boolean }
  | { phase: "read"; result: Extract<RuntimeLimitResetsReadResult, { kind: "read" }> }
  | { phase: "choose"; usable: ClaudeLimitResetAvailable[]; atLimit: boolean }
  | { phase: "failed"; message: string };

/**
 * "Use a limit reset": it reads at once ("This takes a moment"), then goes on
 * as Claude Code's `/limit-reset` does (`claudeLimitResetReadStep`): one
 * usable kind is handed to `onUse` (the confirm) without a list; several are
 * offered under "Which reset do you want to use?" ("Use a weekly reset",
 * "2 left · until …"), the chosen one handed to `onUse`; otherwise the read
 * ends with a line for the card (`onNote`), such as "5-hour limit reset ·
 * your weekly limit still applies" when on Claude's older program the read
 * itself used the 5-hour reset. Nothing is retried for the person.
 *
 * A viewer the server says may not use them (`canUse` false: only an older
 * server, which kept Claude resets to the person who connected the Computer;
 * the current one lets owners and admins use them too) gets "View available
 * resets": the same read as a plain list of every kind, display-only rows,
 * Close as the one action, and copy that speaks of the Computer's resets, not
 * "yours". The card opens it for them only where the read needs no consent
 * (`claudeLimitResetOffer`). If the Computer asks for one anyway, no read with
 * consent is sent and the dialog says who can use the resets.
 *
 * Someone who may use a reset is never asked first (artin,
 * #proj-raft-computer:4e327d5c): at the 5-hour limit the read carries consent
 * at once, and below it a Computer that still answers `consent_required` (the
 * card's usage was stale) gets one more read with consent.
 */
export function ClaudeLimitResetsDialog({
  serverId,
  machineId,
  atFiveHourLimit,
  canUse = true,
  client,
  onUse,
  onNote,
  onNotSupported,
  onClose,
}: {
  serverId: string;
  machineId: string;
  /** The card's usage shows the account at its 5-hour limit: the read carries consent (or, for a viewer who cannot give it, none is sent). */
  atFiveHourLimit: boolean;
  /**
   * The viewer may use a reset and consent to the read that may spend the
   * 5-hour one (`claudeLimitResetAccess.canUse`). False: the list is read-only.
   */
  canUse?: boolean;
  client: RuntimeAuthClient;
  /** Confirm this kind (the one usable kind, or the one chosen). */
  /** `atLimit`: the card's usage, or a read the Computer would only run with consent, put the account at its 5-hour limit. */
  onUse: (status: ClaudeLimitResetAvailable, atLimit: boolean) => void;
  /** The read ended with a line for the card; `usageChanged`: it used the older program's 5-hour reset. */
  onNote: (note: string, usageChanged: boolean) => void;
  /** The Computer cannot run Claude limit resets at all (macOS): the card stops offering them. */
  onNotSupported?: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const [state, setState] = useState<ReadState>(() => (!atFiveHourLimit || canUse
    ? { phase: "reading", consent: atFiveHourLimit }
    : { phase: "failed", message: formatMessage({ id: "machine.runtimeUsage.limitReset.forbidden" }) }));
  const [selected, setSelected] = useState<RuntimeLimitResetKind | null>(null);
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => { liveRef.current = false; };
  }, []);

  const read = useCallback(async (firstConsent: boolean) => {
    let consent = firstConsent;
    let result: RuntimeLimitResetsReadResult;
    try {
      result = await client.readLimitResets(serverId, machineId, consent);
      if (result.kind === "unsupported" && result.reason === "consent_required" && !consent && canUse && liveRef.current) {
        // The account reached the limit after the card's usage was read: read again, with consent, unasked.
        consent = true;
        result = await client.readLimitResets(serverId, machineId, consent);
      }
    } catch (error) {
      if (!liveRef.current) return;
      setState({
        phase: "failed",
        message: limitResetRequestOutcomeUnknown(error)
          ? formatMessage({ id: canUse ? "machine.runtimeUsage.claudeReset.readTimeout" : "machine.runtimeUsage.claudeReset.readTimeoutViewOnly" })
          : formatMessage({ id: limitResetRequestErrorMessageId(error) }, { runtime: "Claude Code" }),
      });
      return;
    }
    if (!liveRef.current) return;
    switch (result.kind) {
      case "read": {
        // A read that used the 5-hour reset is said the same to anyone; otherwise a viewer who cannot use them gets the plain list.
        if (!canUse && !result.fiveHourSpent) {
          setState({ phase: "read", result });
          return;
        }
        // A read that needed consent (the card's usage was stale) found the account at the limit.
        const atLimit = atFiveHourLimit || consent;
        const next = claudeLimitResetReadStep(result, atLimit);
        if (next.step === "note") onNote(formatMessage({ id: next.messageId }), next.usageChanged);
        else if (next.step === "confirm") onUse(next.status, atLimit);
        else {
          // Nothing chosen for the person: Use stays off until they pick a kind.
          setSelected(null);
          setState({ phase: "choose", usable: next.usable, atLimit });
        }
        return;
      }
      case "unsupported":
        if (result.reason === "consent_required" && !consent) {
          // Someone who cannot give it is not asked: nothing more is sent.
          setState({ phase: "failed", message: formatMessage({ id: "machine.runtimeUsage.limitReset.forbidden" }) });
          return;
        }
        if (claudeLimitResetsNotSupportedHere(result)) {
          onNotSupported?.();
          setState({ phase: "failed", message: formatMessage({ id: claudeLimitResetsNotSupportedMessageId(result) }) });
          return;
        }
        setState({
          phase: "failed",
          // Claude Code's first-run setup is unfinished on the Computer: said the same to anyone who can read.
          message: result.reason === "onboarding_required"
            ? formatMessage({ id: "machine.runtimeUsage.claudeReset.onboardingRequired" })
            : result.reason === "not_attempted"
              ? formatMessage({ id: canUse ? "machine.runtimeUsage.claudeReset.readNotAttempted" : "machine.runtimeUsage.claudeReset.readFailedViewOnly" })
              : result.reason === "not_installed"
                ? formatMessage({ id: "machine.runtimeAuth.error.notInstalled" }, { runtime: "Claude Code" })
                : formatMessage({ id: "machine.runtimeUsage.limitReset.unsupported" }, { runtime: "Claude Code" }),
        });
        return;
      case "reauth_required":
        setState({ phase: "failed", message: formatMessage({ id: "machine.runtimeUsage.limitReset.reauth" }, { runtime: "Claude Code" }) });
        return;
      default:
        setState({ phase: "failed", message: formatMessage({ id: canUse ? "machine.runtimeUsage.claudeReset.readFailed" : "machine.runtimeUsage.claudeReset.readFailedViewOnly" }) });
    }
  }, [atFiveHourLimit, canUse, client, formatMessage, machineId, onNote, onNotSupported, onUse, serverId]);

  // One read, on open.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || state.phase !== "reading") return;
    startedRef.current = true;
    void read(state.consent);
  }, [read, state]);

  const usable = state.phase === "choose" ? state.usable : null;
  const choices = useMemo<ChoiceListItem[]>(() => (usable ?? []).map((reset) => ({
    value: reset.kind,
    label: formatMessage({ id: "machine.runtimeUsage.claudeReset.useKind" }, { kind: claudeKindName(formatMessage, reset.kind) }),
    meta: claudeKindMeta(formatMessage, reset, "until"),
  })), [formatMessage, usable]);
  const useSelected = useCallback(() => {
    const chosen = usable?.find((reset) => reset.kind === selected);
    if (chosen && state.phase === "choose") onUse(chosen, state.atLimit);
  }, [onUse, selected, state, usable]);
  const choose = useCallback((value: string) => setSelected(value as RuntimeLimitResetKind), []);

  // Read-only: every kind as Claude Code showed it.
  const listed = state.phase === "read" ? state.result : null;
  const legacy = listed?.program === "legacy";
  const rows = listed && !legacy
    ? listed.resets.map((reset) => ({ kind: reset.kind, label: claudeKindName(formatMessage, reset.kind), meta: claudeKindMeta(formatMessage, reset) }))
    : [];

  const reading = state.phase === "reading";
  const title = formatMessage({ id: usable ? "machine.runtimeUsage.claudeReset.chooseTitle" : "machine.runtimeUsage.claudeReset.dialogTitle" });
  const listLabel = formatMessage({ id: "machine.runtimeUsage.claudeReset.listLabel" });
  return (
    <ConfirmDialog
      title={title}
      plainMessage
      size="md"
      // Read-only: nothing to use, so Close is the one action.
      closeOnConfirm={!canUse}
      confirmVariant={canUse ? "primary" : "outline"}
      confirmDisabled={canUse && !usable?.some((reset) => reset.kind === selected)}
      hideCancel={!canUse}
      confirmLabel={formatMessage({ id: canUse ? "machine.runtimeUsage.claudeReset.useSelectedAction" : "common.close" })}
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
          {legacy && (
            <p className="text-subhead text-foreground-muted" data-testid="claude-limit-resets-legacy">
              {formatMessage({ id: "machine.runtimeUsage.claudeReset.legacyViewOnly" })}
            </p>
          )}
          {rows.length > 0 && (
            // Display-only rows: a radio list with nothing to do with the choice would be a dead end.
            <ListRowGroup role="list" aria-label={listLabel} data-testid="claude-limit-resets-read-only">
              {rows.map((row) => (
                <ListRow key={row.kind} variant="plain" interactive={false} role="listitem">
                  <ListRowBody>
                    <ListRowTitle>{row.label}</ListRowTitle>
                    <ListRowDescription>{row.meta}</ListRowDescription>
                  </ListRowBody>
                </ListRow>
              ))}
            </ListRowGroup>
          )}
          {choices.length > 0 && (
            <ChoiceList
              items={choices}
              value={selected}
              onValueChange={choose}
              aria-label={listLabel}
              searchLabel={listLabel}
              clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
            />
          )}
        </div>
      )}
    />
  );
}
