import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { useIntl } from "react-intl";
import {
  Badge,
  Button,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemLeading,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "@botiverse/raft-ui";
import { ComboboxSelect } from "@botiverse/raft-ui/wip";
import { useServerStore } from "../../store/serverStore";
import type { ServerMember } from "../../store/serverStore";
import AvatarSlot from "../ui/AvatarSlot";
import Banner from "../ui/Banner";

/** Raft DS Select is for one of up to 10 values; past that, the searchable ComboboxSelect. */
const SELECT_MAX_OPTIONS = 10;

export function ownerName(owner: Pick<ServerMember, "displayName" | "name">): string {
  return owner.displayName || owner.name;
}

/** The server's owners, its creator first. */
export function serverOwners(members: ServerMember[], creatorId: string | undefined): ServerMember[] {
  return members
    .filter((member) => member.role === "owner")
    .sort((left, right) => {
      if (left.userId === creatorId) return -1;
      if (right.userId === creatorId) return 1;
      return ownerName(left).localeCompare(ownerName(right));
    });
}

/**
 * The owner a request goes to: the server's owners (loaded if they aren't
 * yet), the one picked, and the creator by default. Shared by the upgrade
 * dialog's and the add-seats dialog's "ask an owner".
 *
 * `rosterHidden`: the server hides its people from this viewer (a member, with
 * hideHumansFromMembers on, as the sidebar's Members list reads it). Their
 * member list holds only themselves, so there is no owner to pick: a request
 * card goes without one and the server picks the owner.
 */
export function useOwnerRecipient() {
  const server = useServerStore((state) => state.current);
  const members = useServerStore((state) => state.members);
  const membersLoadError = useServerStore((state) => state.membersLoadError);
  const loadMembers = useServerStore((state) => state.loadMembers);
  const rosterHidden = server?.role === "member" && server.hideHumansFromMembers === true;
  const owners = useMemo(() => serverOwners(members, server?.ownerId), [members, server?.ownerId]);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  useEffect(() => {
    if (members.length === 0) void loadMembers();
  }, [members.length, loadMembers]);
  const retry = useCallback(() => {
    void loadMembers();
  }, [loadMembers]);
  const recipient = owners.find((owner) => owner.userId === ownerId) ?? owners[0];
  return { owners, recipient, setOwnerId, creatorId: server?.ownerId, loadFailed: Boolean(membersLoadError), retry, rosterHidden };
}

/**
 * The owner a request card names: the one picked, or null when the server
 * picks (rosterHidden); undefined while there is no one to send it to yet.
 */
export function requestCardOwner(state: ReturnType<typeof useOwnerRecipient>): ServerMember | null | undefined {
  return state.rosterHidden ? null : state.recipient;
}

/**
 * Who the request goes to: a picker when the server has several owners (a
 * Select up to 10, searchable past that), the one owner otherwise, and the
 * loading and retry states while the list comes in.
 */
export function OwnerPicker({
  state,
  disabled,
  testIdPrefix,
}: {
  state: ReturnType<typeof useOwnerRecipient>;
  disabled: boolean;
  testIdPrefix: string;
}) {
  const { formatMessage } = useIntl();
  const { owners, recipient, setOwnerId, creatorId, loadFailed, retry } = state;
  // The field shows the name; the list adds the avatar and, for the creator, a quieter "Creator".
  const ownerOptions = useMemo(() => owners.map((owner) => ({ value: owner.userId, label: ownerName(owner) })), [owners]);
  const renderOwnerOption = useCallback((option: { value: string | number; label: string }) => {
    const owner = owners.find((candidate) => candidate.userId === option.value);
    return owner ? <OwnerOption owner={owner} creator={owner.userId === creatorId} /> : option.label;
  }, [owners, creatorId]);
  const handleOwnerChange = useCallback((value: unknown) => {
    if (typeof value === "string") setOwnerId(value);
  }, [setOwnerId]);
  // With the owner list closed, Esc belongs to the dialog: the combobox would
  // otherwise clear the chosen owner and swallow the key (Kirby, #10681).
  const [ownerListOpen, setOwnerListOpen] = useState(false);
  const handleOwnerKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement> & { preventBaseUIHandler?: () => void }) => {
    if (event.key === "Escape" && !ownerListOpen) event.preventBaseUIHandler?.();
  }, [ownerListOpen]);
  const ownerInputProps = useMemo(() => ({ onKeyDown: handleOwnerKeyDown }), [handleOwnerKeyDown]);

  if (owners.length > 1) {
    return (
      <Field data-testid={`${testIdPrefix}-owner-picker`}>
        <FieldLabel id={`${testIdPrefix}-owner-label`}>
          {formatMessage({ id: "upgradeDialog.ownerPicker" }, { count: owners.length })}
        </FieldLabel>
        {owners.length > SELECT_MAX_OPTIONS ? (
          <ComboboxSelect
            aria-labelledby={`${testIdPrefix}-owner-label`}
            options={ownerOptions}
            value={recipient?.userId ?? null}
            onValueChange={handleOwnerChange}
            renderOption={renderOwnerOption}
            onOpenChange={setOwnerListOpen}
            inputProps={ownerInputProps}
            disabled={disabled}
            emptyContent={formatMessage({ id: "ui.selectionPopover.emptyLabel" })}
            showArrow
            autoHighlight
          />
        ) : (
          <Select value={recipient?.userId ?? null} onValueChange={handleOwnerChange} items={ownerOptions} disabled={disabled}>
            <SelectTrigger className="w-full min-w-0" aria-labelledby={`${testIdPrefix}-owner-label`}>
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                {owners.map((owner) => (
                  <SelectItem key={owner.userId} value={owner.userId}>
                    <SelectItemLeading>
                      <AvatarSlot context="compact-list" type="human" humanAvatarUrl={owner.avatarUrl} />
                    </SelectItemLeading>
                    <SelectItemText>{ownerName(owner)}</SelectItemText>
                    {owner.userId === creatorId ? (
                      <span className="text-foreground-hint">{formatMessage({ id: "upgradeDialog.creator" })}</span>
                    ) : null}
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
        )}
      </Field>
    );
  }
  if (recipient) {
    return (
      <div className="flex items-center gap-2.5" data-testid={`${testIdPrefix}-owner`}>
        <AvatarSlot context="list-row" type="human" humanAvatarUrl={recipient.avatarUrl} />
        <span className="text-subhead font-bold text-foreground">{ownerName(recipient)}</span>
        <Badge appearance="outline">{formatMessage({ id: "upgradeDialog.ownerBadge" })}</Badge>
      </div>
    );
  }
  if (loadFailed) {
    return (
      <Banner
        intent="warning"
        density="sm"
        data-testid={`${testIdPrefix}-owners-failed`}
        actions={(
          <Button type="button" variant="default" size="md" onClick={retry}>
            {formatMessage({ id: "upgradeDialog.retry" })}
          </Button>
        )}
      >
        {formatMessage({ id: "upgradeDialog.ownersFailed" })}
      </Banner>
    );
  }
  return (
    <p className="text-footnote text-foreground-muted" data-testid={`${testIdPrefix}-owners-loading`}>
      {formatMessage({ id: "upgradeDialog.ownersLoading" })}
    </p>
  );
}

/** An owner in the searchable list: avatar, name, and a quieter "Creator" for the server's creator. */
function OwnerOption({ owner, creator }: { owner: ServerMember; creator: boolean }) {
  const { formatMessage } = useIntl();
  return (
    <span className="flex min-w-0 items-center gap-2">
      <AvatarSlot context="compact-list" type="human" humanAvatarUrl={owner.avatarUrl} />
      <span className="min-w-0 truncate">{ownerName(owner)}</span>
      {creator ? <span className="shrink-0 text-foreground-hint">{formatMessage({ id: "upgradeDialog.creator" })}</span> : null}
    </span>
  );
}
