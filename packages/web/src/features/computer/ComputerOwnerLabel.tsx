import { useIntl } from "react-intl";

import type { Machine } from "../../store/machineStore";

/**
 * Computer owner v1 (#wg-rbac:#32): the Computers list's owner line, "Owner:
 * <name>" or "Public (no owner)". The Computer page's Owner row
 * (ComputerOwnerField) is where it changes.
 */
export function ComputerOwnerLabel({ machine, className }: { machine: Pick<Machine, "id" | "ownerUserId" | "owner">; className?: string }) {
  const { formatMessage } = useIntl();
  const owner = machine.ownerUserId ? machine.owner ?? null : null;
  return (
    <span className={className} data-testid={`rack-row-owner-${machine.id}`}>
      {owner
        ? formatMessage({ id: "machine.owner.rackLabel" }, { name: owner.displayName || owner.name })
        : formatMessage({ id: "machine.owner.public" })}
    </span>
  );
}
