import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { useIntl } from "react-intl";
import { Lock } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import { KbdButton, KbdButtonCaret, KbdButtonPlaceholder, KbdShortcut } from "@botiverse/raft-ui/wip";
import type { KeyboardPlatform } from "@botiverse/raft-ui/wip";
import Tooltip from "../../components/ui/Tooltip";
import { formatShortcut, shortcutKeyNames } from "../../utils/keyboardShortcuts";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";
import { focusLost } from "../../utils/focusGuard";
import type { BindingProblem } from "../shortcuts/conflicts";
import { RESERVED_REASON_MESSAGES } from "../shortcuts/reserved";
import type { ShortcutCommand } from "../shortcuts/registry";
import { ariaKeyShortcuts } from "../shortcuts/useShortcutBinding";
import type { ShortcutKeys, ShortcutRow } from "./keyboardShortcutList";
import { ShortcutConflictBanner } from "./ShortcutConflictBanner";
import { ShortcutKeysView } from "./ShortcutKeysView";
import type { ShortcutEditor } from "./useShortcutEditor";

const NO_COMBOS: readonly ShortcutCombo[] = [];
const ARROWS: Readonly<Record<string, string>> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };

/** Why the recorder refused a combo, in the row's second line (frame 4). */
function useRefusalText() {
  const { formatMessage } = useIntl();
  return (problem: BindingProblem, platform: KeyboardPlatform): string => {
    switch (problem.kind) {
      case "single":
        return formatMessage({ id: platform === "mac" ? "keyboardShortcuts.edit.singleMac" : "keyboardShortcuts.edit.singleOther" });
      case "pairKey":
        return formatMessage({ id: "keyboardShortcuts.edit.pairKey" }, { keys: problem.keys.map((key) => ARROWS[key] ?? key).join(" / ") });
      case "reserved":
        return formatMessage(
          { id: RESERVED_REASON_MESSAGES[problem.reason] },
          { keys: formatShortcut(problem.combo, problem.platform === "mac" ? "MacIntel" : "Win32", formatMessage) },
        );
      default:
        return "";
    }
  };
}

/**
 * One row of the panel: what it does, where it works, and its keys on the right. In the editable panel a command a
 * person may change has its keys in raft-ui's KbdButton, which turns into the recording field when pressed: the
 * modifiers held show live with a caret, a refused combo stays `invalid` (red) until the next key, and a held conflict
 * shows the new keys over ShortcutConflictBanner. A changed one has a mark before its name, its default on a third
 * line and Reset. A desktop menu's row has a lock whose tooltip says it can't be changed yet.
 * Read-only (a phone, a touch screen with no keyboard) everything is plain caps, the changes still marked.
 *
 * Hand-rolled row: raft-ui's ListRow is a target (the whole row is a button or a link); these rows are read, and only
 * their keys are pressed.
 */
