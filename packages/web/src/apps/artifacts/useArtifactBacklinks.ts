import { createContext, useContext, useEffect, useState } from "react";
import type { ArtifactId, ArtifactWebBacklinks, ChannelId } from "@botiverse/raft-shared";

import type { ArtifactBacklinksPlace, NamedBacklinkMessage } from "./artifactBacklinksModel";
import { artifactShareHost } from "./artifactShareHost";
import type { ArtifactHostConversation } from "./artifactShareHost";
import { artifactSource } from "./artifactSource";

/**
 * What links to Artifact `id`, for this reader ("Linked from", #proj-workspace:#336 step 2): the
 * backlinks route's answer through the Artifacts source (ArtifactSource `backlinks`), asked once per
 * Artifact, not per version shown (what links to it is the Artifact's, not a version's), and not
 * again on focus. Null while it is asked, and for a refusal, a failure or an answer not of its shape:
 * the viewer then says nothing (quiet, Kirby). A source without the route (the fake) answers none.
 */
export function useArtifactBacklinks(id: ArtifactId): ArtifactWebBacklinks | null {
  const [answer, setAnswer] = useState<{ id: ArtifactId; backlinks: ArtifactWebBacklinks } | null>(null);
  useEffect(() => {
    const reading = artifactSource().backlinks?.(id);
    if (!reading) return;
    let cancelled = false;
    reading.then((backlinks) => {
      if (cancelled || !Array.isArray(backlinks?.documents?.items) || !Array.isArray(backlinks?.discussions?.items)) return;
      setAnswer({ id, backlinks });
    }, () => {
      // Nothing is said: no strip, no chip.
    });
    return () => { cancelled = true; };
  }, [id]);
  return answer?.id === id ? answer.backlinks : null;
}

const nameNone = (_conversationId: ChannelId): ArtifactHostConversation | null => null;
const useNoConversationNames = () => nameNone;

/**
 * Names a conversation as the reader's own channel list has it (the share host's
 * `useConversationNames`, core's lookup), null where it can't; a host without one names none, so no
 * discussion is listed or counted.
 */
export function useBacklinkConversationNames(): (conversationId: ChannelId) => ArtifactHostConversation | null {
  // The host is registered once, before anything renders: the same hook on every render.
  const useConversationNames = artifactShareHost().useConversationNames ?? useNoConversationNames;
  return useConversationNames();
}

/**
 * "Linked from" in a surface, while there is something to say (artifactBacklinksModel `backlinksShown`):
 * the answer, where it goes for the file shown (`place`), and its one open state (closed at first,
 * never remembered). ArtifactBacklinksProvider provides it; null elsewhere, and while there is
 * nothing to say, so every part draws nothing then.
 */
export interface ArtifactBacklinksState {
  backlinks: ArtifactWebBacklinks;
  /** The discussions listed: those on the page whose conversation the reader's own channel list names, in order. */
  discussions: readonly NamedBacklinkMessage[];
  /** The count as said ("12", "999+"): of what the reader is shown (artifactBacklinksModel `backlinksTotal`). */
  countText: string;
  place: ArtifactBacklinksPlace;
  /** A phone's layout: the strip opens a bottom sheet instead of the section above it. */
  phone: boolean;
  /** The strip's section (a desktop) or sheet (a phone) is open. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The title's chip: opens the strip's section or sheet, or scrolls to the block under the content and focuses it. */
  reveal: () => void;
  /** Each press of the chip that opened the strip's section, counted: the section takes focus on each. */
  revealed: number;
  /** The block under the content (place `below`), which the chip scrolls to: its callback ref. */
  setBlock: (element: HTMLElement | null) => void;
  /** The strip's button, its callback ref: where a row in the sheet (a portal) opens from, and where focus goes back. */
  setStrip: (element: HTMLButtonElement | null) => void;
  /** The strip's button, when drawn (read in a handler, never while rendering). */
  strip: () => HTMLButtonElement | null;
}

export const ArtifactBacklinksContext = createContext<ArtifactBacklinksState | null>(null);

export function useArtifactBacklinksHere(): ArtifactBacklinksState | null {
  return useContext(ArtifactBacklinksContext);
}

/**
 * How a discussion's message opens from the viewer, as the shell opens the original message
 * (ArtifactSurfaceMeta's `replace` and `onOpened`): in place of the history entry on a phone, where
 * the viewer is a page of its own; `onOpened`, the side card closing where it covers its channel.
 * The viewer provides it around its content; the Artifact's own page keeps the default.
 */
export interface ArtifactMessageOpening {
  replace: boolean;
  onOpened?: () => void;
}

export const ArtifactMessageOpeningContext = createContext<ArtifactMessageOpening>({ replace: false });
