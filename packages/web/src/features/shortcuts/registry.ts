import type { KeyboardPlatform } from "@botiverse/raft-ui/wip";
import type { MessageId } from "../../i18n/messages/en";
import {
  COMMENT_SHORTCUT,
  GLOBAL_SEARCH_SHORTCUT,
  SEND_AS_TASK_SHORTCUT,
  SHORTCUT_HELP_SHORTCUT,
  SIDEBAR_TOGGLE_SHORTCUT,
  isCommentOtherActionShortcut,
  isCommentShortcut,
  isDraftRedoShortcut,
  isDraftUndoShortcut,
  isFindShortcut,
  isGlobalSearchShortcut,
  isShortcutHelpShortcut,
  isSidebarToggleShortcut,
} from "../../utils/keyboardShortcuts";
import type { KeyboardShortcutEvent, ShortcutCombo, ShortcutModifiers } from "../../utils/keyboardShortcuts";
import { isThreadSearchShortcut } from "../../components/message/threadSearch";

/**
 * Where a command works. A scope is active while focus is inside an element marked `data-shortcut-scope="<name>"`
 * (or, with the focus fallen to the body, the element last clicked or focused was), while a registration says it is
 * (`useShortcut`'s `ambient`: a page or a selection that holds no focus), or while a layer of that name is open
 * (dispatcher.ts); `global` always is. A scope's parents are the scopes it can be active inside, which is what the
 * conflict check reads: two commands overlap when their scopes are the same or one sits inside the other. A layer
 * scope (an overlay, a menu, a docked panel) is offered the key over whatever has the focus, so it overlaps every
 * scope.
 */
export const SHORTCUT_SCOPES = {
  global: { parents: [] },
  conversation: { parents: ["global"] },
  thread: { parents: ["global"] },
  messageList: { parents: ["conversation", "thread"] },
  composer: { parents: ["conversation", "thread"] },
  threadSearch: { parents: ["thread"] },
  filePreview: { parents: ["global"] },
  artifact: { parents: ["global"] },
  artifactReview: { parents: ["artifact"] },
  commentBox: { parents: ["artifact"] },
  settings: { parents: ["global"] },
  computerEditor: { parents: ["global"] },
  resizeHandle: { parents: ["global"] },
  migrationChord: { parents: ["global"] },
  // Layers (pushShortcutLayer): Esc goes to the innermost one open.
  lightbox: { parents: ["global"], layer: true },
  dialog: { parents: ["global"], layer: true },
  menu: { parents: ["global"], layer: true },
  panel: { parents: ["global"], layer: true },
  selection: { parents: ["global"], layer: true },
  commentCard: { parents: ["global"], layer: true },
} as const satisfies Record<string, { parents: readonly string[]; layer?: true }>;

/** Each scope's parents (SHORTCUT_SCOPES). */
export const SHORTCUT_SCOPE_PARENTS: { readonly [S in keyof typeof SHORTCUT_SCOPES]: readonly (keyof typeof SHORTCUT_SCOPES)[] } =
  Object.fromEntries(Object.entries(SHORTCUT_SCOPES).map(([scope, { parents }]) => [scope, parents])) as never;

export type ShortcutScope = keyof typeof SHORTCUT_SCOPES;

/** The same modifiers with either of two keys (⇧ ← →): one compact group on screen, two shortcuts for a screen reader. */
export type ShortcutEither = ShortcutModifiers & { keys: readonly [string, string] };

/** One shortcut as the panel draws it: a combo; a range first…last (⌘1…⌘9); or `ShortcutEither`. */
export type ShortcutKeys =
  | ShortcutCombo
  | { from: ShortcutCombo; to: ShortcutCombo }
  | ShortcutEither;

export type ShortcutGroupId = "global" | "message-box" | "channels-threads" | "previews-comments" | "artifacts" | "other" | "workspaces";

