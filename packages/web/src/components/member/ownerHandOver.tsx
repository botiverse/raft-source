import type { ServerRole } from "@botiverse/raft-shared";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import ConfirmDialog from "../ConfirmDialog";
import { OwnComputersTransferNote } from "./MemberRemovalImpactNote";
import type { MemberRemovalImpactState } from "./useMemberRemovalImpact";

/** The self-demotion confirmation; stepping down from owner also says what becomes of your Computers (useOwnerHandOver). */
export function SelfDemoteConfirmDialog({ roleLabel, ownImpact, onConfirm, onClose }: {
  roleLabel: string;
  /** Yours, when you step down from owner; null otherwise. */
  ownImpact: MemberRemovalImpactState | null;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <ConfirmDialog
      title={formatMessage({ id: "member.detail.selfDemoteTitle" })}
      message={(
        <>
          {formatMessage({ id: "member.detail.selfDemoteMessage" }, { role: roleLabel })}
          {ownImpact ? <OwnComputersTransferNote state={ownImpact} /> : null}
        </>
      )}
      confirmLabel={formatMessage({ id: "member.detail.selfDemoteConfirm" })}
      chromeLocale="active"
      onConfirm={onConfirm}
      onClose={onClose}
      confirmTestId="human-self-demote-confirm"
      analyticsDialog="self_demote"
    />
  );
}

/** Making `personName` an owner while you attached Computers here. Undo stays as for any role change of someone else. */
export function OwnerGrantConfirmDialog({ personName, ownImpact, undoTo, saving, applyRole, onClose }: {
  personName: string;
  ownImpact: MemberRemovalImpactState;
  undoTo: ServerRole | null;
  saving: boolean;
  applyRole: (nextRole: ServerRole, undoTo: ServerRole | null) => Promise<void>;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const confirm = useCallback(async () => {
    await applyRole("owner", undoTo);
    onClose();
  }, [applyRole, onClose, undoTo]);
  const close = useCallback(() => {
    if (!saving) onClose();
  }, [onClose, saving]);
  return (
    <ConfirmDialog
      title={formatMessage({ id: "member.detail.ownerGrantTitle" }, { name: personName })}
      message={<OwnComputersTransferNote state={ownImpact} />}
      confirmLabel={formatMessage({ id: "member.detail.ownerGrantConfirm" })}
      chromeLocale="active"
      onConfirm={confirm}
      onClose={close}
      confirmTestId="human-owner-grant-confirm"
    />
  );
}
