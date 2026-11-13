/**
 * A server the person is the only owner of, with other members: the one thing
 * that holds up the deletion (v7). It must get another Owner first. Transfer
 * to… lists that server's people (not the person, not guests); Make Owner is
 * the member-role change Settings › Administration › Admins makes. Once it's
 * done the row turns into its outcome, marked Done, and the list reads the
 * deletion again.
 */
import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectIcon,
  SelectList,
  SelectTrigger,
  SelectValue,
  TextLink,
} from "@botiverse/raft-ui";
import { Check, CircleCheck, Crown } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Link } from "react-router-dom";

import { useAuthStore } from "../../../store/authStore";
import { renderSelectItems } from "../shared/renderSelectItems";
import type { SelectOption } from "../shared/selectOptions";
import { fetchTransferCandidates, makeServerOwner } from "./accountDeletionApi";
import type { SoleOwnerServer, TransferCandidate } from "./accountDeletionApi";
import { AccountDeletionChecklistRow, AccountDeletionRowNote } from "./AccountDeletionChecklistRow";

export function SoleOwnerTransferRow({ server, newOwnerName, onTransferred }: {
  server: SoleOwnerServer;
  /** Set once an Owner was made here: the row is done. */
  newOwnerName: string | null;
  onTransferred: (serverId: string, newOwnerName: string) => void;
}) {
  const { formatMessage } = useIntl();
  const selfUserId = useAuthStore((state) => state.user?.id ?? null);
  const [candidates, setCandidates] = useState<TransferCandidate[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const done = newOwnerName !== null;

  useEffect(() => {
    if (done) return;
    let live = true;
    fetchTransferCandidates(server.id, selfUserId).then((list) => {
      if (live) setCandidates(list);
    }, () => {
      if (live) setLoadFailed(true);
    });
    return () => { live = false; };
  }, [done, selfUserId, server.id]);

  const options = useMemo<SelectOption[]>(
    () => (candidates ?? []).map((candidate) => ({ value: candidate.userId, label: candidate.name })),
    [candidates],
  );

  const handleChoose = useCallback((value: string | null) => {
    setChosen(value);
    setFailed(false);
  }, []);

  const handleTransfer = useCallback(() => {
    const candidate = candidates?.find((entry) => entry.userId === chosen);
    if (!candidate) return;
    setBusy(true);
    setFailed(false);
    makeServerOwner(server.id, candidate.userId).then(() => {
      onTransferred(server.id, candidate.name);
    }, () => {
      setBusy(false);
      setFailed(true);
    });
  }, [candidates, chosen, onTransferred, server.id]);

  const settingsPath = `/s/${encodeURIComponent(server.slug)}/settings/server`;

  const others = Math.max(server.memberCount - 1, 1);

  return (
    <AccountDeletionChecklistRow
      icon={done ? <CircleCheck /> : <Crown />}
      tone={done ? "done" : "todo"}
      testId={`account-deletion-transfer-${server.id}`}
      name={server.name}
      detail={formatMessage({ id: done ? "accountDeletion.serverMembers" : "accountDeletion.serverMembersSoleOwner" }, { count: others })}
      outcome={done ? (
        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span>{formatMessage({ id: "accountDeletion.transferDone" }, { memberName: newOwnerName })}</span>
          <Badge appearance="soft" variant="success">
            <Check aria-hidden />
            {formatMessage({ id: "accountDeletion.transferDoneBadge" })}
          </Badge>
        </span>
      ) : formatMessage({ id: "accountDeletion.transferNeeded" })}
    >
      {done ? null : candidates !== null && candidates.length === 0 ? (
        // The sentence and its link sit side by side through the gap, not a
        // `{" "}` spacer (structural glue the literal gate counts).
        <p className="m-0 flex flex-wrap gap-x-1 text-callout text-foreground-muted">
          <span>{formatMessage({ id: "accountDeletion.transferNoMembers" })}</span>
          <TextLink variant="strong" render={<Link to={settingsPath} />}>
            {formatMessage({ id: "accountDeletion.openServerSettings" })}
          </TextLink>
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Select value={chosen} onValueChange={handleChoose} items={options} disabled={busy || candidates === null}>
            <SelectTrigger
              className="min-w-0 flex-1 basis-0 sm:max-w-60 sm:basis-40"
              aria-label={formatMessage({ id: "accountDeletion.transferLabel" }, { serverName: server.name })}
              data-testid={`account-deletion-transfer-select-${server.id}`}
            >
              <SelectValue placeholder={formatMessage({ id: "accountDeletion.transferPlaceholder" })} />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>{renderSelectItems(options)}</SelectList>
            </SelectContent>
          </Select>
          {/* lg: beside a field, a button takes the field's height (44px on a phone). */}
          <Button
            type="button"
            size="lg"
            variant="outline"
            loading={busy}
            loadingLabel={formatMessage({ id: "accountDeletion.makingOwner" })}
            disabled={!chosen || busy}
            onClick={handleTransfer}
          >
            {formatMessage({ id: "accountDeletion.transferConfirm" })}
          </Button>
        </div>
      )}
      {loadFailed ? <AccountDeletionRowNote><span className="text-danger">{formatMessage({ id: "accountDeletion.transferLoadFailed" })}</span></AccountDeletionRowNote> : null}
      {failed ? <AccountDeletionRowNote><span className="text-danger" role="alert">{formatMessage({ id: "accountDeletion.transferFailed" })}</span></AccountDeletionRowNote> : null}
    </AccountDeletionChecklistRow>
  );
}
