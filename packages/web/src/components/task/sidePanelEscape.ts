import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";

import { useDomMeasureEffect } from "../../hooks/effectPrimitives";
import { useFocusRestore } from "../../hooks/useFocusRestore";
import { isCoveredByShortcutHelp } from "../../features/keyboard-shortcuts/shortcutHelpStore";
import { useShortcutLayer } from "../../features/shortcuts/useShortcutLayer";

/** On a text field in a side panel: Escape empties it first (a search or filter field, as FitToolbarSearch does). */
export const ESCAPE_CLEARS_ATTRIBUTE = "data-escape-clears";

/** Undoes one thing open inside the panel (an inline editor, a page within it); true when it did, else not its turn. */
type EscapeStep = () => boolean | void;

interface EscapeSteps {
  add: (step: EscapeStep) => () => void;
}

const SidePanelEscapeContext = createContext<EscapeSteps | null>(null);
export const SidePanelEscapeProvider = SidePanelEscapeContext.Provider;

/**
 * Something inside a side panel that Escape undoes before the panel closes (raft-design panel.md: an open inline
 * editor, a page within the panel). Registered while `active`; the one registered last goes first. `undo` returns
 * true when it undid something, false to leave this Escape to the next step (the panel's guarded close included).
 * Outside a panel that closes on Escape it does nothing.
 */
export function useSidePanelEscapeStep(active: boolean, undo: EscapeStep): void {
  const steps = useContext(SidePanelEscapeContext);
  const undoRef = useRef(undo);
  useEffect(() => {
    undoRef.current = undo;
  });
  useEffect(() => {
    if (!active || !steps) return;
    return steps.add(() => undoRef.current());
  }, [active, steps]);
}

/** Empties a focused search field the way typing would, so its owner's onChange runs; true when it had text. */
function clearField(target: EventTarget | null): boolean {
  const field = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
  if (!field || field.value === "" || field.readOnly || field.disabled) return false;
  if (!(field.type === "search" || field.hasAttribute(ESCAPE_CLEARS_ATTRIBUTE))) return false;
  const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, "");
  const InputEvent = field.ownerDocument.defaultView?.Event ?? Event;
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  return true;
}

/**
 * Escape in a side panel (raft-design panel.md, Kirby and Jasper): only while focus is inside it, and one thing at a
 * time. (1) A search field with text is emptied; (2) an inline editor or a page within the panel is undone (its
 * step); (3) the panel closes through `onClose`, its guarded close (false: the unsaved-changes prompt asked instead),
 * and focus goes back to what opened it, else to `returnFocus`. With focus anywhere else the Escape isn't the
 * panel's. Menus and popovers inside take their own Escape first (the layer leaves a prevented Escape alone).
 *
 * One layer on the shortcut registry's stack (useShortcutLayer), as the profile panel's: no keydown of its own.
 * Returns the steps for SidePanelEscapeProvider.
 */
export function useSidePanelEscape(
  panelRef: RefObject<HTMLElement | null>,
  open: boolean,
  { onClose, returnFocus }: { onClose: () => boolean | void; returnFocus?: () => HTMLElement | null },
): EscapeSteps {
  const stepsRef = useRef<EscapeStep[]>([]);
  const steps = useMemo<EscapeSteps>(() => ({
    add: (step) => {
      stepsRef.current = [...stepsRef.current, step];
      return () => {
        stepsRef.current = stepsRef.current.filter((entry) => entry !== step);
      };
    },
  }), []);
  // What had focus as the panel opened (the channel's name, the gear): measured before paint, before focus moves.
  const openerRef = useRef<HTMLElement | null>(null);
  useDomMeasureEffect(() => {
    if (!open) return;
    const focused = document.activeElement;
    openerRef.current = focused instanceof HTMLElement && focused !== document.body && !panelRef.current?.contains(focused)
      ? focused
      : null;
  }, [open, panelRef]);
  const restoreToOpener = useFocusRestore(() => [openerRef.current, returnFocus?.()]);
  // A step that unmounted what had focus (the editor's field) leaves it in the panel, so the next Escape is its own.
  const keepFocusInPanel = useFocusRestore(panelRef);
  useShortcutLayer("panel", open, {
    onEscape: (event) => {
      if (isCoveredByShortcutHelp()) return false;
      const panel = panelRef.current;
      if (!panel || !(event.target instanceof Node) || !panel.contains(event.target)) return false;
      if (clearField(event.target)) return;
      for (const step of [...stepsRef.current].reverse()) {
        if (step() === true) {
          keepFocusInPanel();
          return;
        }
      }
      if (onClose() === false) return;
      restoreToOpener();
    },
  });
  return steps;
}
