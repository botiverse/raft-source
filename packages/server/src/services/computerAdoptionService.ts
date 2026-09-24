// Computer adoption service — task #39 PR-J1 (RFC v0.8 v8.2 §5.11 / §10.13).
//
// One-time migration from legacy `sk_machine_*` to a fresh `sk_computer_*`
// principal. Authority depends on the selector: raw-key adoption proves
// possession of the old key; fingerprint adoption selects a row from the
// caller's user-scoped legacy roster; daemon-id adoption lets a Server actor
// with `manageMachines` select a row on that Server. On success, the machine
// row is marked migrated, a fresh Computer attachment is minted, and the
// legacy key is immediately invalidated (in-memory + behind a
// `legacyKeyMigratedAt` DB flag the WS / internal auth paths consult — Phase 3).
//
// Atomic adoption commit (§5.11.3): legacy key resolve, machine mark,
// Computer row create/restore, and `sk_computer_*` mint all happen in a
// single DB transaction. The `UPDATE ... WHERE legacy_key_migrated_at IS
// NULL RETURNING id` pattern is the concurrency guard — at most one caller
// wins; the loser sees no row and returns `legacy_machine_key_migrated`.
//
// Outcomes per §10.13:
//   - 201  ok                            valid authority + adoption/resume
//   - 401  legacy_key_invalid            unknown/wrong-server/malformed key
//   - 409  legacy_machine_key_migrated   key matches but machine already migrated
//   - 403  not_authorized                user not a member of the machine's server
//   - 403  requires_admin                 member lacks manageMachines
//   - 404  legacy_machine_not_found       daemon-id row absent from target Server
//   - 500  internal                      unexpected
//
// Raw key hygiene (§3.3.1): the raw `sk_machine_*` is read into memory once
// for argon2.verify and discarded. NEVER persisted, NEVER logged.

import { and, eq, isNull } from "drizzle-orm";
import argon2 from "argon2";
import { getDb } from "../db/index.js";
import { computers, machines, servers } from "../db/schema.js";
import { clearAuthCache, extractApiKeyPrefix } from "./machineService.js";
import { generateComputerApiKeyMaterial } from "./computerCredentialService.js";
import { isMember } from "./serverService.js";
import { actorHasServerCapabilityInServer, getActorServerRoleInServer } from "../lib/actorPermissions.js";
import { fenceMachinePrincipalConnections } from "../replicaRouter.js";

export type AdoptLegacyResult =
  | {
      ok: true;
      apiKey: string;        // raw sk_computer_* — returned exactly once
      computerId: string;
      machineId: string;
      serverId: string;
      resumed: boolean;
    }
  | {
      ok: false;
      code:
        | "legacy_key_invalid"
        | "legacy_machine_key_migrated"
        | "legacy_machine_not_found"
        | "not_authorized"
        | "requires_admin";
    };

type MatchedLegacyMachine = {
  id: string;
  serverId: string;
  userId: string | null;
  legacyKeyMigratedAt: Date | null;
  name: string;
};

export async function adoptLegacyMachine(input: {
  userId: string;
  legacyApiKey: string;
  name?: string;
}): Promise<AdoptLegacyResult> {
  // Auth middleware (packages/server/src/middleware/auth.ts) accepts both
  // sk_machine_* and the older sk_daemon_* prefix for backward compat, so a
  // real legacy daemon in the wild may be running on either. Accept both
  // here so the adoption path can migrate every legacy machine, not just the
  // sk_machine_* slice.
  if (
    !input.legacyApiKey.startsWith("sk_machine_") &&
    !input.legacyApiKey.startsWith("sk_daemon_")
  ) {
    return { ok: false, code: "legacy_key_invalid" };
  }

  // Resolve the legacy key directly against the DB — must NOT consult the
  // in-memory auth cache here. The cache exists to skip argon2 on hot-path
  // auth; using it during adoption would allow a stale entry to satisfy the
  // verify after some other actor has already marked the row migrated.
  const db = getDb();
  const prefix = extractApiKeyPrefix(input.legacyApiKey);
  const candidates = await db
    .select({
      id: machines.id,
      serverId: machines.serverId,
      userId: machines.userId,
      apiKeyHash: machines.apiKeyHash,
      legacyKeyMigratedAt: machines.legacyKeyMigratedAt,
      name: machines.name,
    })
    .from(machines)
    .where(eq(machines.apiKeyPrefix, prefix));

  let matchedMachine: MatchedLegacyMachine | null = null;
  for (const row of candidates) {
    try {
      if (await argon2.verify(row.apiKeyHash, input.legacyApiKey)) {
        matchedMachine = {
          id: row.id,
          serverId: row.serverId,
          userId: row.userId,
          legacyKeyMigratedAt: row.legacyKeyMigratedAt,
          name: row.name,
        };
        break;
      }
    } catch {
      continue;
    }
  }
  if (!matchedMachine) {
    return { ok: false, code: "legacy_key_invalid" };
  }

  return adoptMatchedLegacyMachine({
    userId: input.userId,
    matchedMachine,
    name: input.name,
    allowAlreadyMigratedResume: false,
  });
}

