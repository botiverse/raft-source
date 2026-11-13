import { ARTIFACT_DASHBOARD_AUTHORS_LIMIT } from "@botiverse/raft-shared";
import type { ArtifactActor, ArtifactDashboardAuthor, ArtifactShownActor } from "@botiverse/raft-shared";

/**
 * The home page's `author` filter values (#proj-workspace:#133; the contract is
 * #12881's ArtifactDashboardAuthor): the value that names one person or agent,
 * and a guard for strings that come from elsewhere (a picker's value, a stored
 * choice), so nothing but a well-formed value is sent (the server refuses others).
 */

/** The filter value that names one person or agent. */
export function authorValueOf(actor: Pick<ArtifactActor, "type" | "id">): ArtifactDashboardAuthor {
  return actor.type === "agent" ? `agent:${actor.id}` : `user:${actor.id}`;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ONE_AUTHOR = new RegExp(`^(user|agent):${UUID}$`, "i");

/**
 * Whether a string is an ArtifactDashboardAuthor as the contract has it: `me`,
 * `my-agents`, `user:<uuid>` or `agent:<uuid>` (an ArtifactActor's `id`), for a
 * string from outside the page (an address, a stored choice). The picker sends
 * only the values it built from the authors it was given (authorValueOf).
 */
export function isArtifactDashboardAuthor(value: unknown): value is ArtifactDashboardAuthor {
  return typeof value === "string" && (value === "me" || value === "my-agents" || ONE_AUTHOR.test(value));
}

/** The strings that are filter values, in order, each once. */
export function artifactDashboardAuthorsOf(values: readonly unknown[]): ArtifactDashboardAuthor[] {
  return [...new Set(values.filter(isArtifactDashboardAuthor))];
}

/** The authors of what is on screen, most frequent first. */
export function authorsOnScreen(actors: readonly ArtifactShownActor[]): ArtifactShownActor[] {
  const counts = new Map<string, { actor: ArtifactShownActor; count: number }>();
  for (const actor of actors) {
    if (!actor.id || actor.gone) continue;
    const key = authorValueOf({ type: actor.type, id: actor.id });
    const entry = counts.get(key) ?? { actor, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, ARTIFACT_DASHBOARD_AUTHORS_LIMIT).map((entry) => entry.actor);
}
