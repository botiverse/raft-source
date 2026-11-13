import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { registerShortcutHandler } from "./dispatcher";
import type { ShortcutHandler } from "./dispatcher";

export interface UseShortcutOptions {
  /** Off while false: the key goes on as if this component weren't there. Default true. */
  enabled?: boolean;
  /**
   * The element marked with the command's scope (`data-shortcut-scope`) that this handler belongs to: of two
   * surfaces with the same scope, only the one the key is pressed in (or was last clicked) runs.
   */
  scopeRef?: RefObject<Element | null>;
  /**
   * Offered the key wherever the focus is while enabled (after the focused scopes, before global): a page or a
   * text selection that holds no focus of its own.
   */
  ambient?: boolean;
}

/**
 * Handle registry command `id` while mounted, through the one keydown dispatcher (dispatcher.ts): it matches the
 * command's keys for this platform, with the person's change applied (overrides.ts), skips IME composition, offers
 * the key to the open layers, then the focused scope, then ambient handlers, then global, and calls preventDefault
 * once a handler takes it. The latest handler is always the one called; registering doesn't change with it.
 * Return false from the handler for "not mine".
 */
export function useShortcut(id: string, handler: ShortcutHandler, { enabled = true, scopeRef, ambient = false }: UseShortcutOptions = {}): void {
  const handlerRef = useRef(handler);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    handlerRef.current = handler;
    enabledRef.current = enabled;
  });
  useEffect(() => registerShortcutHandler(id, () => handlerRef.current, {
    enabled: () => enabledRef.current,
    node: scopeRef ? () => scopeRef.current : undefined,
    ambient,
  }), [id, scopeRef, ambient]);
}
