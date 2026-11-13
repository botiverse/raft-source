import { useIntl } from "react-intl";
import { ArrowRight } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
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
 * Reset all (Artea's mock, frame 5): the DS AlertDialog (400px) listing what goes back, now → default, so nothing
 * is a surprise. Its confirm is orange (warning): a reset interrupts but can be redone by hand; red is for what
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
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="shortcut-reset-all-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{formatMessage({ id: "keyboardShortcuts.edit.resetAllTitle" })}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogBody>
          <AlertDialogDescription>{formatMessage({ id: "keyboardShortcuts.edit.resetAllBody" }, { count: items.length })}</AlertDialogDescription>
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
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel size="lg">{formatMessage({ id: "keyboardShortcuts.edit.cancel" })}</AlertDialogCancel>
          <AlertDialogAction variant="warning" size="lg" onClick={onConfirm} data-testid="shortcut-reset-all-confirm">
            {formatMessage({ id: "keyboardShortcuts.edit.resetAllConfirm" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
