import type { ArtifactCard } from "@botiverse/raft-shared";

/**
 * Another server's reader of a public Artifact: the card's `fromAnotherServer` on a public home
 * (the server's readsAsOutsider, its accessOf `historyLimited` with no comments). The one question
 * for everything that differs for them, so no two places can disagree about who they are.
 */
export function readsAsOutsider(card: Pick<ArtifactCard, "home" | "fromAnotherServer">): boolean {
  return card.home.kind === "public" && card.fromAnotherServer === true;
}

/**
 * Whether the reader is a member of the Artifact's own server, not another
 * server's reader of its public link (readsAsOutsider's opposite).
 * Only a member gets what is the server's own (xxchan, the Artifacts feature
 * matrix): Download / Download All (Zip) and a file's Download, Follow, the
 * comment list, and other versions than the current one. Another server's
 * reader reads the current version only and forks it to comment: Fork in Raft
 * in the header (offersForkInRaft), and from the page's own comment button
 * (ArtifactPageForkProvider, useArtifactPageForkAsk). The public page offers
 * none of these either (PublicArtifactPage).
 */
export function readsInOwnServer(card: Pick<ArtifactCard, "home" | "fromAnotherServer">): boolean {
  return !readsAsOutsider(card);
}
