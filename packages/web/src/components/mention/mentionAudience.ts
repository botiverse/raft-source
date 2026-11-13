// Who an @ list may offer, and where the candidates come from.
//
// You can @ only people and agents who can see the object (a conversation, an
// Artifact). The server enforces it; the web names the audience and shows
// what the server answers.

import { mentionAudiencePaths } from "@botiverse/raft-shared";
import type { ArtifactActor, MentionAudience, MentionAudienceCandidates as MentionAudienceAnswer, MentionAudienceInput } from "@botiverse/raft-shared";

import api from "../../api/client";
import { artifactMentionCandidates } from "../../apps/artifacts";
import type { MentionCandidate } from "../message/mentionCandidates";

export { asFirstPartyAppId, asFirstPartyObjectId, asFirstPartyObjectKind } from "@botiverse/raft-shared";
export type { FirstPartyAppId, FirstPartyObjectId, FirstPartyObjectKind, MentionAudience } from "@botiverse/raft-shared";

/**
 * Where a picker's candidates come from:
 * - `local`: already loaded (chat's members); no requests, the order kept.
 * - `audience`: asked of the server each time the list opens (no cache across
 *   opens, so a narrowed audience applies at once), then filtered here as the
 *   name is typed; asked again by `q` when the answer was capped.
 */
export type MentionSource = { local: readonly MentionCandidate[] } | { audience: MentionAudience };

/**
 * The server's answer for an audience, as the picker reads it: with `q` empty, `capped` says
 * whether more were left out. Shared's answer of the same name carries `MentionAudienceActor`s
 * (with `guest`); they are mapped to `MentionCandidate`s here.
 */
export interface MentionAudienceCandidates {
  candidates: MentionCandidate[];
  capped: boolean;
}

/** Stable identity of an audience, for effects and request keys. */
export function mentionAudienceKey(audience: MentionAudience): string {
  return audience.kind === "conversation"
    ? `conversation:${audience.channelId}`
    : `object:${audience.app}:${audience.objectKind}:${audience.objectId}`;
}

export function mentionCandidateFromActor(actor: ArtifactActor): MentionCandidate {
  return { id: actor.id, type: actor.type, name: actor.name, displayName: actor.displayName, avatarUrl: actor.avatarUrl };
}

// The client's base already ends in `/api`.
const AUDIENCE_ROUTE = mentionAudiencePaths.audience().replace(/^\/api(?=\/)/, "");

/**
 * The candidates for an audience matching `q`, from core's audience route
 * (`POST /api/mentions/audience`; 404 NOT_FOUND for any audience the reader
 * can't use). An Artifact is asked through its app's data source, which calls
 * the same route, so the fake answers it in tests and the fake dev build.
 */
export async function fetchMentionAudienceCandidates(audience: MentionAudience, q: string): Promise<MentionAudienceCandidates> {
  if (audience.kind === "object" && audience.app === "artifacts" && audience.objectKind === "artifact") {
    const answer = await artifactMentionCandidates(audience.objectId, q);
    // The source's type leaves `capped` optional (the fake and test doubles may omit it): ask again by `q`.
    return { candidates: answer.candidates.map(mentionCandidateFromActor), capped: answer.capped ?? true };
  }
  const input: MentionAudienceInput = { audience, q };
  const { data } = await api.post<MentionAudienceAnswer>(AUDIENCE_ROUTE, input);
  return { candidates: data.candidates.map(mentionCandidateFromActor), capped: data.capped };
}
