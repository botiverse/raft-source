import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { KeyboardPlatform } from "@botiverse/raft-ui/wip";
import type { ShortcutCombo, ShortcutModifiers } from "../../utils/keyboardShortcuts";
import { checkRecordedBinding, bindingFromRecorded, isCurrentBinding, resolveConflict } from "../shortcuts/conflicts";
import type { BindingProblem } from "../shortcuts/conflicts";
import { setShortcutRecording } from "../shortcuts/dispatcher";
import { nextOverrides, useShortcutOverrides } from "../shortcuts/overrides";
import type { ShortcutOverrides } from "../shortcuts/overrides";
import { getShortcutCommand } from "../shortcuts/registry";
import { saveShortcutOverrides } from "../shortcuts/saveShortcutOverrides";
import "../shortcuts/shortcutAccountBridge";
import { comboFromKeydown, heldModifiers, isModifierKey } from "./recordCombo";
import { useShortcutLayer } from "../shortcuts/useShortcutLayer";

/**
 * One row being changed:
 * - `recording`: waiting for keys; `held` the modifiers down now, `refused` the last combo refused and why (it stays
 *   shown, in red, until the next key);
 * - `conflict`: the keys are another command's (`problem`), held for Cancel, Swap or Replace (or Cancel alone, for a
 *   desktop menu's or a fixed command's keys); nothing is saved yet.
 */
export type ShortcutEditing =
  | { id: string; phase: "recording"; held: ShortcutModifiers; refused: { combo: ShortcutCombo; problem: BindingProblem } | null }
  | { id: string; phase: "conflict"; combos: ShortcutCombo[]; problem: Extract<BindingProblem, { kind: "conflict" | "desktop" | "locked" }> };

/**
 * One key while recording `id`: the next editing state (null: done or cancelled) and the change to save, or
 * undefined when the key changes nothing (a held repeat, a key no combo is made of).
 */
function recorderStep(
  id: string,
  event: KeyboardEvent,
  overrides: ShortcutOverrides,
  platform: KeyboardPlatform,
): { editing: ShortcutEditing | null; save?: Record<string, readonly ShortcutCombo[]> } | undefined {
  if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return { editing: null };
  if (event.repeat) return undefined;
  if (isModifierKey(event)) return { editing: { id, phase: "recording", held: heldModifiers(event, platform), refused: null } };
  const combo = comboFromKeydown(event, platform);
  if (!combo) return undefined;
  const problem = checkRecordedBinding(id, combo, overrides, platform);
  if (problem && (problem.kind === "conflict" || problem.kind === "desktop" || problem.kind === "locked")) {
    return { editing: { id, phase: "conflict", combos: bindingFromRecorded(getShortcutCommand(id), combo, platform)!, problem } };
  }
  if (problem) return { editing: { id, phase: "recording", held: {}, refused: { combo, problem } } };
  const combos = bindingFromRecorded(getShortcutCommand(id), combo, platform)!;
  return { editing: null, save: isCurrentBinding(id, combos, overrides, platform) ? undefined : { [id]: combos } };
}

export interface ShortcutEditor {
  editing: ShortcutEditing | null;
  /** The last save failed (the change was put back). */
  saveFailed: boolean;
  start: (id: string) => void;
  cancel: () => void;
  resolve: (how: "replace" | "swap") => void;
  reset: (id: string) => void;
  resetAll: () => void;
}

/**
 * Changing shortcuts in the panel (Artea's mock, #proj-frontend:#37): click a shortcut to record; Esc, a press
 * elsewhere or leaving the panel cancels; a valid combo saves at once (to the account); a refused one stays for
 * another try; a taken one waits for Cancel / Swap / Replace. While recording, every key is the recorder's: the
 * registry's dispatcher is suspended, so the keys pressed never run their commands.
 */
export function useShortcutEditor(platform: KeyboardPlatform): ShortcutEditor {
  const overrides = useShortcutOverrides();
  const [editing, setEditing] = useState<ShortcutEditing | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const overridesRef = useRef(overrides);
  useEffect(() => {
    overridesRef.current = overrides;
  });

  const save = useCallback((changes: Record<string, readonly ShortcutCombo[] | null>) => {
    setSaveFailed(false);
    const next: ShortcutOverrides = nextOverrides(overridesRef.current, changes, platform);
    saveShortcutOverrides(next).catch(() => setSaveFailed(true));
  }, [platform]);

  const cancel = useCallback(() => setEditing(null), []);
  const start = useCallback((id: string) => {
    setSaveFailed(false);
    setEditing({ id, phase: "recording", held: {}, refused: null });
  }, []);

  const recordingId = editing?.phase === "recording" ? editing.id : null;
  // What one key does to the row being recorded: the next editing state, and the change to save (if any).
  const recordKey = useEffectEvent((event: KeyboardEvent) => {
    if (!recordingId) return;
    const result = recorderStep(recordingId, event, overridesRef.current, platform);
    if (result === undefined) return;
    setEditing(result.editing);
    if (result.save) save(result.save);
  });
  const recordModifiers = useEffectEvent((event: KeyboardEvent) => {
    if (!isModifierKey(event)) return;
    setEditing((current) => (current?.phase === "recording" ? { ...current, held: heldModifiers(event, platform) } : current));
  });
  useEffect(() => {
    if (!recordingId) return;
    setShortcutRecording(true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      recordKey(event);
    };
    // The panel's recorder, while a shortcut is being changed: every key is its own (Esc cancels); the binding button
    // it records for has the focus.
    // keydown-global-exempt: the shortcuts panel's recorder takes every key in the capture phase while recording; focus stays on the row's binding button
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", recordModifiers, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", recordModifiers, true);
      setShortcutRecording(false);
    };
  }, [recordingId]);

  // Held in a conflict: Esc is Cancel (not the panel's close); the notice's buttons have the focus.
  // The innermost layer while a conflict is held, before the panel's own Esc (both capture-phase).
  useShortcutLayer("panel", editing?.phase === "conflict", { phase: "capture", ignoreDefaultPrevented: true, onEscape: () => { setEditing(null); } });

  // A press outside the row being changed (its binding button, its notice) cancels.
  const editingId = editing?.id ?? null;
  useEffect(() => {
    if (!editingId) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(`[data-shortcut-editing="${CSS.escape(editingId)}"]`)) return;
      setEditing(null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [editingId]);

  const resolve = useCallback((how: "replace" | "swap") => {
    if (editing?.phase !== "conflict" || editing.problem.kind !== "conflict") return;
    if (how === "swap" && !editing.problem.canSwap) return;
    const changes = resolveConflict(editing.id, editing.combos, editing.problem.others.map((other) => other.id), how, overridesRef.current, platform);
    setEditing(null);
    save(changes);
  }, [editing, platform, save]);

  const reset = useCallback((id: string) => {
    setEditing(null);
    save({ [id]: null });
  }, [save]);

  const resetAll = useCallback(() => {
    setEditing(null);
    save(Object.fromEntries(Object.keys(overridesRef.current).map((id) => [id, null])));
  }, [save]);

  return { editing, saveFailed, start, cancel, resolve, reset, resetAll };
}
