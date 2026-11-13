import type { Response } from "express";
import * as channelService from "../services/channelService";

/**
 * The single body used BOTH for "this channel does not exist" and for "it exists
 * but you have no prior relationship with it".
 *
 * These two must be byte-identical or the pair is an existence oracle: a stranger
 * enumerating channel ids would learn which are real. Sharing one constant is
 * what makes them identical BY CONSTRUCTION -- when they were two literals in two
 * branches, keeping them equal was a rule someone had to remember, and a status
 * code that merely matches while the `code`/`error` differs is still an oracle.
 *
 * The wording is deliberately NEUTRAL -- it asserts neither "does not exist" nor
 * "you lack permission". Both would be a lie to one of the two populations that
 * receive it, and the plain "Channel not found" was a lie to the ex-member who
 * knows perfectly well that it does. @Tenny's harm-reduction option; the CLI
 * already reached the same phrasing independently (`cli/src/commands/channel/
 * info.ts:49`). Privacy is unaffected because both callers get this same body,
 * byte for byte -- neutrality is not what protects here, identity is.
 *
 * Task #48, @Tenny's ruling in #proj-activity:b3ffd225 (`f0a31e7f`).
 */
export const CHANNEL_NOT_FOUND_BODY = { error: "Channel not found or not visible" } as const;

/**
 * Answer a denied channel access without disclosing existence to a stranger.
 *
 * ```
 * caller has prior relationship (server's own records)  -> 403, unchanged wording
 * caller has none                                       -> 404, byte-identical to missing
 * ```
 *
 * The 403 half is not a leftover: an ex-member already knows the channel exists,
 * so the honest answer discloses nothing, and it is what lets them clear a stale
 * Activity entry. Collapsing everything to 404 would close the leak by breaking
 * that -- which is the option the ruling explicitly rejected.
 *
 * `forbiddenError` keeps each site's existing 403 string, so no caller-visible
 * wording changes for the population that still gets a 403.
 */
export async function denyChannelAccess(
  res: Response,
  userId: string,
  channelId: string,
  forbiddenError: string,
): Promise<void> {
  if (await channelService.hasPriorChannelRelationship(userId, channelId)) {
    res.status(403).json({ error: forbiddenError });
    return;
  }
  res.status(404).json(CHANNEL_NOT_FOUND_BODY);
}
