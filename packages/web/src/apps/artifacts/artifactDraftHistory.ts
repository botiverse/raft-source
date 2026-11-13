import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactComment, ArtifactCommentDraft, ArtifactCommentDraftId, ArtifactCommentId, ArtifactCommentPart, ObjectFileId } from "@botiverse/raft-shared";

/**
 * Undo and redo of the person's draft changes on one Artifact, for as long as its viewer is open
 * (#proj-workspace:#148, xxchan's final mockup). Client-side: each step is replayed through the
 * drafts' own routes (create, edit, delete), so the server keeps no history.
 *
 * - A draft saved ↔ deleted; a draft edited ↔ its body before; a draft deleted ↔ made again with
 *   the same version, place (its anchor is data the draft keeps), reply and body. A draft made
 *   again gets a new id from the server: every step about it follows its `DraftHandle`, not the id.
 * - Not kept: anything about a draft with images (#proj-workspace:#146: deleting it lets its
 *   uploads go, so it can't be made again as it was; a draft's images are set when it is made, so
 *   a draft has them for its whole life). Its making, edits and deletion are never recorded, so no
 *   step ever undoes into a draft without them; nothing in the UI says so. Nor sending (Send N) and
 *   Discard All, which can't be undone and clear the history.
 * - A step that fails (the draft gone in another tab, a version gone, the 50-draft cap) is dropped
 *   with a toast; the history stays otherwise. One step at a time (`busy`).
 * - A deletion's toast undoes its own deletion, whatever came since (`undoStep`, as Gmail's
 *   Undo: making a deleted draft again is safe out of order): the draft is made again and that
 *   step leaves the history, so ⌘Z never brings it back twice and the newer steps stay as they
 *   are. The toast closes once its step is gone (`watch`): ⌘Z undid it, a clear (Send N, Discard
 *   All), the viewer closing. Other drafts changing leave it open.
 */

/** What a draft is made of, enough to make it again. */
interface DraftHandle {
  id: ArtifactCommentDraftId;
  version: number;
  target: ArtifactComment["target"];
  replyTo: ArtifactCommentId | null;
  body: ArtifactCommentPart[];
}

type DraftStep =
  | { kind: "create"; draft: DraftHandle }
  | { kind: "edit"; draft: DraftHandle; before: ArtifactCommentPart[]; after: ArtifactCommentPart[] }
  | { kind: "delete"; draft: DraftHandle };

/** The drafts' writes, as the review context makes them (each updates its drafts), never recorded. */
export interface DraftWrites {
  /** `images`: the person's uploads for a new draft (never in a step: a draft with images isn't recorded). */
  create: (draft: Omit<DraftHandle, "id"> & { images?: ObjectFileId[] }) => Promise<ArtifactCommentDraft>;
  edit: (draftId: ArtifactCommentDraftId, body: ArtifactCommentPart[]) => Promise<void>;
  remove: (draftId: ArtifactCommentDraftId) => Promise<void>;
}

/** One recorded change, as a handle: what `deleted` recorded, for `undoStep` (a toast's own Undo). */
export type DraftHistoryStep = Readonly<DraftStep>;

export interface DraftHistory {
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  /** A change the person made, recorded (it clears what could be redone). */
  created: (draft: ArtifactCommentDraft) => void;
  edited: (before: ArtifactCommentDraft, after: ArtifactCommentDraft) => void;
  /** The deletion's step (null: not recorded, a draft with images). */
  deleted: (draft: ArtifactCommentDraft) => DraftHistoryStep | null;
  clear: () => void;
  /** Whether the step went through (false: nothing to do, or it failed and was dropped). */
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
  /**
   * A deletion's toast's Undo: `step` (a deletion) undone wherever it is in the history, newer
   * steps or not: the draft made again as it was (version, place, reply, body), and the step taken
   * out of the history (not onto redo), so ⌘Z never makes it again and newer steps stay. Only while
   * the step is still there to undo (not undone by ⌘Z, the history not cleared). A failure is said
   * as any undo's (the step dropped). The draft's new id once made again, else null.
   */
  undoStep: (step: DraftHistoryStep) => Promise<ArtifactCommentDraftId | null>;
  /**
   * Calls `stale` once `step` is no longer in the history to undo (⌘Z undid it, `undoStep` did, the
   * history cleared, the viewer closed): a deletion's toast closes then. The returned function stops
   * watching.
   */
  watch: (step: DraftHistoryStep, stale: () => void) => () => void;
}

/** At most this many steps back. */
const MAX_STEPS = 60;

/** A draft with images: none of its changes is recorded (see above). */
const hasImages = (draft: Pick<ArtifactCommentDraft, "images">) => (draft.images?.length ?? 0) > 0;