export async function adoptLegacyMachineByFingerprint(input: {
  userId: string;
  serverSlug: string;
  legacyMachineId: string;
  apiKeyFingerprint: string;
  name?: string;
}): Promise<AdoptLegacyResult> {
  if (!/^[a-f0-9]{16}$/i.test(input.apiKeyFingerprint)) {
    return { ok: false, code: "legacy_key_invalid" };
  }

  const db = getDb();
  const [serverRow] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.slug, input.serverSlug), isNull(servers.deletedAt)));
  if (!serverRow || !(await isMember(serverRow.id, input.userId))) {
    return { ok: false, code: "not_authorized" };
  }
  const [matchedMachine] = await db
    .select({
      id: machines.id,
      serverId: machines.serverId,
      userId: machines.userId,
      legacyKeyMigratedAt: machines.legacyKeyMigratedAt,
      name: machines.name,
    })
    .from(machines)
    .where(
      and(
        eq(machines.id, input.legacyMachineId),
        eq(machines.userId, input.userId),
        eq(machines.serverId, serverRow.id),
        eq(machines.apiKeyFingerprint, input.apiKeyFingerprint),
      ),
    );
  if (!matchedMachine) {
    return { ok: false, code: "legacy_key_invalid" };
  }

  return adoptMatchedLegacyMachine({
    userId: input.userId,
    matchedMachine,
    name: input.name,
    allowAlreadyMigratedResume: true,
  });
}

export async function adoptLegacyMachineByDaemonId(input: {
  userId: string;
  serverSlug: string;
  daemonId: string;
  name?: string;
}): Promise<AdoptLegacyResult> {
  const db = getDb();
  const [serverRow] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.slug, input.serverSlug), isNull(servers.deletedAt)));
  if (!serverRow || !(await isMember(serverRow.id, input.userId))) {
    return { ok: false, code: "not_authorized" };
  }
  const canRegisterMachines = await actorHasServerCapabilityInServer(
    serverRow.id,
    "user",
    input.userId,
    "registerMachines",
  );
  const [matchedMachine] = await db
    .select({
      id: machines.id,
      serverId: machines.serverId,
      userId: machines.userId,
      legacyKeyMigratedAt: machines.legacyKeyMigratedAt,
      name: machines.name,
    })
    .from(machines)
    .where(
      and(
        eq(machines.id, input.daemonId),
        eq(machines.serverId, serverRow.id),
      ),
    );
  if (!matchedMachine) {
    return { ok: false, code: canRegisterMachines ? "legacy_machine_not_found" : "requires_admin" };
  }
  if (
    matchedMachine.userId !== input.userId
    && !canRegisterMachines
  ) {
    return { ok: false, code: "requires_admin" };
  }

  return adoptMatchedLegacyMachine({
    userId: input.userId,
    matchedMachine,
    name: input.name,
    allowAlreadyMigratedResume: true,
  });
}

