import { useEffect, useRef } from "react";
import { pushShortcutLayer } from "./dispatcher";
import type { LayerOptions, ShortcutHandler } from "./dispatcher";
import type { ShortcutScope } from "./registry";

export interface UseShortcutLayerOptions extends Omit<LayerOptions, "onEscape" | "onKey"> {
  /** Esc while this is the innermost open layer; return false for "not mine". */
  onEscape?: ShortcutHandler;
  /** Every other key while open, innermost layer first; return true when it took the key. */
  onKey?: (event: KeyboardEvent) => boolean | void;
}

/**
 * An overlay, menu or docked panel open while `open`: one layer on the registry's stack (dispatcher.ts), so Esc goes
 * to the innermost open layer only, never to every surface listening at once. The layer keeps its place in the stack
 * while open; its handlers are always the latest.
 */
export function useShortcutLayer(scope: ShortcutScope, open: boolean, options: UseShortcutLayerOptions = {}): void {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const { modal, phase, ignoreDefaultPrevented, stopPropagation } = options;
  const hasEscape = !!options.onEscape;
  const hasKey = !!options.onKey;
  useEffect(() => {
    if (!open) return;
    return pushShortcutLayer(scope, {
      modal,
      phase,
      ignoreDefaultPrevented,
      stopPropagation,
      onEscape: hasEscape ? () => (event) => optionsRef.current.onEscape?.(event) : undefined,
      onKey: hasKey ? () => (event) => optionsRef.current.onKey?.(event) : undefined,
    });
  }, [scope, open, modal, phase, ignoreDefaultPrevented, stopPropagation, hasEscape, hasKey]);
}
