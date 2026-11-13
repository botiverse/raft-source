import { useEffect } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useSearchContentStore } from "../../store/searchContentStore";
import type { SelectableSearchResult } from "./searchResultTypes";

/**
 * Single "active result" state — selectedResultKey, driven by keyboard
 * arrows AND click (via syncSelectedKey). Mirrors the pre-rail search
 * page: there is no separate "opened-in-slot" visual; clicking a card
 * makes it the selected card AND opens it in col 3. Reference: stdrc
 * msg=c1a7f1e2 (2026-05-27) "参考原来的搜索页面". Deep-link sync: when
 * the slot is restored from `?open=...&msg=...`, walk selectableResults
 * and point the selection identity at the matching card so the visual follows the
 * slot without a click.
 */
export function useSearchSlotSelectionSync({
  selectableResults,
  selectedIndexHintRef,
  setSelectedResultIdentity,
}: {
  selectableResults: SelectableSearchResult[];
  selectedIndexHintRef: RefObject<number>;
  setSelectedResultIdentity: Dispatch<SetStateAction<string | null>>;
}) {
  const slot = useSearchContentStore((s) => s.slot);
  useEffect(() => {
    if (!slot) return;
    // The rows are MessageSearchPage's (render-derived there); this hook is the page's own deep-link sync, moved verbatim.
    // oxlint-disable-next-line react-doctor/no-event-handler -- external deep-link slot restoration, not a handler: it nudges the selection once the matching row arrives.
    const match = selectableResults.findIndex((entry) => {
      if (entry.kind === "message") {
        const r = entry.result;
        if (r.channelType === "thread") {
          return slot.kind === "thread" && slot.messageId === r.id;
        }
        // A task's slot names the task and the hit opened (Search's); without a hit (a task ref
        // followed in it), the task's first hit.
        if (r.channelType === "task") return slot.kind === "task" && slot.id === r.taskId && (!slot.messageId || slot.messageId === r.id);
        const expectedKind = r.channelType === "dm" ? "dm" : "channel";
        return slot.kind === expectedKind && slot.messageId === r.id;
      }
      if (entry.kind !== "entity") return false;
      const e = entry.result;
      if (e.type === "channel") {
        return slot.kind === "channel" && slot.id === e.channelId && !slot.messageId;
      }
      if (e.type === "computer") {
        return slot.kind === "machine" && slot.id === e.machineId;
      }
      if (e.type === "agentDm") {
        return (slot.kind === "dm" && slot.id === e.channelId && !slot.messageId)
          || (slot.kind === "agent" && slot.id === e.agentId);
      }
      if (e.type === "humanDm") {
        return (slot.kind === "dm" && slot.id === e.channelId && !slot.messageId)
          || (slot.kind === "human" && slot.id === e.userId);
      }
      return false;
    });
    // Deep-link sync from external slot state — find the result matching
    // the currently-open slot and point selection at it. NOT a mirror-prop:
    // selection is user-driven (keyboard arrows + click)
    // and this effect only nudges it once on slot restore. Same async-arrival
    // recognition family as AddMembersDialog seed-on-list-arrival.
    if (match >= 0) {
      selectedIndexHintRef.current = match;
      // oxlint-disable-next-line react-doctor/no-derived-state -- external deep-link slot restoration intentionally selects the matching result identity once it arrives.
      setSelectedResultIdentity(selectableResults[match]?.key ?? null);
    }
  }, [slot, selectableResults, selectedIndexHintRef, setSelectedResultIdentity]);
}