async function adoptMatchedLegacyMachine(input: {
  userId: string;
  matchedMachine: MatchedLegacyMachine;
  name?: string;
  allowAlreadyMigratedResume: boolean;
}): Promise<AdoptLegacyResult> {
  const db = getDb();
  const { matchedMachine } = input;

  // The server must still be live and the calling user must be a member of it
  // WITH the manageMachines capability (owner / admin). Raw-key adoption uses
  // key possession as machine authority; fingerprint adoption uses the
  // server's user-scoped legacy roster; daemon-id adoption uses the Server's
  // manageMachines capability and a row bound to that Server. All three still
  // mint a fresh sk_computer_* Computer attachment, so — like
  // /api/computer/attach — they
  // require the same role gate (tygg 2026-06-05 #wg-raft-computer): a plain
  // member must not adopt a legacy machine into a Computer attachment and so
  // bypass the attach gate. A member lacking the capability gets the distinct
  // `requires_admin` code (not an enumeration leak — they know they belong).
  const [serverRow] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, matchedMachine.serverId), isNull(servers.deletedAt)));
  if (!serverRow) {
    return { ok: false, code: "not_authorized" };
  }
  const role = await getActorServerRoleInServer(matchedMachine.serverId, "user", input.userId);
  if (!role) {
    return { ok: false, code: "not_authorized" };
  }
  if (
    matchedMachine.userId !== input.userId
    && !await actorHasServerCapabilityInServer(matchedMachine.serverId, "user", input.userId, "registerMachines")
  ) {
    return { ok: false, code: "requires_admin" };
  }

  // Raw-key replay remains a hard "already migrated" outcome so old machine
  // credentials cannot be reused. Roster-selected adoption is different: the
  // logged-in user may be retrying setup after server-side adoption committed
  // but local state did not finish. In that case rotate and return the
  // existing linked Computer attachment instead of forcing a legacy key.
  if (matchedMachine.legacyKeyMigratedAt) {
    if (!input.allowAlreadyMigratedResume) {
      return { ok: false, code: "legacy_machine_key_migrated" };
    }
    const [existing] = await db
      .select({ id: computers.id, serverId: computers.serverId })
      .from(computers)
      .where(and(eq(computers.machineId, matchedMachine.id), isNull(computers.revokedAt)));
    if (!existing) {
      return { ok: false, code: "legacy_machine_key_migrated" };
    }
    // The original migration already set `legacy_key_migrated_at` and ran
    // same-action auth-cache invalidation. Resume only rotates the Computer
    // credential, so there is no legacy auth cache left to clear here.
    const material = await generateComputerApiKeyMaterial();
    const desiredName = sanitizeAdoptedName(input.name, matchedMachine.name);
    await db
      .update(computers)
      .set({
        apiKeyHash: material.apiKeyHash,
        apiKeyPrefix: material.apiKeyPrefix,
        name: desiredName,
      })
      .where(eq(computers.id, existing.id));
    await fenceMachinePrincipalConnections(matchedMachine.id, "legacy_machine");
    return {
      ok: true,
      apiKey: material.apiKey,
      computerId: existing.id,
      machineId: matchedMachine.id,
      serverId: existing.serverId,
      resumed: true,
    };
  }

  const material = await generateComputerApiKeyMaterial();
  const desiredName = sanitizeAdoptedName(input.name, matchedMachine.name);

  try {
    const txResult = await db.transaction(async (tx) => {
      // Concurrency guard — atomic mark + select. Only the first caller to
      // flip legacy_key_migrated_at IS NULL → now() gets a row back; later
      // callers (same key, concurrent) see no row and we collapse them to
      // `legacy_machine_key_migrated`.
      const markRows = await tx
        .update(machines)
        .set({ legacyKeyMigratedAt: new Date() })
        .where(
          and(
            eq(machines.id, matchedMachine.id),
            isNull(machines.legacyKeyMigratedAt),
          ),
        )
        .returning({ id: machines.id });
      if (markRows.length === 0) {
        return { migrated: true as const };
      }

      // Resume: a still-live (not revoked) Computer attachment already linked
      // to this machineId — rotate its credential in place rather than
      // leaking a duplicate live attachment. This is defensive: in the
      // expected flow no prior Computer row exists for a legacy machine.
      const [existing] = await tx
        .select({ id: computers.id, serverId: computers.serverId })
        .from(computers)
        .where(
          and(
            eq(computers.machineId, matchedMachine.id),
            isNull(computers.revokedAt),
          ),
        );

      if (existing) {
        await tx
          .update(computers)
          .set({
            apiKeyHash: material.apiKeyHash,
            apiKeyPrefix: material.apiKeyPrefix,
            name: desiredName,
          })
          .where(eq(computers.id, existing.id));
        return {
          migrated: false as const,
          computerId: existing.id,
          serverId: existing.serverId,
          resumed: true,
        };
      }

      const [row] = await tx
        .insert(computers)
        .values({
          serverId: matchedMachine.serverId,
          name: desiredName,
          apiKeyHash: material.apiKeyHash,
          apiKeyPrefix: material.apiKeyPrefix,
          attachedByUserId: input.userId,
          machineId: matchedMachine.id,
        })
        .returning({ id: computers.id });

      return {
        migrated: false as const,
        computerId: row.id,
        serverId: matchedMachine.serverId,
        resumed: false,
      };
    });

    if (txResult.migrated) {
      return { ok: false, code: "legacy_machine_key_migrated" };
    }

    // Same-action cache invalidation (§5.11.3): legacy key must fail on
    // the very next auth attempt — no TTL window. The Phase 3 auth path
    // also consults `legacy_key_migrated_at` so a fresh DB read rejects;
    // clearing the cache eliminates the in-process gap.
    clearAuthCache(matchedMachine.id);
    await fenceMachinePrincipalConnections(matchedMachine.id, "legacy_machine");

    return {
      ok: true,
      apiKey: material.apiKey,
      computerId: txResult.computerId,
      machineId: matchedMachine.id,
      serverId: txResult.serverId,
      resumed: txResult.resumed,
    };
  } catch (err) {
    // Never include the raw key or its prefix in error surface.
    console.error("computerAdoption.adopt error:", err);
    throw err;
  }
}

function sanitizeAdoptedName(supplied: string | undefined, fallback: string): string {
  if (typeof supplied === "string") {
    const trimmed = supplied.trim();
    if (trimmed.length > 0 && trimmed.length <= 200) return trimmed;
  }
  if (fallback.length > 0 && fallback.length <= 200) return fallback;
  return "raft-computer";
}

// Exposed for tests + Phase 3 typing.
export function _isAdoptedMachineRow(row: { legacyKeyMigratedAt: Date | null }): boolean {
  return row.legacyKeyMigratedAt !== null;
}
