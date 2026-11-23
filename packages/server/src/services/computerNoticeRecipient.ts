import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { servers, users } from "../db/schema";
import { sanitizeClientName } from "./deviceAuthService";
import { isMember } from "./serverService";

/**
 * Who an email about something an owner or admin did to `userId`'s machine or
 * Computer on `serverId` may go to: still in the server, account not retired,
 * with an email address. Null otherwise (the audit event is the record).
 * `locale` is their display language, for an email that has its copy in it.
 */
export async function computerNoticeRecipient(serverId: string, userId: string, actorUserId: string) {
  if (!(await isMember(serverId, userId))) return null;
  const db = getDb();
  const [person] = await db.select({ email: users.email, name: users.name, displayName: users.displayName, displayLanguage: users.displayLanguage, retiredAt: users.retiredAt }).from(users).where(eq(users.id, userId));
  const [actor] = await db.select({ name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, actorUserId));
  const [server] = await db.select({ name: servers.name, slug: servers.slug }).from(servers).where(eq(servers.id, serverId));
  if (!person?.email || person.retiredAt || !actor || !server) return null;
  return {
    email: person.email,
    name: person.displayName || person.name,
    locale: person.displayLanguage,
    // A member-chosen name: no control or bidi characters in a mail from Raft.
    actorName: sanitizeClientName(actor.displayName || actor.name) ?? "An admin",
    server,
  };
}
