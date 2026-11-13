import { useEffect } from "react";
import type { RefObject } from "react";
import type { VirtualListApi } from "@botiverse/raft-ui";
import { keyboardPlatform } from "../../utils/keyboardShortcuts";
import { matchCombo } from "../../features/shortcuts/match";
import { getShortcutCommand } from "../../features/shortcuts/registry";
import { isShortcutOverridden, resolvedCombos } from "../../features/shortcuts/overrides";

const JUMP_ENDS = "jump-ends";

/**
 * ⌘↑ / ⌘↓ on the focused message list (raft-ui VirtualList's own keys, Apple platforms) moved to the person's
 * modifiers (the shortcuts panel edits the pair, its keys stay ↑ / ↓): their combo jumps to the top or the bottom,
 * and ⌘↑ / ⌘↓ no longer do. At the defaults this does nothing and VirtualList handles the keys as before. Heard on
 * the list element itself, before VirtualList's own handler, and only for a key pressed on the list, as VirtualList's.
 */
export function useJumpEndsShortcut(listEl: () => HTMLElement | null, apiRef: RefObject<VirtualListApi | null>): void {
  useEffect(() => {
    const el = listEl();
    if (!el) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target !== el || event.defaultPrevented || !isShortcutOverridden(JUMP_ENDS)) return;
      const platform = keyboardPlatform();
      const [top, bottom] = resolvedCombos(getShortcutCommand(JUMP_ENDS), platform);
      const position = top && matchCombo(event, top, platform) ? "top" : bottom && matchCombo(event, bottom, platform) ? "bottom" : null;
      // VirtualList's ⌘↑ / ⌘↓ is the default the person moved: taken here, so it does nothing.
      const movedDefault = event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown");
      if (!position && !movedDefault) return;
      event.preventDefault();
      if (position) apiRef.current?.scrollTo({ position });
    };
    el.addEventListener("keydown", onKeyDown, true);
    return () => el.removeEventListener("keydown", onKeyDown, true);
  }, [listEl, apiRef]);
}
