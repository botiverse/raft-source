import { Fragment } from "react";
import type { ComponentProps } from "react";
import { useIntl } from "react-intl";
import { KbdShortcut } from "@botiverse/raft-ui/wip";
import type { KbdKeyName, KeyboardPlatform } from "@botiverse/raft-ui/wip";
import { shortcutKeyNames, shortcutSpokenLabel } from "../../utils/keyboardShortcuts";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";
import type { ShortcutEither, ShortcutKeys } from "./keyboardShortcutList";

/** Raft DS › Kbd: alternatives and a range's two ends sit 6px apart at `md`, the mark between them in the hint color. */
const SEPARATOR_CLASS = "text-footnote text-foreground-hint";

type KbdSize = ComponentProps<typeof KbdShortcut>["size"];

/** The modifiers, then both keys: ⇧ ← →. KbdShortcut draws the modifiers first and the other keys as written. */
function eitherKeyNames(either: ShortcutEither): KbdKeyName[] {
  return [...shortcutKeyNames({ ...either, key: either.keys[0] }), either.keys[1]];
}

/** A word only a screen reader hears ("or", "to"), spaced from the shortcuts around it. */
function SpokenWord({ children }: { children: string }) {
  return <span className="sr-only"> {children} </span>;
}

/** One entry of a row's keys: one KbdShortcut, a range's two, or either of two keys. */
function ShortcutEntry({ keys, platform, size }: { keys: ShortcutKeys; platform: KeyboardPlatform; size: KbdSize }) {
  const { formatMessage } = useIntl();
  // What a screen reader hears, in the reader's language (KbdShortcut's own words are English).
  const spoken = (combo: ShortcutCombo) => shortcutSpokenLabel(combo, formatMessage);
  if ("from" in keys) {
    return (
      <>
        <KbdShortcut keys={shortcutKeyNames(keys.from)} size={size} platform={platform} label={spoken(keys.from)} />
        <span aria-hidden="true" className={SEPARATOR_CLASS}>…</span>
        <SpokenWord>{formatMessage({ id: "keyboardShortcuts.rangeTo" })}</SpokenWord>
        <KbdShortcut keys={shortcutKeyNames(keys.to)} size={size} platform={platform} label={spoken(keys.to)} />
      </>
    );
  }
  if ("keys" in keys) {
    // One compact group on screen (⇧ ← →); a screen reader hears two
    // shortcuts, "Shift Left Arrow or Shift Right Arrow", not a three-key chord.
    return (
      <>
        <KbdShortcut aria-hidden="true" keys={eitherKeyNames(keys)} size={size} platform={platform} />
        <span className="sr-only">
          <KbdShortcut keys={shortcutKeyNames({ ...keys, key: keys.keys[0] })} size={size} platform={platform} label={spoken({ ...keys, key: keys.keys[0] })} />
          <SpokenWord>{formatMessage({ id: "keyboardShortcuts.or" })}</SpokenWord>
          <KbdShortcut keys={shortcutKeyNames({ ...keys, key: keys.keys[1] })} size={size} platform={platform} label={spoken({ ...keys, key: keys.keys[1] })} />
        </span>
      </>
    );
  }
  return <KbdShortcut keys={shortcutKeyNames(keys)} size={size} platform={platform} label={spoken(keys)} />;
}

/**
 * A row's keys: raft-ui's KbdShortcut at `md` (`sm` in the conflict banner's sentence), a cap per key, drawn for this
 * platform only, alternatives with an aria-hidden "/" and an "or" for a screen reader.
 */
export function ShortcutKeysView({ keys, platform, size = "md" }: { keys: readonly ShortcutKeys[]; platform: KeyboardPlatform; size?: KbdSize }) {
  const { formatMessage } = useIntl();
  return (
    <>
      {keys.map((entry, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <>
              <span aria-hidden="true" className={SEPARATOR_CLASS}>/</span>
              <SpokenWord>{formatMessage({ id: "keyboardShortcuts.or" })}</SpokenWord>
            </>
          ) : null}
          <ShortcutEntry keys={entry} platform={platform} size={size} />
        </Fragment>
      ))}
    </>
  );
}
