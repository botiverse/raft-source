import { useCallback, useEffect, useRef } from "react";
import { useIntl } from "react-intl";
import { TriangleAlert } from "lucide-react";
import { Banner, BannerAction, BannerDescription, BannerTitle, Button } from "@botiverse/raft-ui";
import type { KeyboardPlatform } from "@botiverse/raft-ui/wip";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";
import { formatShortcut } from "../../utils/keyboardShortcuts";
import { resolvedCombos, useShortcutOverrides } from "../shortcuts/overrides";
import { getShortcutCommand } from "../shortcuts/registry";
import { ShortcutKeysView } from "./ShortcutKeysView";
import type { ShortcutEditing } from "./useShortcutEditor";

/**
 * The change held because its keys are taken: raft-ui's `sm` warning Banner attached under the row (raft-design
 * banner.md, "Attached to a list row"; kbd-button's shortcuts-panel composition). Its title names every command that
 * has the keys (up to three, else two "and N more"), its description what Swap and Replace would do (Swap only for one
 * command it can't make a new clash for); BannerAction holds Cancel first (ghost), then Swap and Replace (outlined).
 * A desktop menu's keys, or a command that can't be changed, get Cancel alone. The wrapper bleeds 8px each side so
 * the banner is as wide as the row's highlight, 2px under it (a Banner takes no horizontal margin of its own). It
 * takes the focus (its Cancel) when it opens, so the keyboard reaches its actions.
 */
export function ShortcutConflictBanner({
  editing,
  platform,
  onCancel,
  onResolve,
}: {
  editing: Extract<ShortcutEditing, { phase: "conflict" }>;
  platform: KeyboardPlatform;
  onCancel: () => void;
  onResolve: (how: "replace" | "swap") => void;
}) {
  const { formatMessage, formatList } = useIntl();
  const overrides = useShortcutOverrides();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus({ preventScroll: true });
  }, []);
  const swap = useCallback(() => onResolve("swap"), [onResolve]);
  const replace = useCallback(() => onResolve("replace"), [onResolve]);
  const { problem } = editing;
  const names = (problem.kind === "conflict" ? problem.others : [problem.other]).map((command) => formatMessage({ id: command.label }));
  const many = names.length > 1;
  const keys = <ShortcutKeysView keys={editing.combos} platform={platform} size="sm" />;
  const message = problem.kind === "desktop" ? "keyboardShortcuts.edit.conflictDesktop"
    : problem.kind === "locked" ? "keyboardShortcuts.edit.conflictLocked"
      : many ? "keyboardShortcuts.edit.conflictMany" : "keyboardShortcuts.edit.conflict";
  // Every command that has the keys: all of them up to three, else the first two "and N more".
  const shown = names.length > 3 ? names.slice(0, 2) : names;
  const listed = shown.map((name) => formatMessage({ id: "keyboardShortcuts.edit.commandName" }, { name }));
  if (names.length > 3) listed.push(formatMessage({ id: "keyboardShortcuts.edit.andMore" }, { count: names.length - 2 }));
  const canResolve = problem.kind === "conflict";
  const canSwap = problem.kind === "conflict" && problem.canSwap;
  const before: readonly ShortcutCombo[] = canSwap ? resolvedCombos(getShortcutCommand(editing.id), platform, overrides) : [];
  const beforeText = before.map((combo) => formatShortcut(combo, undefined, formatMessage)).join(" / ");
  return (
    <div className="-mx-2 my-0.5">
      <Banner status="warning" size="sm" data-testid="shortcut-conflict-notice">
        <TriangleAlert aria-hidden="true" />
        <BannerTitle>
          {formatMessage({ id: message }, { keys, command: names[0], commands: formatList(listed, { type: "conjunction" }) })}
        </BannerTitle>
        {canResolve ? (
          <BannerDescription>
            {canSwap
              ? formatMessage({ id: "keyboardShortcuts.edit.conflictSwapReplace" }, { keys: beforeText })
              : formatMessage({ id: many ? "keyboardShortcuts.edit.conflictReplaceOnlyMany" : "keyboardShortcuts.edit.conflictReplaceOnly" })}
          </BannerDescription>
        ) : null}
        <BannerAction>
          <Button ref={cancelRef} type="button" variant="ghost" size="md" onClick={onCancel} data-testid="shortcut-conflict-cancel">
            {formatMessage({ id: "keyboardShortcuts.edit.cancel" })}
          </Button>
          {canSwap ? (
            <Button type="button" variant="default" size="md" onClick={swap} data-testid="shortcut-conflict-swap">
              {formatMessage({ id: "keyboardShortcuts.edit.swap" })}
            </Button>
          ) : null}
          {canResolve ? (
            <Button type="button" variant="default" size="md" onClick={replace} data-testid="shortcut-conflict-replace">
              {formatMessage({ id: "keyboardShortcuts.edit.replace" })}
            </Button>
          ) : null}
        </BannerAction>
      </Banner>
    </div>
  );
}