/** A command's default keys, alternatives in order: one list for every platform, or one per platform (none = not on it). */
export type ShortcutDefaults = { all: readonly ShortcutCombo[] } | { mac?: readonly ShortcutCombo[]; other?: readonly ShortcutCombo[] };

export interface ShortcutCommand {
  /** Stable id: `useShortcut(id)`, the panel's row, and later a person's override. */
  id: string;
  group: ShortcutGroupId;
  scope: ShortcutScope;
  defaults: ShortcutDefaults;
  /** The panel's drawing of the keys, where it groups them (a range, either of two keys); else the defaults. */
  display?: readonly ShortcutKeys[];
  /** What the command does. */
  label: MessageId;
  /** Where it works, the panel row's second line. */
  where?: MessageId;
  /**
   * A person may change it in the panel. Every command with a modifier may, except the standard editing keys (⌘Z,
   * ⇧Enter, ⇧←→), the send key (a Settings choice) and the desktop app's own.
   */
  rebindable: boolean;
  /** Two keys with the same modifiers (⌘↑ / ⌘↓): changed together, the modifiers only. */
  pair?: true;
  /** One of the desktop app's menu accelerators: listed read-only, and no web command may take its keys. */
  desktopMenu?: true;
  /**
   * In a text field: by default only a combo with ⌘/Ctrl or ⌥ is a command (a bare key is typing). "always" takes
   * its keys there too (a ⇧Enter command); "never" leaves every key in a field to the field.
   */
  textField?: "always" | "never";
  /** While at its defaults, ⌘ or Ctrl stands for `mod` on any platform (the handler took either before the registry). */
  eitherMod?: true;
  /** Matched by the physical key alone (match.ts matchComboPhysical), as the otter's shortcut always was. */
  physical?: true;
  /** Same-binding commands in overlapping scopes this one deliberately wins over (checked by the conflict test). */
  shadows?: readonly string[];
  /** Runs on auto-repeat too; by default a held key is taken (preventDefault) but runs once. */
  repeat?: true;
  /** Runs even when a surface already took the key (defaultPrevented). */
  ignoreDefaultPrevented?: true;
  /** The desktop app only: in a browser the key is the browser's. */
  desktopAppOnly?: true;
  /** The assistant otter's own shortcut, set in Settings; the panel shows the person's binding (useOtterShortcutRowKeys). */
  assistantOtter?: true;
  /** The file that handles the key, from the repository root (the panel list's test checks it exists). */
  handler: string;
  /** The app's matcher, where the key goes through one (the panel list's test presses the keys through it). */
  matches?: (event: KeyboardShortcutEvent, platform: string) => boolean;
}

const WEB = "packages/web/src";
const SHIFT_ENTER: ShortcutCombo = { shift: true, key: "Enter" };
const MOD_ENTER: ShortcutCombo = { mod: true, key: "Enter" };
const MOD_F: ShortcutCombo = { mod: true, key: "F" };
const SHIFT_ARROWS: readonly ShortcutCombo[] = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].map((key) => ({ shift: true, key }));
const MOD_DIGITS: readonly ShortcutCombo[] = Array.from({ length: 9 }, (_, index) => ({ mod: true, key: String(index + 1) }));

/**
 * Every shortcut with a modifier the web app handles, and the desktop app's own (its Settings, History and Server
 * menus), in the panel's order. Single keys (Esc, Enter, the arrows) are not listed, nor the desktop menus'
 * standard items. The panel, the phone page, menu labels and `aria-keyshortcuts` read their keys from here, and
 * `useShortcut` dispatches by it, so a new shortcut belongs here. Source: Ray's inventory v2; Artea's mockup.
 */
