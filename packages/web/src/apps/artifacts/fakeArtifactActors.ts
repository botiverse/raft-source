// The fake data source's people (fakeArtifactSource.ts): who writes, comments and is mentioned, the
// signed-in viewer, and who the dashboard's `author` filter names.
import { ARTIFACT_COMMENT_MAX_MENTIONS, ARTIFACT_DASHBOARD_AUTHORS_LIMIT, ARTIFACT_DASHBOARD_AUTHORS_MAX } from "@botiverse/raft-shared";
import type { ArtifactActor, ArtifactDashboardAuthor, ArtifactDashboardAuthorCandidate } from "@botiverse/raft-shared";

import type { ArtifactApiError } from "./artifactApi";

export const niko: ArtifactActor = { type: "agent", id: "fake-agent-niko", name: "niko", displayName: "Niko", avatarUrl: "pixel:fox" };
/** cindyz's personal assistant (`onBehalfOf`), as the server names one to a reader of its server. */
export const remy: ArtifactActor = {
  type: "agent", id: "fake-agent-remy", name: "remy", displayName: "Remy", avatarUrl: "pixel:catbot",
  onBehalfOf: { id: "fake-user-cindyz", name: "cindyz", displayName: "cindyz" },
};
export const xxchan: ArtifactActor = { type: "user", id: "fake-user-xxchan", name: "xxchan", displayName: "xxchan", avatarUrl: null };
export const cindy: ArtifactActor = { type: "user", id: "fake-user-cindyz", name: "cindyz", displayName: "cindyz", avatarUrl: null };
export const artin: ArtifactActor = { type: "user", id: "fake-user-artin", name: "artin", displayName: "artin", avatarUrl: null };
/** Lost access after the candidate list was loaded: posting a mention of it answers MENTION_NOT_VISIBLE. */
export const pico: ArtifactActor = { type: "agent", id: "fake-agent-pico", name: "pico", displayName: "Pico", avatarUrl: "pixel:frog" };
/** The signed-in viewer, for the fake. */
export const ME = xxchan;
/** The agents the viewer manages (it made Niko): the dashboard's `my-agents`. */
const MY_AGENTS: readonly ArtifactActor[] = [niko];
export const ACTORS: Record<string, ArtifactActor> = { niko, remy, xxchan, cindyz: cindy, artin, pico };
/** Who `@` offers, in this order: people, then agents. */
export const MENTION_CANDIDATES = [xxchan, cindy, artin, niko, remy, pico];
/**
 * A crew of people `@` finds only by name (`@crew`), so a comment can reach
 * the mention cap (ARTIFACT_COMMENT_MAX_MENTIONS) with the fake.
 */
const CREW: ArtifactActor[] = Array.from({ length: ARTIFACT_COMMENT_MAX_MENTIONS }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return { type: "user", id: `fake-user-crew${n}`, name: `crew${n}`, displayName: `crew${n}`, avatarUrl: null };
});
export const MENTIONABLE = [...MENTION_CANDIDATES, ...CREW];

export const actorKey = (actor: { type: string; id: string }) => `${actor.type}:${actor.id}`;

/**
 * The authors kept (actorKey; null: everyone), as the server reads `author`: `me`, `my-agents` (MY_AGENTS),
 * `user:<id>` or `agent:<id>`, at most ARTIFACT_DASHBOARD_AUTHORS_MAX, else 400 INVALID_REQUEST (the fake's ids
 * aren't uuids: any id is one).
 */
export function fakeAuthorKeys(values: readonly ArtifactDashboardAuthor[]): ReadonlySet<string> | null {
  if (values.length === 0) return null;
  const invalid = { status: 400, code: "INVALID_REQUEST" } satisfies ArtifactApiError;
  if (values.length > ARTIFACT_DASHBOARD_AUTHORS_MAX) throw invalid;
  const authors = new Set<string>();
  for (const value of values) {
    if (value === "me") authors.add(actorKey(ME));
    else if (value === "my-agents") for (const agent of MY_AGENTS) authors.add(actorKey(agent));
    else if (/^(user|agent):./.test(value)) authors.add(value);
    else throw invalid;
  }
  return authors;
}

/**
 * The author list as the server answers it: each author of what the reader sees once with how many, the most first
 * then by display name; `q` contained in the handle or the display name, any case; at most
 * ARTIFACT_DASHBOARD_AUTHORS_LIMIT.
 */
export function fakeAuthorCandidates(authors: readonly ArtifactActor[], query: string): ArtifactDashboardAuthorCandidate[] {
  const q = query.trim().toLowerCase();
  const counted = new Map<string, ArtifactDashboardAuthorCandidate>();
  for (const author of authors) counted.set(actorKey(author), { ...author, count: (counted.get(actorKey(author))?.count ?? 0) + 1 });
  return [...counted.values()]
    .filter((author) => q === "" || author.name.toLowerCase().includes(q) || author.displayName.toLowerCase().includes(q))
    .sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName) || a.name.localeCompare(b.name))
    .slice(0, ARTIFACT_DASHBOARD_AUTHORS_LIMIT);
}
