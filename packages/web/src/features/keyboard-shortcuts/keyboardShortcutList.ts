import type { MessageId } from "../../i18n/messages/en";
import type { KeyboardShortcutEvent, ShortcutCombo } from "../../utils/keyboardShortcuts";
import { SHORTCUT_COMMANDS, defaultCombos } from "../shortcuts/registry";
import type { ShortcutCommand, ShortcutGroupId, ShortcutKeys } from "../shortcuts/registry";
import type { ComposerSendKey } from "@botiverse/raft-shared";

export type { ShortcutEither, ShortcutKeys } from "../shortcuts/registry";

export interface ShortcutRow {
  id: string;
  /** What the shortcut does. */
  label: MessageId;
  /** Where it works, the row's second line. */
  where?: MessageId;
  /** Alternatives, in this order: each entry is one shortcut, "/" between them. */
  keys: readonly ShortcutKeys[];
  /** Apple platforms only (⌘↑ / ⌘↓: elsewhere the list's Home / End do it, single keys this list leaves out). */
  appleOnly?: true;
  /** Windows and Linux only: a Mac has its own row for it. */
  otherOnly?: true;
  /** The desktop app only: in a browser the key is the browser's (Chrome and Safari switch or close tabs with it). */
  desktopAppOnly?: true;
  /**
   * The assistant otter's hide-or-show shortcut (#proj-assistant:#21): the person's own, set in
   * Settings › Appearance › Assistant. `keys` is the default; the panel shows the person's
   * binding instead, and no row while they have no assistant, its switch is off or the shortcut is.
   */
  assistantOtter?: true;
  /** The file that handles the key, from the repository root. The list's test checks each one still exists. */
  handler: string;
  /** The app's matcher, where the key goes through one: the list's test presses the row's keys through it and checks the handler file calls it. */
  matches?: (event: KeyboardShortcutEvent, platform: string) => boolean;
}

export interface ShortcutGroup {
  id: string;
  title: MessageId;
  rows: readonly ShortcutRow[];
}

const SHIFT_ENTER: ShortcutCombo = { shift: true, key: "Enter" };
const MOD_ENTER: ShortcutCombo = { mod: true, key: "Enter" };

/** The panel's groups, in the order it shows them. */
const PANEL_GROUPS: ReadonlyArray<{ id: ShortcutGroupId; title: MessageId }> = [
  { id: "global", title: "keyboardShortcuts.group.global" },
  { id: "message-box", title: "keyboardShortcuts.group.messageBox" },
  { id: "channels-threads", title: "keyboardShortcuts.group.channelsThreads" },
  { id: "previews-comments", title: "keyboardShortcuts.group.previewsComments" },
  { id: "artifacts", title: "keyboardShortcuts.group.artifacts" },
  { id: "other", title: "keyboardShortcuts.group.other" },
  { id: "workspaces", title: "keyboardShortcuts.group.workspaces" },
];

/** A registry command as the panel's row: its keys drawn as the registry groups them, for the platforms it has. */
function rowOf(command: ShortcutCommand): ShortcutRow {
  const mac = defaultCombos(command, "mac").length > 0;
  const other = defaultCombos(command, "other").length > 0;
  const { id, label, where, desktopAppOnly, assistantOtter, handler, matches } = command;
  return {
    id, label, where, handler, matches, desktopAppOnly, assistantOtter,
    keys: command.display ?? defaultCombos(command, mac ? "mac" : "other"),
    appleOnly: mac && !other ? true : undefined,
    otherOnly: other && !mac ? true : undefined,
  };
}

/**
 * The shortcut registry (features/shortcuts/registry.ts) grouped as the panel shows it, in the registry's order.
 * The panel and the phone page read their keys from here.
 */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = PANEL_GROUPS.map(({ id, title }) => ({
  id,
  title,
  rows: SHORTCUT_COMMANDS.filter((command) => command.group === id).map(rowOf),
}));

export { assistantOtterCombo } from "../shortcuts/overridesState";

/**
 * The message box's rows when the account sends with ⌘/Ctrl+Enter (#triage:#210,
 * features/composer/composerSendKey.ts): Enter alone is a new line too, and ⌘/Ctrl+Enter
 * is the only key that sends.
 */
/** The message box rows whose keys depend on the send key. */
type SendKeyRowId = "new-line" | "send";

const MOD_ENTER_SEND_ROWS: Readonly<Record<SendKeyRowId, Pick<ShortcutRow, "keys" | "where">>> = {
  "new-line": { keys: [{ key: "Enter" }, SHIFT_ENTER], where: "keyboardShortcuts.newLine.whereModEnter" },
  send: { keys: [MOD_ENTER], where: "keyboardShortcuts.send.whereModEnter" },
};

function isSendKeyRowId(id: string): id is SendKeyRowId {
  return Object.hasOwn(MOD_ENTER_SEND_ROWS, id);
}

/**
 * The groups and rows this platform and host have; a group left empty is dropped.
 * `assistantOtter`: the person's otter shortcut where it works (useOtterShortcutRowKeys),
 * else null, which drops its row. `composerSendKey`: the account's send key (default Enter).
 */
export function visibleShortcutGroups({ apple, desktopApp, assistantOtter, composerSendKey = "enter" }: {
  apple: boolean;
  desktopApp: boolean;
  assistantOtter: ShortcutCombo | null;
  composerSendKey?: ComposerSendKey;
}): ShortcutGroup[] {
  return SHORTCUT_GROUPS
    .map((group) => ({
      ...group,
      rows: group.rows
        .filter((row) => (apple ? !row.otherOnly : !row.appleOnly) && (desktopApp || !row.desktopAppOnly) && (!row.assistantOtter || assistantOtter))
        .map((row) => (row.assistantOtter && assistantOtter ? { ...row, keys: [assistantOtter] } : row))
        .map((row) => (group.id === "message-box" && composerSendKey === "mod_enter" && isSendKeyRowId(row.id) ? { ...row, ...MOD_ENTER_SEND_ROWS[row.id] } : row)),
    }))
    .filter((group) => group.rows.length > 0);
}
