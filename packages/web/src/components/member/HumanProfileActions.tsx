import { Button, Separator } from "@botiverse/raft-ui";
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Trash2, UserPlus } from "lucide-react";
import ConfirmDialog from "../ConfirmDialog";
import SectionEyebrow from "../ui/SectionEyebrow";
import { MemberRemovalImpactNote } from "./MemberRemovalImpactNote";
import { useMemberRemovalImpact } from "./useMemberRemovalImpact";

/**
 * The Actions section of a person's profile (HumanDetailPanel): Promote to
 * Server Member for a Guest (design D2, above Remove), then Remove Member,
 * each behind its confirmation. The panel decides who sees which.
 */
export function HumanProfileActions({
  serverId,
  memberId,
  personName,
  serverName,
  canPromote,
  canRemove,
  promoting,
  onPromote,
  onRemove,
}: {
  serverId: string | undefined;
  /** The person's user id: the remove confirmation reads what removing them takes offline. */
  memberId: string;
  personName: string;
  serverName: string;
  canPromote: boolean;
  canRemove: boolean;
  /** The role change is in flight (the panel's own role save). */
  promoting: boolean;
  /** Guest → member, the same role change as the Role picker; the server checks the seat. */
  onPromote: () => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const [confirming, setConfirming] = useState<"promote" | "remove" | null>(null);
  const [removing, setRemoving] = useState(false);
  const openPromote = useCallback(() => setConfirming("promote"), []);
  const openRemove = useCallback(() => setConfirming("remove"), []);
  const close = useCallback(() => {
    if (!promoting && !removing) setConfirming(null);
  }, [promoting, removing]);
  const confirmPromote = useCallback(async () => {
    await onPromote();
    setConfirming(null);
  }, [onPromote]);
  const confirmRemove = useCallback(async () => {
    setRemoving(true);
    try {
      await onRemove();
    } finally {
      setRemoving(false);
    }
  }, [onRemove]);

  if (!canPromote && !canRemove) return null;
  return (
    <>
      <Separator />
      <div className="px-(--surface-inset) py-4">
        <SectionEyebrow as="div" className="mb-3">
          {formatMessage({ id: "member.detail.actions" })}
        </SectionEyebrow>
        <div className="stack-y-2">
          {canPromote && (
            <Button size="lg" variant="default" onClick={openPromote} disabled={promoting} className="w-full" data-testid="human-promote-guest">
              <UserPlus size={18} aria-hidden="true" />
              {formatMessage({ id: "member.detail.promoteToMember" })}
            </Button>
          )}
          {canRemove && (
            <Button size="lg" variant="danger" onClick={openRemove} className="w-full">
              <Trash2 size={18} aria-hidden="true" />
              {formatMessage({ id: "member.detail.removeMember" })}
            </Button>
          )}
        </div>
      </div>
      {confirming === "promote" && (
        <ConfirmDialog
          title={formatMessage({ id: "member.detail.promoteTitle" }, { name: personName, server: serverName })}
          message={formatMessage({ id: "member.detail.promoteMessage" }, { server: serverName })}
          confirmLabel={formatMessage({ id: "member.detail.promoteConfirm" })}
          loadingLabel={formatMessage({ id: "member.detail.promoting" })}
          confirmVariant="accent"
          chromeLocale="active"
          onConfirm={confirmPromote}
          onClose={close}
          confirmTestId="human-promote-guest-confirm"
        />
      )}
      {confirming === "remove" && (
        <RemoveMemberConfirmDialog
          serverId={serverId}
          memberId={memberId}
          personName={personName}
          onConfirm={confirmRemove}
          onClose={close}
        />
      )}
    </>
  );
}

/**
 * Remove member: its danger banner also says which of the person's Computers
 * go offline (#13527), read when it opens. The confirm waits for that read,
 * which gives up after a few seconds, and stays available when it fails.
 */
function RemoveMemberConfirmDialog({
  serverId,
  memberId,
  personName,
  onConfirm,
  onClose,
}: {
  serverId: string | undefined;
  memberId: string;
  personName: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const impact = useMemberRemovalImpact(serverId, memberId);
  return (
    <ConfirmDialog
      title={formatMessage({ id: "member.detail.removeMember" })}
      message={(
        <>
          {formatMessage({ id: "member.detail.removeMemberConfirmMessage" }, { name: personName })}
          <MemberRemovalImpactNote state={impact} memberName={personName} />
        </>
      )}
      confirmLabel={formatMessage({ id: "member.detail.removeAction" })}
      loadingLabel={formatMessage({ id: "member.detail.removing" })}
      confirmDisabled={impact.kind === "loading"}
      confirmTestId="human-remove-member-confirm"
      chromeLocale="active"
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
