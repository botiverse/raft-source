/**
 * Computer owner v1 (#wg-rbac:#32): Transfer owner, from the Computer page's
 * Owner row (ComputerOwnerField). Opened by the current owner or a server
 * owner/admin: hand the Computer to another person in the server, or make it
 * Public (no owner). The people offered are the server's members who are not
 * Guests (agents and personal assistants are never members); the server
 * checks the same. The banner says what does not move with it (Tenny): the
 * Computer's Claude/Codex sign-ins and git credentials stay whoever is signed
 * in on the machine; only who Raft records as its owner changes.
 *
 * Raft DS: a small task Dialog (md) with a RadioGroup (a person / Public), a
 * Combobox for the person, a warning Banner, and Cancel + the verb in the
 * footer; a sheet on a phone (a pick from a searchable list).
 */
import {
  Button,
  Combobox,
  ComboboxContent,
  ComboboxControl,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  RadioGroup,
  RadioGroupItem,
} from "@botiverse/raft-ui";
import { ChevronDown } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";

import Banner from "../../components/ui/Banner";
import { DialogActions, DialogCommit, NarrowDialogContent } from "../../components/ui/NarrowDialog";
import type { ServerMember } from "../../store/serverStore";

type Choice = "person" | "public";

export function TransferComputerOwnerDialog({
  computerName,
  ownerUserId,
  currentUserId,
  members,
  onTransfer,
  onClose,
}: {
  computerName: string;
  /** The current owner; null for a Public Computer. */
  ownerUserId: string | null;
  currentUserId: string | null;
  members: readonly ServerMember[];
  /** Rejects to keep the dialog open with the failure shown; resolves to close. */
  onTransfer: (ownerUserId: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const people = useMemo(
    () => members.filter((member) => member.role !== "guest" && member.userId !== ownerUserId),
    [members, ownerUserId],
  );
  const byId = useMemo(() => new Map(people.map((member) => [member.userId, member])), [people]);
  const personIds = useMemo(() => people.map((member) => member.userId), [people]);
  const personLabel = useCallback((userId: string) => {
    const member = byId.get(userId);
    if (!member) return "";
    const name = member.displayName || member.name;
    return member.userId === currentUserId ? formatMessage({ id: "machine.owner.dialog.you" }, { name }) : name;
  }, [byId, currentUserId, formatMessage]);
  const [choice, setChoice] = useState<Choice>("person");
  const [personId, setPersonId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const controlRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const portalProps = useMemo(() => ({ container: formRef }), []);
  const ready = choice === "public" ? ownerUserId !== null : personId !== null;

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open && !saving) onClose();
  }, [onClose, saving]);
  const handleChoice = useCallback((value: unknown) => {
    if (value === "person" || value === "public") setChoice(value);
  }, []);
  const handleSubmit = useCallback(async (event?: { preventDefault(): void }) => {
    event?.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await onTransfer(choice === "public" ? null : personId);
    } catch {
      setFailed(true);
      setSaving(false);
    }
  }, [choice, onTransfer, personId, ready, saving]);
  const handleConfirm = useCallback(() => void handleSubmit(), [handleSubmit]);

  const title = formatMessage({ id: "machine.owner.dialog.title" });
  const confirmLabel = formatMessage({ id: choice === "public" ? "machine.owner.dialog.publicConfirm" : "machine.owner.dialog.transferConfirm" });
  return (
    <Dialog open disablePointerDismissal={saving} onOpenChange={handleOpenChange}>
      <NarrowDialogContent
        narrow="sheet"
        size="md"
        data-testid="transfer-computer-owner-dialog"
        title={title}
        closeLabel={formatMessage({ id: "common.close" })}
        closeDisabled={saving}
        header={(
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogClose aria-label={formatMessage({ id: "common.close" })} disabled={saving} />
          </DialogHeader>
        )}
      >
        <DialogBody className="grid gap-4 font-normal">
          <form ref={formRef} className="grid gap-4" onSubmit={handleSubmit} noValidate>
            <DialogDescription>
              {formatMessage({ id: "machine.owner.dialog.description" }, { computer: computerName })}
            </DialogDescription>
            <RadioGroup
              value={choice}
              onValueChange={handleChoice}
              aria-label={formatMessage({ id: "machine.owner.dialog.choiceLabel" })}
              className="gap-0"
            >
              {(["person", "public"] as const).map((value) => (
                <label key={value} className="flex min-h-11 items-center gap-2 py-1.5">
                  <RadioGroupItem
                    value={value}
                    disabled={value === "public" && ownerUserId === null}
                    className="shrink-0"
                    data-testid={`transfer-owner-choice-${value}`}
                  />
                  <span className="text-subhead font-semibold text-foreground">
                    {formatMessage({ id: value === "public" ? "machine.owner.dialog.choicePublic" : "machine.owner.dialog.choicePerson" })}
                  </span>
                </label>
              ))}
            </RadioGroup>
            {choice === "person" ? (
              <Field>
                <FieldLabel>{formatMessage({ id: "machine.owner.dialog.personLabel" })}</FieldLabel>
                <Combobox<string>
                  autoHighlight
                  items={personIds}
                  value={personId}
                  onValueChange={setPersonId}
                  itemToStringLabel={personLabel}
                >
                  <ComboboxControl ref={controlRef} className="w-full">
                    <ComboboxInput
                      className="text-field font-field"
                      placeholder={formatMessage({ id: "machine.owner.dialog.personPlaceholder" })}
                      data-testid="transfer-owner-person"
                      suppressPasswordManager
                    />
                    <ChevronDown aria-hidden />
                  </ComboboxControl>
                  <ComboboxContent align="start" anchor={controlRef} className="w-(--anchor-width)" portalProps={portalProps}>
                    <ComboboxList>
                      {(userId: string) => (
                        <ComboboxItem key={userId} value={userId} data-testid={`transfer-owner-person-${userId}`}>
                          <span className="truncate">{personLabel(userId)}</span>
                          <ComboboxItemIndicator />
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                    <ComboboxEmpty>{formatMessage({ id: "machine.owner.dialog.noMatch" })}</ComboboxEmpty>
                  </ComboboxContent>
                </Combobox>
              </Field>
            ) : null}
            <Banner intent="warning" withIcon density="sm" data-testid="transfer-owner-credentials">
              {formatMessage({ id: "machine.owner.dialog.credentials" })}
            </Banner>
            {failed ? (
              <Banner intent="warning" density="sm" data-testid="transfer-owner-failed">
                {formatMessage({ id: "machine.owner.dialog.failed" })}
              </Banner>
            ) : null}
          </form>
        </DialogBody>
        <DialogActions as={DialogFooter}>
          <DialogClose render={<Button size="lg" variant="ghost" />} disabled={saving}>
            {formatMessage({ id: "common.confirm.cancel" })}
          </DialogClose>
          <DialogCommit>
            {(inHead) => (
              <Button
                size={inHead ? "md" : "lg"}
                variant="primary"
                disabled={!ready}
                loading={saving}
                loadingLabel={formatMessage({ id: "machine.owner.dialog.saving" })}
                onClick={handleConfirm}
                data-testid="transfer-owner-confirm"
              >
                {confirmLabel}
              </Button>
            )}
          </DialogCommit>
        </DialogActions>
      </NarrowDialogContent>
    </Dialog>
  );
}
