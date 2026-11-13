import type { IntlShape } from "react-intl";
import type { ArtifactShownActor } from "@botiverse/raft-shared";

import { useSignedInPersonId } from "../../store/signedInPerson";
import { artifactActorName } from "./artifactFacts";

/**
 * Who made an Artifact, in words (#proj-workspace:#133, design D17): the
 * reader's own as "You"; a personal assistant's as the assistant with whom it
 * worked for ("Ottie for you", "Friday for Remy", ArtifactActor `onBehalfOf`,
 * #12881); anyone else by name. ArtifactAuthor draws it.
 */

/** The reader, for naming their own work "You": who is signed in (an author's `id` is a user id). */
export function useArtifactReaderId(): string | null {
  return useSignedInPersonId();
}

export interface ArtifactAuthorText {
  /** "You", the assistant's name, or the author's. */
  name: string;
  /** "for you", "for Remy": only for someone's personal assistant. */
  behalf: string | null;
}

export function artifactAuthorText(actor: ArtifactShownActor, readerId: string | null, formatMessage: IntlShape["formatMessage"]): ArtifactAuthorText {
  if (actor.type === "user" && readerId !== null && actor.id === readerId && !actor.gone) {
    return { name: formatMessage({ id: "artifacts.author.you" }), behalf: null };
  }
  const name = artifactActorName(actor, formatMessage);
  const behalf = actor.type === "agent" && !actor.gone ? actor.onBehalfOf ?? null : null;
  if (!behalf) return { name, behalf: null };
  return {
    name,
    behalf: behalf.id === readerId
      ? formatMessage({ id: "artifacts.author.forYou" })
      : formatMessage({ id: "artifacts.author.forPerson" }, { name: behalf.displayName }),
  };
}