export function useDraftHistory(writes: DraftWrites, onFailed: (direction: "undo" | "redo") => void): DraftHistory {
  const stacks = useRef<{ undo: DraftStep[]; redo: DraftStep[] }>({ undo: [], redo: [] });
  const handles = useRef(new Map<ArtifactCommentDraftId, DraftHandle>());
  // What renders reads: the stacks' sizes and whether a step is running (the stacks are refs, changed in handlers).
  const [counts, setCounts] = useState({ undo: 0, redo: 0 });
  // Steps a toast offers to undo, each with what to do once it is no longer there to undo.
  const watched = useRef(new Map<DraftHistoryStep, () => void>());
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const counted = useCallback(() => {
    setCounts({ undo: stacks.current.undo.length, redo: stacks.current.redo.length });
    for (const [step, stale] of watched.current) {
      if (stacks.current.undo.includes(step as DraftStep)) continue;
      watched.current.delete(step);
      stale();
    }
  }, []);
  const watch = useCallback((step: DraftHistoryStep, stale: () => void) => {
    if (!stacks.current.undo.includes(step as DraftStep)) {
      stale();
      return () => {};
    }
    watched.current.set(step, stale);
    return () => { watched.current.delete(step); };
  }, []);
  // The viewer closed: nothing here can be undone any more.
  useEffect(() => {
    const all = watched.current;
    return () => {
      for (const stale of all.values()) stale();
      all.clear();
    };
  }, []);

  const handleOf = useCallback((draft: ArtifactCommentDraft): DraftHandle => {
    const known = handles.current.get(draft.id);
    if (known) return known;
    const handle: DraftHandle = { id: draft.id, version: draft.version, target: draft.target, replyTo: draft.replyTo ?? null, body: draft.body };
    handles.current.set(draft.id, handle);
    return handle;
  }, []);
  const record = useCallback((step: DraftStep): DraftStep => {
    stacks.current.undo.push(step);
    if (stacks.current.undo.length > MAX_STEPS) stacks.current.undo.shift();
    stacks.current.redo = [];
    counted();
    return step;
  }, [counted]);
  const created = useCallback((draft: ArtifactCommentDraft) => {
    // Undone it would be deleted, its uploads with it: redone, it would come back without them.
    if (hasImages(draft)) return;
    record({ kind: "create", draft: handleOf(draft) });
  }, [record, handleOf]);
  const edited = useCallback((before: ArtifactCommentDraft, after: ArtifactCommentDraft) => {
    if (hasImages(before) || hasImages(after)) return;
    const handle = handleOf(before);
    handle.body = after.body;
    record({ kind: "edit", draft: handle, before: before.body, after: after.body });
  }, [record, handleOf]);
  const deleted = useCallback((draft: ArtifactCommentDraft): DraftHistoryStep | null => {
    // Its uploads go with it: it can't be made again as it was.
    if (hasImages(draft)) return null;
    return record({ kind: "delete", draft: handleOf(draft) });
  }, [record, handleOf]);
  const clear = useCallback(() => {
    stacks.current = { undo: [], redo: [] };
    handles.current.clear();
    counted();
  }, [counted]);

  const { create, edit, remove } = writes;
  const makeAgain = useCallback(async (handle: DraftHandle) => {
    const draft = await create({ version: handle.version, target: handle.target, replyTo: handle.replyTo, body: handle.body });
    handles.current.delete(handle.id);
    handle.id = draft.id;
    handles.current.set(draft.id, handle);
  }, [create]);
  const apply = useCallback(async (step: DraftStep, direction: "undo" | "redo") => {
    const { draft } = step;
    switch (step.kind) {
      case "create":
        return direction === "undo" ? remove(draft.id) : makeAgain(draft);
      case "delete":
        return direction === "undo" ? makeAgain(draft) : remove(draft.id);
      case "edit": {
        const body = direction === "undo" ? step.before : step.after;
        await edit(draft.id, body);
        draft.body = body;
      }
    }
  }, [edit, remove, makeAgain]);
  const move = useCallback(async (direction: "undo" | "redo"): Promise<boolean> => {
    if (running.current) return false;
    const from = direction === "undo" ? stacks.current.undo : stacks.current.redo;
    const step = from.pop();
    if (!step) return false;
    running.current = true;
    setBusy(true);
    try {
      await apply(step, direction);
      (direction === "undo" ? stacks.current.redo : stacks.current.undo).push(step);
      return true;
    } catch {
      onFailed(direction);
      return false;
    } finally {
      running.current = false;
      setBusy(false);
      counted();
    }
  }, [apply, onFailed, counted]);
  const undo = useCallback(() => move("undo"), [move]);
  const redo = useCallback(() => move("redo"), [move]);
  const undoStep = useCallback(async (step: DraftHistoryStep): Promise<ArtifactCommentDraftId | null> => {
    const at = stacks.current.undo.indexOf(step as DraftStep);
    if (running.current || at < 0 || step.kind !== "delete") return null;
    // Out of the history first (made again by a toast, it is no step of ⌘Z's), newer steps kept in order.
    stacks.current.undo.splice(at, 1);
    running.current = true;
    setBusy(true);
    try {
      await makeAgain(step.draft);
      // makeAgain moved the handle to the new draft's id.
      return step.draft.id;
    } catch {
      onFailed("undo");
      return null;
    } finally {
      running.current = false;
      setBusy(false);
      counted();
    }
  }, [makeAgain, onFailed, counted]);

  return useMemo(() => ({
    canUndo: counts.undo > 0,
    canRedo: counts.redo > 0,
    busy,
    created,
    edited,
    deleted,
    clear,
    undo,
    redo,
    undoStep,
    watch,
  }), [counts, busy, created, edited, deleted, clear, undo, redo, undoStep, watch]);
}
