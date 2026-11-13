import { create } from "zustand";
import { ARTIFACT_ATTACHMENT_SAVES_MAX_IDS } from "@botiverse/raft-shared";
import type { ArtifactReference } from "@botiverse/raft-shared";

import { artifactSource } from "./artifactSource";

/**
 * What the attachments on screen were saved as (S5, F7), from the source's
 * `attachmentSaves` (messages carry nothing about Artifacts): null for one
 * not saved, or that this person can't see; absent until asked. Requests
 * made in the same tick go out together, ARTIFACT_ATTACHMENT_SAVES_MAX_IDS a
 * request. Kept for one server and person (`resetAttachmentSaves` on a
 * switch). No socket event says when someone else saves one: a line shows at
 * the next load, the saver's own at once (the save asks again).
 */
export const useAttachmentSaves = create<{ saves: Record<string, ArtifactReference | null> }>(() => ({ saves: {} }));

const pending = new Set<string>();
const inFlight = new Set<string>();
let scheduled = false;
/** Bumped by a reset: answers to requests made before it are dropped. */
let generation = 0;

async function flush(): Promise<void> {
  scheduled = false;
  const ids = [...pending];
  pending.clear();
  const asked = generation;
  for (let i = 0; i < ids.length; i += ARTIFACT_ATTACHMENT_SAVES_MAX_IDS) {
    const chunk = ids.slice(i, i + ARTIFACT_ATTACHMENT_SAVES_MAX_IDS);
    for (const id of chunk) inFlight.add(id);
    void artifactSource().attachmentSaves(chunk).then(
      ({ saves }) => {
        if (asked !== generation) return;
        const answered = new Map(saves.map((save) => [save.attachmentId, save.savedAs]));
        useAttachmentSaves.setState((state) => ({
          saves: { ...state.saves, ...Object.fromEntries(chunk.map((id) => [id, answered.get(id) ?? null])) },
        }));
      },
      // A failed lookup shows no line; the next mount asks again.
      () => {},
    ).finally(() => {
      if (asked === generation) for (const id of chunk) inFlight.delete(id);
    });
  }
}

/** Ask what these attachments were saved as; `again` asks even for ones already known. */
export function requestAttachmentSaves(attachmentIds: readonly string[], options: { again?: boolean } = {}): void {
  const known = useAttachmentSaves.getState().saves;
  for (const id of attachmentIds) {
    if (!options.again && (id in known || inFlight.has(id))) continue;
    pending.add(id);
  }
  if (pending.size === 0 || scheduled) return;
  scheduled = true;
  setTimeout(() => { void flush(); }, 0);
}

/** Forget every answer (a server or person switch, tests). */
export function resetAttachmentSaves(): void {
  generation += 1;
  pending.clear();
  inFlight.clear();
  useAttachmentSaves.setState({ saves: {} });
}