export const SHORTCUT_COMMANDS: readonly ShortcutCommand[] = [
  { id: "open-help", group: "global", scope: "global", defaults: { all: [SHORTCUT_HELP_SHORTCUT] }, label: "keyboardShortcuts.openHelp", where: "keyboardShortcuts.openHelp.where", rebindable: true, handler: `${WEB}/features/keyboard-shortcuts/ShortcutHelpColumn.tsx`, matches: isShortcutHelpShortcut },
  // ⌘K kept its pre-registry behaviour: it repeats while held, and fires over a surface that took the key.
  { id: "search", group: "global", scope: "global", defaults: { all: [GLOBAL_SEARCH_SHORTCUT] }, label: "keyboardShortcuts.search", where: "keyboardShortcuts.search.where", rebindable: true, repeat: true, ignoreDefaultPrevented: true, handler: `${WEB}/components/layout/MainLayout.tsx`, matches: isGlobalSearchShortcut },
  { id: "sidebar", group: "global", scope: "global", defaults: { all: [SIDEBAR_TOGGLE_SHORTCUT] }, label: "keyboardShortcuts.sidebar", where: "keyboardShortcuts.sidebar.where", rebindable: true, ignoreDefaultPrevented: true, handler: `${WEB}/components/layout/MainLayout.tsx`, matches: isSidebarToggleShortcut },
  // The desktop app's menu accelerators (apps/desktop appMenu.ts): Settings, and History's Back / Forward, the
  // platform's convention (historyNavigation.ts): ⌘[ / ⌘] on a Mac, Alt+← / Alt+→ elsewhere.
  { id: "open-settings", group: "global", scope: "global", defaults: { all: [{ mod: true, key: "," }] }, label: "keyboardShortcuts.openSettings", where: "keyboardShortcuts.desktopMenu.where", rebindable: false, desktopMenu: true, desktopAppOnly: true, handler: "apps/desktop/src/main/appMenu.ts" },
  { id: "history", group: "global", scope: "global", defaults: { mac: [{ mod: true, key: "[" }, { mod: true, key: "]" }] }, label: "keyboardShortcuts.history", where: "keyboardShortcuts.desktopMenu.where", rebindable: false, desktopMenu: true, pair: true, desktopAppOnly: true, handler: "apps/desktop/src/main/historyNavigation.ts" },
  { id: "history-other", group: "global", scope: "global", defaults: { other: [{ alt: true, key: "ArrowLeft" }, { alt: true, key: "ArrowRight" }] }, label: "keyboardShortcuts.history", where: "keyboardShortcuts.desktopMenu.where", rebindable: false, desktopMenu: true, pair: true, desktopAppOnly: true, handler: "apps/desktop/src/main/historyNavigation.ts" },
  // The assistant's otter (#proj-assistant:#21): ASSISTANT_OTTER_SHORTCUT_DEFAULT, changed in this panel (its
  // Settings-era choice still counts, overridesState.ts); matched by KeyboardEvent.code.
  { id: "assistant-otter", group: "global", scope: "global", defaults: { all: [{ mod: true, shift: true, key: "." }] }, label: "keyboardShortcuts.assistantOtter", where: "keyboardShortcuts.assistantOtter.where", rebindable: true, textField: "never", physical: true, assistantOtter: true, handler: `${WEB}/assistant/AssistantOtterShortcut.tsx` },

  { id: "new-line", group: "message-box", scope: "composer", defaults: { all: [SHIFT_ENTER] }, label: "keyboardShortcuts.newLine", where: "keyboardShortcuts.newLine.where", rebindable: false, handler: `${WEB}/features/composer/MessageInput.tsx` },
  { id: "send", group: "message-box", scope: "composer", defaults: { all: [MOD_ENTER] }, label: "keyboardShortcuts.send", where: "keyboardShortcuts.send.where", rebindable: false, handler: `${WEB}/features/composer/MessageInput.tsx` },
  { id: "send-as-task", group: "message-box", scope: "composer", defaults: { all: [SEND_AS_TASK_SHORTCUT] }, label: "keyboardShortcuts.sendAsTask", where: "keyboardShortcuts.sendAsTask.where", rebindable: true, eitherMod: true, handler: `${WEB}/features/composer/MessageInput.tsx` },
  { id: "undo-mention", group: "message-box", scope: "composer", defaults: { all: [{ mod: true, key: "Z" }] }, label: "keyboardShortcuts.undoMention", where: "keyboardShortcuts.undoMention.where", rebindable: false, eitherMod: true, handler: `${WEB}/features/composer/MessageInput.tsx` },

  { id: "search-channel", group: "channels-threads", scope: "conversation", defaults: { all: [MOD_F] }, label: "keyboardShortcuts.searchChannel", where: "keyboardShortcuts.searchChannel.where", rebindable: true, handler: `${WEB}/features/channel/ChatPanel.tsx`, matches: isThreadSearchShortcut },
  { id: "search-thread", group: "channels-threads", scope: "thread", defaults: { all: [MOD_F] }, label: "keyboardShortcuts.searchThread", where: "keyboardShortcuts.searchThread.where", rebindable: true, handler: `${WEB}/features/thread/useThreadSearch.ts`, matches: isThreadSearchShortcut },
  { id: "previous-match", group: "channels-threads", scope: "threadSearch", defaults: { all: [SHIFT_ENTER] }, label: "keyboardShortcuts.previousMatch", where: "keyboardShortcuts.previousMatch.where", rebindable: false, handler: `${WEB}/features/thread/ThreadSearchBar.tsx` },
  // raft-ui's message list handles it; VirtualMessageTimeline leaves Ctrl out.
  { id: "jump-ends", group: "channels-threads", scope: "messageList", defaults: { mac: [{ mod: true, key: "ArrowUp" }, { mod: true, key: "ArrowDown" }] }, label: "keyboardShortcuts.jumpEnds", where: "keyboardShortcuts.jumpEnds.where", rebindable: true, pair: true, handler: `${WEB}/components/message/VirtualMessageTimeline.tsx` },

  // Desktop app only (Artea): a browser keeps ⌘W / Ctrl+W for closing the tab.
  { id: "close-preview", group: "previews-comments", scope: "lightbox", defaults: { all: [{ mod: true, key: "W" }] }, label: "keyboardShortcuts.closePreview", where: "keyboardShortcuts.closePreview.where", rebindable: false, eitherMod: true, desktopAppOnly: true, handler: `${WEB}/components/FileViewerShell.tsx` },
  // Also apps/artifacts/ArtifactShellComments.tsx, through the same matcher.
  { id: "comment-selection", group: "previews-comments", scope: "filePreview", defaults: { all: [COMMENT_SHORTCUT] }, label: "keyboardShortcuts.commentSelection", rebindable: true, textField: "never", handler: `${WEB}/components/message/AttachmentCommentMargin.tsx`, matches: isCommentShortcut },

  // An Artifact's own keys: the group's title says where they work (#250: no "In an Artifact" on each row).
  { id: "comment-new-line", group: "artifacts", scope: "commentBox", defaults: { all: [SHIFT_ENTER] }, label: "keyboardShortcuts.commentNewLine", rebindable: false, handler: `${WEB}/apps/artifacts/ArtifactCommentBox.tsx` },
  // A new comment's box that also keeps drafts: Enter does one of Send and Save Draft, this the other.
  { id: "comment-other-action", group: "artifacts", scope: "commentBox", defaults: { all: [MOD_ENTER] }, label: "keyboardShortcuts.commentOtherAction", rebindable: true, eitherMod: true, handler: `${WEB}/apps/artifacts/ArtifactCommentBox.tsx`, matches: isCommentOtherActionShortcut },
  { id: "artifact-find", group: "artifacts", scope: "artifact", defaults: { all: [MOD_F] }, label: "keyboardShortcuts.artifactFind", rebindable: true, handler: `${WEB}/apps/artifacts/artifactFind.ts`, matches: isFindShortcut },
  { id: "undo-draft", group: "artifacts", scope: "artifactReview", defaults: { all: [{ mod: true, key: "Z" }] }, label: "artifacts.review.undo", rebindable: false, textField: "never", eitherMod: true, handler: `${WEB}/apps/artifacts/ArtifactReviewParts.tsx`, matches: isDraftUndoShortcut },
  // ⌘Y works on a Mac too: the handler takes either modifier on every platform.
  { id: "redo-draft", group: "artifacts", scope: "artifactReview", defaults: { all: [{ mod: true, shift: true, key: "Z" }, { mod: true, key: "Y" }] }, label: "artifacts.review.redo", rebindable: false, textField: "never", eitherMod: true, handler: `${WEB}/apps/artifacts/ArtifactReviewParts.tsx`, matches: isDraftRedoShortcut },

  { id: "save-computer-description", group: "other", scope: "computerEditor", defaults: { all: [MOD_ENTER] }, label: "keyboardShortcuts.saveComputerDescription", where: "keyboardShortcuts.saveComputerDescription.where", rebindable: true, eitherMod: true, handler: `${WEB}/features/computer/useMachineDetailEditors.ts` },
  // Also components/task/ChannelSideArea.tsx, for the side sections' divider.
  { id: "resize-big-steps", group: "other", scope: "resizeHandle", defaults: { all: SHIFT_ARROWS }, display: [{ shift: true, keys: ["ArrowLeft", "ArrowRight"] }, { shift: true, keys: ["ArrowUp", "ArrowDown"] }], label: "keyboardShortcuts.resizeBigSteps", where: "keyboardShortcuts.resizeBigSteps.where", rebindable: false, handler: `${WEB}/components/ui/ColumnResizeHandle.tsx` },
  { id: "open-actions-menu", group: "other", scope: "migrationChord", defaults: { all: [{ shift: true, key: "F10" }] }, label: "keyboardShortcuts.openActionsMenu", where: "keyboardShortcuts.openActionsMenu.where", rebindable: false, handler: `${WEB}/components/agentMigration/log/MigrationChord.tsx` },
  // Pressed again in the field, ⌘F / Ctrl+F is the browser's own find (raft-design settings.md#searching-settings).
  { id: "search-settings", group: "other", scope: "settings", defaults: { all: [MOD_F] }, label: "settings.search.placeholder", where: "keyboardShortcuts.searchSettings.where", rebindable: true, handler: `${WEB}/features/settings/search/SettingsSearch.tsx`, matches: isFindShortcut },

  { id: "switch-workspace", group: "workspaces", scope: "global", defaults: { all: MOD_DIGITS }, display: [{ from: { mod: true, key: "1" }, to: { mod: true, key: "9" } }], label: "keyboardShortcuts.switchWorkspace", where: "keyboardShortcuts.desktopMenu.where", rebindable: false, desktopMenu: true, desktopAppOnly: true, handler: "apps/desktop/src/main/serverSwitching.ts" },
  { id: "step-workspace", group: "workspaces", scope: "global", defaults: { all: [{ mod: true, shift: true, key: "[" }, { mod: true, shift: true, key: "]" }] }, label: "keyboardShortcuts.stepWorkspace", where: "keyboardShortcuts.desktopMenu.where", rebindable: false, desktopMenu: true, pair: true, desktopAppOnly: true, handler: "apps/desktop/src/main/serverSwitching.ts" },
];

