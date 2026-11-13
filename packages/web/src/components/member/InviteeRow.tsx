import { Button, Field, Input } from "@botiverse/raft-ui";
import { Trash2 } from "lucide-react";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { Invitee, InviteePatch } from "./InviteHumanDialog";

/**
 * One email row: the address and a remove control. Every invite grants Member
 * (a Guest is never created by a server invite, #wg-rbac:#15), so there is no
 * role control. Split out so each row binds its handlers to its own id.
 */
export function InviteeRow({
  invitee,
  index,
  fieldIdPrefix,
  canRemove,
  onUpdate,
  onRemove,
}: {
  invitee: Invitee;
  index: number;
  fieldIdPrefix: string;
  canRemove: boolean;
  onUpdate: (id: string, patch: InviteePatch) => void;
  onRemove: (id: string) => void;
}) {
  const { formatMessage } = useIntl();
  const { id } = invitee;
  const handleEmailChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => onUpdate(id, { email: event.target.value }),
    [id, onUpdate],
  );
  const handleRemove = useCallback(() => onRemove(id), [id, onRemove]);

  return (
    <div className="flex items-center gap-2">
      {/*
        * Each control gets its OWN `Field className="contents"`.
        *
        * Base UI's Field context hands every Input beneath it the
        * same control id and the same `aria-labelledby`, so a list
        * of rows would collapse into one id and every box would
        * announce the group's label. An inherited `aria-labelledby`
        * also outranks `aria-label`, so labelling them directly
        * does not help while they share a context. `contents` adds
        * no layout. (Found by @Dozy on PR #7010.)
        */}
      <Field className="contents">
        <Input
          id={`${fieldIdPrefix}-email-${id}`}
          type="email"
          aria-label={formatMessage({ id: "member.invite.emailLabel" })}
          value={invitee.email}
          onChange={handleEmailChange}
          className="min-w-0 flex-1"
          placeholder="name@company.com"
        />
      </Field>
      {/* Hidden, not disabled, at one row: removing the last row
          leaves no way back to a usable form. */}
      {canRemove && (
        // Dropping an unsent row is local and reversible: a quiet icon
        // button at the field's height, not a red one.
        <Button
          type="button"
          size="icon-lg"
          variant="ghost"
          onClick={handleRemove}
          aria-label={formatMessage({ id: "member.invite.removeInvitee" }, { index: index + 1 })}
        >
          <Trash2 size={18} aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
