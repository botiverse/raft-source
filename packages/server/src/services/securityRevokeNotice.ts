// One email per security-revoke cascade that revoked anything
// (securityRevokeCascade.ts): to each person whose sessions' Computers or
// agent keys it revoked, with how many, and where to set them up again.
//
// No duplicates by construction: an item is counted only by the run whose
// conditional UPDATE (`revoked_at IS NULL`, or a legacy machine's key still
// naming the family) flipped it, so a rerun, a retry or the hourly repair
// counts and mails only what it revoked itself, and a run that revoked nothing
// mails nothing. Never one email per machine. Not sent to a retired account
// (it is gone; what it set up went with it).

import { inArray } from "drizzle-orm";
import { getDb } from "../db/index";
import { servers, users } from "../db/schema";
import { sendSecurityRevokeEmail, type SecurityRevokeEmailServer, type SecurityRevokeEmailTrigger } from "./emailService";

type PersonTally = { computers: number; keys: number; serverIds: Set<string> };

/** What one cascade run revoked, per person whose session it was. */
export class SecurityRevokeTally {
  private readonly byPerson = new Map<string, PersonTally>();

  private of(userId: string): PersonTally {
    let tally = this.byPerson.get(userId);
    if (!tally) {
      tally = { computers: 0, keys: 0, serverIds: new Set() };
      this.byPerson.set(userId, tally);
    }
    return tally;
  }

  /** A Computer disconnected (a Computer key revoked, or a legacy machine key discarded). */
  computer(userId: string | null, serverId: string | null): void {
    if (!userId) return;
    const tally = this.of(userId);
    tally.computers += 1;
    if (serverId) tally.serverIds.add(serverId);
  }

  /** An agent key revoked (not a Computer's runner credentials: those go with their Computer). */
  key(userId: string | null, serverId: string | null): void {
    if (!userId) return;
    const tally = this.of(userId);
    tally.keys += 1;
    if (serverId) tally.serverIds.add(serverId);
  }

  /** Totals across everyone in this run, for the run's trace event (counts only, no ids). */
  totals(): { people: number; computers: number; keys: number; servers: number } {
    const people = this.people();
    return {
      people: people.length,
      computers: people.reduce((sum, [, tally]) => sum + tally.computers, 0),
      keys: people.reduce((sum, [, tally]) => sum + tally.keys, 0),
      servers: new Set(people.flatMap(([, tally]) => [...tally.serverIds])).size,
    };
  }

  people(): Array<[string, PersonTally]> {
    return [...this.byPerson.entries()].filter(([, tally]) => tally.computers > 0 || tally.keys > 0);
  }
}

/** Sends each person in the tally one email. Logged, not thrown: the revokes have committed. */
export async function sendSecurityRevokeNotices(tally: SecurityRevokeTally, trigger: SecurityRevokeEmailTrigger): Promise<void> {
  const people = tally.people();
  if (people.length === 0) return;
  try {
    const db = getDb();
    const recipients = await db
      .select({ id: users.id, email: users.email, name: users.displayName, username: users.name, retiredAt: users.retiredAt })
      .from(users)
      .where(inArray(users.id, people.map(([userId]) => userId)));
    const serverIds = [...new Set(people.flatMap(([, person]) => [...person.serverIds]))];
    const serverRows = serverIds.length === 0 ? [] : await db
      .select({ id: servers.id, name: servers.name, slug: servers.slug })
      .from(servers)
      .where(inArray(servers.id, serverIds));
    const serverOf = new Map(serverRows.map((server) => [server.id, server]));
    const recipientOf = new Map(recipients.map((recipient) => [recipient.id, recipient]));
    for (const [userId, person] of people) {
      const recipient = recipientOf.get(userId);
      if (!recipient || recipient.retiredAt || !recipient.email) continue;
      const affected: SecurityRevokeEmailServer[] = [...person.serverIds]
        .map((id) => serverOf.get(id))
        .filter((server): server is NonNullable<typeof server> => Boolean(server))
        .map((server) => ({ name: server.name, slug: server.slug }))
        .sort((a, b) => a.name.localeCompare(b.name));
      try {
        await sendSecurityRevokeEmail(recipient.email, recipient.name || recipient.username, {
          trigger,
          computers: person.computers,
          keys: person.keys,
          servers: affected,
        });
      } catch (err) {
        console.error(`[security-revoke] notice to ${userId} failed:`, err);
      }
    }
  } catch (err) {
    console.error("[security-revoke] notices failed:", err);
  }
}