const BY_ID = new Map(SHORTCUT_COMMANDS.map((command) => [command.id, command]));

export function getShortcutCommand(id: string): ShortcutCommand {
  const command = BY_ID.get(id);
  if (!command) throw new Error(`Unknown shortcut command "${id}": add it to SHORTCUT_COMMANDS`);
  return command;
}

/** The command's default keys on `platform`; empty where it has none (a Mac-only or Windows-only command). */
export function defaultCombos(command: ShortcutCommand, platform: KeyboardPlatform): readonly ShortcutCombo[] {
  const { defaults } = command;
  if ("all" in defaults) return defaults.all;
  return (platform === "mac" ? defaults.mac : defaults.other) ?? [];
}

function scopeWithAncestors(scope: ShortcutScope): Set<ShortcutScope> {
  const seen = new Set<ShortcutScope>([scope]);
  for (const parent of SHORTCUT_SCOPE_PARENTS[scope]) for (const ancestor of scopeWithAncestors(parent)) seen.add(ancestor);
  return seen;
}

const isLayerScope = (scope: ShortcutScope) => "layer" in SHORTCUT_SCOPES[scope];

/**
 * Two scopes can be active at once: the same scope, or one inside the other; or either is a layer's (an open
 * overlay is offered the key over whatever has the focus).
 */
