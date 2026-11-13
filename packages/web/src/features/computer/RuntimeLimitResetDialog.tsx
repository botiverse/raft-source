import { getRuntimeDisplayName } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageProvider, RuntimeAccountUsageSnapshot, RuntimeLimitResetIdempotencyKey, RuntimeLimitResetResult } from "@botiverse/raft-shared";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import ConfirmDialog from "../../components/ConfirmDialog";
import { limitResetFailureMessageId, limitResetRequestErrorMessageId } from "./limitResetOutcome";
import type { RuntimeLimitResetOutcome } from "./limitResetOutcome";

/**
 * Confirms spending one of the account's limit resets, naming the account
 * whose reset it is. The idempotency key comes from the card: one per
 * attempt, the same one again when the person retries an attempt whose
 * outcome was never learned.
 */
export function RuntimeLimitResetDialog({
  serverId,
  machineId,
  runtimeId,
  provider,
  account,
  resetsAvailable,
  idempotencyKey,
  client,
  onOutcome,
  onClose,
}: {
  serverId: string;
  machineId: string;
  runtimeId: string;
  provider: RuntimeAccountUsageProvider;
  /** The account's (masked) email or name, as the card shows it; null when it has none. */
  account: string | null;
  resetsAvailable: number;
  idempotencyKey: RuntimeLimitResetIdempotencyKey;
  client: RuntimeAuthClient;
  onOutcome: (outcome: RuntimeLimitResetOutcome) => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const runtimeName = getRuntimeDisplayName(runtimeId);

  const handleConfirm = useCallback(async () => {
    let reply: { result: RuntimeLimitResetResult; snapshot: RuntimeAccountUsageSnapshot | null };
    try {
      reply = await client.redeemLimitReset(serverId, machineId, provider, idempotencyKey);
    } catch (error) {
      onOutcome({ result: null, snapshot: null });
      throw new Error(formatMessage({ id: limitResetRequestErrorMessageId(error) }, { runtime: runtimeName }));
    }
    onOutcome(reply);
    const failure = limitResetFailureMessageId(reply.result);
    if (failure) throw new Error(formatMessage({ id: failure }, { runtime: runtimeName }));
  }, [client, formatMessage, idempotencyKey, machineId, onOutcome, provider, runtimeName, serverId]);

  const accountLabel = account ?? formatMessage({ id: "machine.runtimeUsage.limitReset.accountFallback" });
  return (
    <ConfirmDialog
      title={formatMessage({ id: "machine.runtimeUsage.limitReset.title" })}
      plainMessage
      message={(
        <p className="text-subhead text-foreground-muted" data-testid="runtime-limit-reset-dialog">
          {formatMessage(
            { id: "machine.runtimeUsage.limitReset.description" },
            {
              account: <span key="account" className="font-semibold text-foreground" data-testid="runtime-limit-reset-account">{accountLabel}</span>,
              runtime: runtimeName,
              count: resetsAvailable,
            },
          )}
        </p>
      )}
      confirmLabel={formatMessage({ id: "machine.runtimeUsage.limitReset.confirm" })}
      confirmVariant="primary"
      layer={1}
      maxWidthClass="max-w-md"
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}
