import { useIntl } from "react-intl";
import { ArrowRight } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@botiverse/raft-ui";
import type { KeyboardPlatform } from "@botiverse/raft-ui/wip";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";
import { ShortcutKeysView } from "./ShortcutKeysView";

export interface ShortcutResetItem {
  id: string;
  label: string;
  now: readonly ShortcutCombo[];
  defaults: readonly ShortcutCombo[];
}

/**
 * Reset all (Artea's mock, frame 5): a DS Dialog at size sm (400px; AlertDialog is only for the confirmations Raft
 * Chat lists) listing what goes back, now → default, so nothing is a surprise. Its confirm is orange (warning): a
 * reset interrupts but can be redone by hand; red is for what
 * can't be undone.
 */
export function ShortcutResetAllDialog({
  open,
  onOpenChange,
  items,
  platform,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly ShortcutResetItem[];
  platform: KeyboardPlatform;
  onConfirm: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" data-testid="shortcut-reset-all-dialog">
        <DialogHeader>
          <DialogTitle>{formatMessage({ id: "keyboardShortcuts.edit.resetAllTitle" })}</DialogTitle>
          <DialogClose aria-label={formatMessage({ id: "common.confirm.closeDialog" })} />
        </DialogHeader>
        <DialogBody>
          <DialogDescription>{formatMessage({ id: "keyboardShortcuts.edit.resetAllBody" }, { count: items.length })}</DialogDescription>
          <ul className="mt-3 grid gap-2">
            {items.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3" data-shortcut-reset-item={item.id}>
                <span className="min-w-0 truncate text-callout text-foreground">{item.label}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {item.now.length > 0
                    ? <ShortcutKeysView keys={item.now} platform={platform} />
                    : <span className="text-footnote text-foreground-hint">{formatMessage({ id: "keyboardShortcuts.edit.notSet" })}</span>}
                  <ArrowRight size={14} aria-hidden="true" className="text-foreground-hint" />
                  <span className="sr-only">{formatMessage({ id: "keyboardShortcuts.rangeTo" })}</span>
                  <ShortcutKeysView keys={item.defaults} platform={platform} />
                </span>
              </li>
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="lg" />}>{formatMessage({ id: "keyboardShortcuts.edit.cancel" })}</DialogClose>
          <Button variant="warning" size="lg" onClick={onConfirm} data-testid="shortcut-reset-all-confirm">
            {formatMessage({ id: "keyboardShortcuts.edit.resetAllConfirm" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