export function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
  if (isLayerScope(a) || isLayerScope(b)) return true;
  return scopeWithAncestors(a).has(b) || scopeWithAncestors(b).has(a);
}

const LATIN_ALNUM = /^[a-z0-9]$/i;

/**
 * The keys a combo is pressed with on `platform`, as the conflict check compares them: ⌘ is `mod` on a Mac only,
 * Ctrl is `mod` (or `ctrl`) elsewhere. A punctuation key ignores ⇧, since the matcher takes the ⇧ a layout types
 * it with (German /: ⇧7), so ⌘/ and ⌘⇧/ are one key there; not for the desktop app's menus (`exact`), whose
 * accelerators Electron compares as written. `eitherMod`: ⌃ stands for ⌘ on a Mac too.
 */
export function conflictKeysOf(combo: ShortcutCombo, platform: KeyboardPlatform, eitherMod: boolean, exact = false): string[] {
  const mac = platform === "mac";
  const key = combo.key.toLowerCase();
  const punctuation = !exact && key.length === 1 && !LATIN_ALNUM.test(key);
  const shift = combo.shift && !punctuation ? "shift+" : "";
  const alt = combo.alt ? "alt+" : "";
  // "mod+" is ⌘ on a Mac and Ctrl elsewhere; "ctrl+" is a Mac's ⌃.
  const keyOf = (command: boolean, control: boolean) => `${platform}:${command ? "mod+" : ""}${control ? "ctrl+" : ""}${alt}${shift}${key}`;
  if (!mac) return [keyOf(!!(combo.mod || combo.ctrl), false)];
  const keys = [keyOf(!!combo.mod, !!combo.ctrl)];
  if (eitherMod && combo.mod && !combo.ctrl) keys.push(keyOf(false, true));
  return keys;
}

