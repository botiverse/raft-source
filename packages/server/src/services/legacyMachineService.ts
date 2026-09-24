/**
 * Legacy machine roster — RFC v9.9 §X.2 server-side intersection source.
 *
 * The Raft Computer setup picker (`packages/computer/src/lib/migration.ts`)
 * needs to know which legacy `sk_machine_*` daemons on this host belong to
 * the logged-in user on the target server, so it can intersect that roster
 * with the local `<installRoot>/machines/machine-<fp>/owner.json` evidence and
 * present only mutually-known candidates as migration targets.
 *
 * Local evidence: each legacy daemon writes `apiKeyFingerprint =
 * sha256(apiKey).slice(0,16)` into its `owner.json` (`packages/daemon/src/
 * machineLock.ts`). The same fingerprint is now stored on `daemons.
 * api_key_fingerprint` (backfilled at handshake — see `findMachineByApiKey`
 * in `machineService.ts`). The picker's intersection key is the fingerprint.
 *
 * Filter contract (RFC v9.9 §X.2 + Cody msg=ec68c27f redline + Jianwei
 * msg=a87a44a9 QA pin):
 *   - userId      = JWT-resolved caller
 *   - serverId    = caller-supplied target server (slug → id, member-gated)
 *   - apiKeyFingerprint NOT NULL by default (NULL rows are pre-handshake
 *     legacy and CANNOT participate in intersection)
 *   - includeAll=true adds NULL-fingerprint rows for server-side manual
 *     selection and redacts fingerprint bytes from the response shape.
 *
 * Already-adopted rows remain in the roster. Setup can lose local state after
 * the server commits migration but before the Computer writes its local
 * credential; including the migrated row lets fingerprint adoption resume the
 * existing linked Computer instead of silently fresh-attaching a duplicate.
 * Raw legacy-key replay is still rejected by the adoption service.
 *
 * SECRET REDLINE:
 *   - SELECT whitelist below — never SELECT apiKeyHash / apiKeyPrefix.
 *   - apiKeyFingerprint is key-derived; only emitted from this scoped
 *     authenticated endpoint. Never logged.
 *   - daemons.id (display id) and machine name are the user-visible
 *     identifiers; apiKeyFingerprint is the join key only.
 *
 * Anti-enumeration (Cody msg=ce91881f):
 *   - Server doesn't exist, soft-deleted, or user not a member → identical
 *     `not_authorized` response. The route maps this to a stable 403 body
 *     so an attacker cannot probe slug existence.
 */
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { machines, servers } from "../db/schema.js";
import { isMember } from "./serverService.js";

export interface LegacyMachineRosterEntry {
  /** server `daemons.id` — display + post-migration identity. NOT a join key. */
  daemonId: string;
  /** sha256(apiKey).slice(0,16) — intersection key against local owner.json. */
  apiKeyFingerprint?: string;
  /** True when the server row has an intersection fingerprint on file. */
  hasFingerprint: boolean;
  /** Display name. */
  machineName: string;
  /** Last reported hostname (display only — may be empty for legacy rows). */
  hostname: string | null;
  /** ISO last-seen timestamp (server-internal column `last_heartbeat` —
   * never leak that name into the wire shape). */
  lastSeenAt: string | null;
  /** ISO timestamp when the legacy key was consumed, if already migrated. */
  legacyKeyMigratedAt: string | null;
}

export type LegacyMachineRosterResult =
  | { ok: true; entries: LegacyMachineRosterEntry[] }
  | { ok: false; code: "not_authorized" };

export async function listLegacyMachineRoster(input: {
  userId: string;
  serverSlug: string;
  includeAll?: boolean;
}): Promise<LegacyMachineRosterResult> {
  const db = getDb();

  // Resolve target server. Soft-deleted, missing, or non-member all
  // collapse to a single `not_authorized` (anti-enumeration).
  const [server] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.slug, input.serverSlug), isNull(servers.deletedAt)));
  if (!server) return { ok: false, code: "not_authorized" };
  if (!(await isMember(server.id, input.userId))) {
    return { ok: false, code: "not_authorized" };
  }

  // SELECT whitelist — never expose hash / prefix.
  const rows = await db
    .select({
      id: machines.id,
      apiKeyFingerprint: machines.apiKeyFingerprint,
      name: machines.name,
      hostname: machines.hostname,
      lastHeartbeat: machines.lastHeartbeat,
      legacyKeyMigratedAt: machines.legacyKeyMigratedAt,
    })
    .from(machines)
    .where(
      and(
        eq(machines.userId, input.userId),
        eq(machines.serverId, server.id),
        ...(input.includeAll ? [] : [isNotNull(machines.apiKeyFingerprint)]),
      ),
    )
    .orderBy(asc(machines.createdAt));

  const entries: LegacyMachineRosterEntry[] = rows.map((row) => {
    const entry: LegacyMachineRosterEntry = {
      daemonId: row.id,
      hasFingerprint: row.apiKeyFingerprint !== null,
      machineName: row.name,
      hostname: row.hostname,
      lastSeenAt: row.lastHeartbeat ? row.lastHeartbeat.toISOString() : null,
      legacyKeyMigratedAt: row.legacyKeyMigratedAt ? row.legacyKeyMigratedAt.toISOString() : null,
    };
    if (!input.includeAll) {
      // isNotNull guard above guarantees this is a string in the default
      // auto-match roster shape. includeAll is the manual-pick shape and
      // deliberately redacts fingerprint bytes for every row.
      entry.apiKeyFingerprint = row.apiKeyFingerprint as string;
    }
    return entry;
  });

  return { ok: true, entries };
}
