/**
 * Computer owner v1 (#wg-rbac:#32): the Computer page's Owner row. Shows who
 * Raft records as the owner, or Public (no owner), with what the viewer may
 * do about it (the server's rule, computerOwnerService.ts):
 * - Transfer owner for the current owner and a server owner/admin
 *   (`editMachines`): TransferComputerOwnerDialog;
 * - Make it mine for whoever connected a Public Computer (the attacher of a
 *   managed Computer, the machine row's registrant for a raw daemon).
 * The owner has no other rights in v1.
 */
import { Button } from "@botiverse/raft-ui";
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";

import AvatarSlot from "../../components/ui/AvatarSlot";
import KeyValueRow from "../../components/ui/KeyValueRow";
import { showToast } from "../../components/toastBridge";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAuthStore } from "../../store/authStore";
import { useMachineStore } from "../../store/machineStore";
import type { Machine } from "../../store/machineStore";
import type { useProfileStore } from "../../store/profileStore";
import { useServerStore } from "../../store/serverStore";
import { TransferComputerOwnerDialog } from "./TransferComputerOwnerDialog";

/** Who connected it, by the server's rule: the attacher of a managed Computer, else the row's registrant. */
function isConnector(machine: Machine, userId: string | null): boolean {
  if (!userId) return false;
  return machine.isComputer ? machine.computerAttachedByCurrentUser === true : machine.userId === userId;
}

export function ComputerOwnerField({ machine, openProfile }: {
  machine: Machine;
  openProfile: ReturnType<typeof useProfileStore.getState>["openProfile"];
}) {
  const { formatMessage } = useIntl();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const { capabilities } = useServerPermissions();
  const members = useServerStore((s) => s.members);
  const setMachineOwner = useMachineStore((s) => s.setMachineOwner);
  const [transferOpen, setTransferOpen] = useState(false);
  const [claiming, setClaiming] = useState(false);

  const ownerUserId = machine.ownerUserId ?? null;
  const owner = ownerUserId ? machine.owner ?? null : null;
  const canTransfer = capabilities.editMachines || (currentUserId !== null && ownerUserId === currentUserId);
  const canClaim = ownerUserId === null && isConnector(machine, currentUserId);

  const openTransfer = useCallback(() => setTransferOpen(true), []);
  const closeTransfer = useCallback(() => setTransferOpen(false), []);
  const transfer = useCallback(async (next: string | null) => {
    await setMachineOwner(machine.id, next);
    setTransferOpen(false);
  }, [machine.id, setMachineOwner]);
  const showOwner = useCallback(() => {
    if (owner) openProfile("human", owner.id);
  }, [openProfile, owner]);
  const claim = useCallback(async () => {
    if (!currentUserId) return;
    setClaiming(true);
    try {
      await setMachineOwner(machine.id, currentUserId);
    } catch {
      showToast({ title: formatMessage({ id: "machine.owner.makeMineFailed" }), type: "error" });
    } finally {
      setClaiming(false);
    }
  }, [currentUserId, formatMessage, machine.id, setMachineOwner]);
  const handleClaim = useCallback(() => void claim(), [claim]);

  return (
    <KeyValueRow
      label={formatMessage({ id: "machine.owner.label" })}
      valueClassName="flex flex-wrap items-center gap-2"
      value={(
        <>
          {owner ? (
            <button
              type="button"
              onClick={showOwner}
              className="-mx-1.5 flex min-w-0 items-center gap-1.5 rounded-chip px-1.5 py-0.5 text-callout text-foreground outline-none hover:bg-fill-medium focus-visible:shadow-focus"
              data-testid="computer-owner"
            >
              <AvatarSlot context="creator-link" type="human" humanAvatarUrl={owner.avatarUrl} />
              <span className="truncate font-semibold">{owner.displayName || owner.name}</span>
              <span className="font-mono text-mono-meta text-foreground-hint">
                {formatMessage({ id: "common.handle" }, { name: owner.name })}
              </span>
            </button>
          ) : (
            <span className="text-foreground-hint" data-testid="computer-owner-public">
              {formatMessage({ id: "machine.owner.public" })}
            </span>
          )}
          {canTransfer ? (
            <Button size="md" variant="default" onClick={openTransfer} data-testid="computer-owner-transfer">
              {formatMessage({ id: "machine.owner.transferButton" })}
            </Button>
          ) : null}
          {canClaim ? (
            <Button size="md" variant="default" loading={claiming} onClick={handleClaim} data-testid="computer-owner-make-mine">
              {formatMessage({ id: "machine.owner.makeMineButton" })}
            </Button>
          ) : null}
          {transferOpen ? (
            <TransferComputerOwnerDialog
              computerName={machine.name}
              ownerUserId={ownerUserId}
              currentUserId={currentUserId}
              members={members}
              onTransfer={transfer}
              onClose={closeTransfer}
            />
          ) : null}
        </>
      )}
    />
  );
}