/**
 * Pairs of commands whose default keys collide on some platform in scopes that can be active together, unless one
 * declares it `shadows` the other. Read by the registry's CI test; the panel asks the same of a person's change
 * (conflicts.ts).
 */
export function findDefaultConflicts(commands: readonly ShortcutCommand[] = SHORTCUT_COMMANDS): string[] {
  const conflicts: string[] = [];
  const keysOf = (command: ShortcutCommand, platform: KeyboardPlatform, exact: boolean) =>
    defaultCombos(command, platform).flatMap((combo) => conflictKeysOf(combo, platform, !!command.eitherMod, exact));
  for (const platform of ["mac", "other"] as const) {
    commands.forEach((a, index) => {
      for (const b of commands.slice(index + 1)) {
        if (!scopesOverlap(a.scope, b.scope) || a.shadows?.includes(b.id) || b.shadows?.includes(a.id)) continue;
        const exact = !!(a.desktopMenu || b.desktopMenu);
        const keysA = new Set(keysOf(a, platform, exact));
        const shared = new Set(keysOf(b, platform, exact).filter((key) => keysA.has(key)));
        for (const key of shared) conflicts.push(`${key}: ${a.id} (${a.scope}) and ${b.id} (${b.scope})`);
      }
    });
  }
  return conflicts;
}