export function ShortcutHelpRow({
  row,
  command,
  combos,
  defaults,
  changed,
  editable,
  platform,
  editor,
}: {
  row: ShortcutRow;
  command: ShortcutCommand;
  /** The keys in effect (the person's), for a command that can be changed; else the row's own drawing. */
  combos: readonly ShortcutCombo[] | null;
  defaults: readonly ShortcutCombo[];
  changed: boolean;
  editable: boolean;
  platform: KeyboardPlatform;
  editor: ShortcutEditor;
}) {
  const { formatMessage } = useIntl();
  const descriptionId = useId();
  const refusalText = useRefusalText();
  const label = formatMessage({ id: row.label });
  const editing = editor.editing?.id === row.id ? editor.editing : null;
  const recording = editing?.phase === "recording";
  const refused = recording ? editing.refused : null;
  const held = recording ? editing.held : null;
  const pending = editing?.phase === "conflict" ? editing.combos : null;
  const keys: readonly ShortcutKeys[] = combos ?? row.keys;
  const changeable = editable && command.rebindable;
  // Focus that the change took away (the notice's buttons, Reset, gone once used) comes back to the row's shortcut,
  // so the keyboard stays in the panel (and its Esc still closes it). A press elsewhere keeps the focus it moved.
  const bindingRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const focusAfterReset = useRef(false);
  const refocus = () => {
    if (focusLost()) bindingRef.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (editing) {
      wasEditing.current = true;
      return;
    }
    if (!wasEditing.current) return;
    wasEditing.current = false;
    refocus();
  }, [editing]);
  useEffect(() => {
    if (!focusAfterReset.current || changed) return;
    focusAfterReset.current = false;
    refocus();
  }, [changed]);
  const reset = useCallback(() => {
    focusAfterReset.current = true;
    editor.reset(row.id);
  }, [editor, row.id]);
  const start = useCallback(() => editor.start(row.id), [editor, row.id]);
  const defaultText = defaults.map((combo) => formatShortcut(combo, undefined, formatMessage)).join(" / ");
  const current = combos ?? NO_COMBOS;
  const heldKeys = useMemo(
    () => (held && (held.mod || held.ctrl || held.alt || held.shift) ? shortcutKeyNames({ ...held, key: "" }).filter(Boolean) : null),
    [held],
  );
  const refusedKeys = useMemo(() => (refused ? [refused.combo] : null), [refused]);

  const bindingContent = (() => {
    if (refusedKeys) return <ShortcutKeysView keys={refusedKeys} platform={platform} />;
    if (recording) {
      return (
        <>
          {heldKeys
            ? <KbdShortcut keys={heldKeys} size="md" platform={platform} />
            : <KbdButtonPlaceholder>{formatMessage({ id: "keyboardShortcuts.edit.recorderEmpty" })}</KbdButtonPlaceholder>}
          <KbdButtonCaret />
        </>
      );
    }
    if (pending) return <ShortcutKeysView keys={pending} platform={platform} />;
    if (current.length === 0) return <KbdButtonPlaceholder>{formatMessage({ id: "keyboardShortcuts.edit.notSet" })}</KbdButtonPlaceholder>;
    return <ShortcutKeysView keys={current} platform={platform} />;
  })();
  // One KbdButton even for a pair (⌘↑ / ⌘↓): the pair is one binding, recorded together, so it is one control
  // around both caps, not two alternatives (kbd-button.md's two-buttons rule is for alternatives).
  const binding = changeable ? (
    <KbdButton
      ref={bindingRef}
      recording={recording || !!pending}
      invalid={!!refused}
      aria-label={current.length > 0
        ? formatMessage(
          { id: "keyboardShortcuts.edit.changeLabel" },
          { command: label, keys: current.map((combo) => formatShortcut(combo, undefined, formatMessage)).join(" / ") },
        )
        : formatMessage({ id: "keyboardShortcuts.edit.changeLabelNone" }, { command: label })}
      aria-keyshortcuts={current.length > 0 ? ariaKeyShortcuts(current, platform) : undefined}
      aria-describedby={descriptionId}
      onClick={editing ? undefined : start}
      data-shortcut-binding=""
    >
      {bindingContent}
    </KbdButton>
  ) : null;

  const second = refused ? refusalText(refused.problem, platform)
    : recording || editing?.phase === "conflict" ? formatMessage({ id: "keyboardShortcuts.edit.recording" })
      : row.where ? formatMessage({ id: row.where }) : null;

  return (
    <li data-shortcut-row={row.id} data-shortcut-editing={editing ? row.id : undefined} data-changed={changed ? "" : undefined}>
      <div
        className={[
          "-mx-2 grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 rounded-control px-2 py-1.5",
          editing ? "bg-selected" : "",
        ].join(" ")}
      >
        <span className="grid min-w-0">
          <span className="flex items-center gap-1.5 text-callout text-foreground">
            {changed ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" data-shortcut-changed-mark="" /> : null}
            {label}
          </span>
          {second ? (
            <span
              id={descriptionId}
              className={`text-footnote ${refused ? "text-danger-strong" : "text-foreground-hint"}`}
              role={refused ? "alert" : undefined}
            >
              {second}
            </span>
          ) : null}
          {changed && !editing ? (
            <span className="text-footnote text-foreground-hint" data-shortcut-default="">
              {formatMessage({ id: "keyboardShortcuts.edit.changedDefault" }, { keys: defaultText })}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5 justify-self-end" data-shortcut-keys="">
          {changeable && changed && !editing ? (
            <Button
              type="button"
              variant="ghost"
              size="md"
              onClick={reset}
              aria-label={formatMessage({ id: "keyboardShortcuts.edit.resetLabel" }, { command: label })}
              data-testid="shortcut-reset"
            >
              {formatMessage({ id: "keyboardShortcuts.edit.reset" })}
            </Button>
          ) : null}
          {command.desktopMenu ? (
            <Tooltip content={formatMessage({ id: "keyboardShortcuts.desktopMenu.locked" })}>
              <span role="img" className="flex text-foreground-hint" aria-label={formatMessage({ id: "keyboardShortcuts.desktopMenu.locked" })} data-shortcut-locked="">
                <Lock size={14} aria-hidden="true" />
              </span>
            </Tooltip>
          ) : null}
          {binding ? (
            editing ? binding : <Tooltip content={formatMessage({ id: "keyboardShortcuts.edit.change" })}>{binding}</Tooltip>
          ) : keys.length > 0 ? (
            <ShortcutKeysView keys={keys} platform={platform} />
          ) : (
            <span className="text-footnote text-foreground-hint">{formatMessage({ id: "keyboardShortcuts.edit.notSet" })}</span>
          )}
        </span>
      </div>
      {editing?.phase === "conflict" ? (
        <ShortcutConflictBanner editing={editing} platform={platform} onCancel={editor.cancel} onResolve={editor.resolve} />
      ) : null}
    </li>
  );
}
