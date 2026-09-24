import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index.js";
import {
  agents,
  labDefinitions,
  serverAgentMembers,
  serverLabAccess,
  serverLabAuditEvents,
  serverLabEnrollments,
  serverMembers,
  servers,
} from "../db/schema.js";
import {
  actorRoleHasServerCapability,
  getActorServerRoleInServer,
} from "../lib/actorPermissions.js";

export type ServerLabActor = {
  type: "human" | "agent";
  id: string;
};

export type ServerLabCatalogState = "draft" | "open" | "paused" | "retired";

export type ServerLabReadItem = {
  labKey: string;
  name: string;
  description: string;
  state: ServerLabCatalogState;
  enrolled: boolean;
  effective: boolean;
  updatedAt: Date | null;
};

export type ServerLabsReadModel = {
  serverId: string;
  accessEnabled: boolean;
  version: number;
  canManageAccess: boolean;
  canManageEnrollments: boolean;
  labs: ServerLabReadItem[];
};

export type ServerLabMutationResult = {
  applied: boolean;
  auditEventId: string | null;
  labs: ServerLabsReadModel;
};

export type ServerLabServiceErrorCode =
  | "SERVER_NOT_FOUND"
  | "SERVER_MEMBERSHIP_REQUIRED"
  | "SERVER_OWNER_REQUIRED"
  | "SERVER_ADMIN_REQUIRED"
  | "SERVER_LABS_VERSION_CONFLICT"
  | "SERVER_LABS_ACCESS_DISABLED"
  | "LAB_NOT_FOUND"
  | "LAB_NOT_OPEN";

export class ServerLabServiceError extends Error {
  constructor(
    readonly code: ServerLabServiceErrorCode,
    message: string,
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "ServerLabServiceError";
  }
}

type ServerLabActorRole = NonNullable<Awaited<ReturnType<typeof getActorServerRoleInServer>>>;

type ServerLabStateRow = {
  labKey: string;
  name: string;
  description: string;
  state: ServerLabCatalogState;
  enrollmentEnabled: boolean | null;
  enrollmentUpdatedAt: Date | null;
};

type ServerLabSnapshotRow = {
  serverKind: "normal" | "joint_storage";
  serverDeletedAt: Date | null;
  role: ServerLabActorRole | null;
  accessEnabled: boolean | null;
  accessVersion: number | null;
  labKey: string | null;
  name: string | null;
  description: string | null;
  state: ServerLabCatalogState | null;
  enrollmentEnabled: boolean | null;
  enrollmentUpdatedAt: Date | null;
};

function actorContextType(actor: ServerLabActor): "user" | "agent" {
  return actor.type === "human" ? "user" : "agent";
}

async function requireActorRole(serverId: string, actor: ServerLabActor): Promise<ServerLabActorRole> {
  const role = await getActorServerRoleInServer(serverId, actorContextType(actor), actor.id);
  if (!role) {
    throw new ServerLabServiceError(
      "SERVER_MEMBERSHIP_REQUIRED",
      "Server membership is required",
    );
  }
  return role;
}

function assertExpectedVersion(expectedVersion: number): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new TypeError("expectedVersion must be a non-negative safe integer");
  }
}

function assertRequestId(requestId: string): void {
  if (!requestId.trim() || requestId.length > 200) {
    throw new TypeError("requestId must be 1-200 characters");
  }
}

function nextVersion(version: number): number {
  const next = version + 1;
  if (!Number.isSafeInteger(next)) {
    throw new ServerLabServiceError(
      "SERVER_LABS_VERSION_CONFLICT",
      "Server Labs version cannot advance",
      version,
    );
  }
  return next;
}

async function lockLiveServer(tx: DatabaseTransaction, serverId: string): Promise<void> {
  const [server] = await tx
    .select({ id: servers.id })
    .from(servers)
    .where(and(
      eq(servers.id, serverId),
      ne(servers.kind, "joint_storage"),
      isNull(servers.deletedAt),
    ))
    .limit(1)
    .for("update");
  if (!server) {
    throw new ServerLabServiceError("SERVER_NOT_FOUND", "Server not found");
  }
}

async function readAccess(
  tx: DatabaseExecutor,
  serverId: string,
): Promise<{ enabled: boolean; version: number }> {
  const [access] = await tx
    .select({ enabled: serverLabAccess.enabled, version: serverLabAccess.version })
    .from(serverLabAccess)
    .where(eq(serverLabAccess.serverId, serverId))
    .limit(1);
  return access ?? { enabled: false, version: 0 };
}

async function readStateRows(
  tx: DatabaseExecutor,
  serverId: string,
): Promise<ServerLabStateRow[]> {
  const rows = await tx
    .select({
      labKey: labDefinitions.key,
      name: labDefinitions.name,
      description: labDefinitions.description,
      state: labDefinitions.state,
      enrollmentEnabled: serverLabEnrollments.enabled,
      enrollmentUpdatedAt: serverLabEnrollments.updatedAt,
    })
    .from(labDefinitions)
    .leftJoin(
      serverLabEnrollments,
      and(
        eq(serverLabEnrollments.serverId, serverId),
        eq(serverLabEnrollments.labKey, labDefinitions.key),
      ),
    )
    .orderBy(asc(labDefinitions.name), asc(labDefinitions.key));

  return rows.filter((row) => (
    row.state !== "draft"
    && (row.state !== "retired" || row.enrollmentEnabled !== null)
  ));
}

const serverLabSnapshotSelection = {
  serverKind: servers.kind,
  serverDeletedAt: servers.deletedAt,
  accessEnabled: serverLabAccess.enabled,
  accessVersion: serverLabAccess.version,
  labKey: labDefinitions.key,
  name: labDefinitions.name,
  description: labDefinitions.description,
  state: labDefinitions.state,
  enrollmentEnabled: serverLabEnrollments.enabled,
  enrollmentUpdatedAt: serverLabEnrollments.updatedAt,
};

async function readServerLabSnapshot(
  serverId: string,
  actor: ServerLabActor,
): Promise<ServerLabSnapshotRow[]> {
  const db = getDb();
  const enrollmentJoin = and(
    eq(serverLabEnrollments.serverId, serverId),
    eq(serverLabEnrollments.labKey, labDefinitions.key),
  );

  if (actor.type === "human") {
    return db
      .select({
        ...serverLabSnapshotSelection,
        role: sql<ServerLabActorRole | null>`case
          when ${servers.deletedAt} is not null then null
          else ${serverMembers.role}
        end`,
      })
      .from(servers)
      .leftJoin(serverMembers, and(
        eq(serverMembers.serverId, servers.id),
        eq(serverMembers.userId, actor.id),
      ))
      .leftJoin(serverLabAccess, eq(serverLabAccess.serverId, servers.id))
      .leftJoin(labDefinitions, isNotNull(serverMembers.userId))
      .leftJoin(serverLabEnrollments, enrollmentJoin)
      .where(eq(servers.id, serverId))
      .orderBy(asc(labDefinitions.name), asc(labDefinitions.key));
  }

  return db
    .select({
      ...serverLabSnapshotSelection,
      role: sql<ServerLabActorRole | null>`case
        when ${agents.id} is null then null
        else ${serverAgentMembers.role}
      end`,
    })
    .from(servers)
    .leftJoin(serverAgentMembers, and(
      eq(serverAgentMembers.serverId, servers.id),
      eq(serverAgentMembers.agentId, actor.id),
    ))
    .leftJoin(agents, and(
      eq(agents.id, serverAgentMembers.agentId),
      eq(agents.serverId, servers.id),
      isNull(agents.deletedAt),
    ))
    .leftJoin(serverLabAccess, eq(serverLabAccess.serverId, servers.id))
    .leftJoin(labDefinitions, isNotNull(agents.id))
    .leftJoin(serverLabEnrollments, enrollmentJoin)
    .where(eq(servers.id, serverId))
    .orderBy(asc(labDefinitions.name), asc(labDefinitions.key));
}

function projectReadModel(input: {
  serverId: string;
  role: ServerLabActorRole;
  access: { enabled: boolean; version: number };
  rows: ServerLabStateRow[];
}): ServerLabsReadModel {
  return {
    serverId: input.serverId,
    accessEnabled: input.access.enabled,
    version: input.access.version,
    canManageAccess: input.role === "owner",
    canManageEnrollments: actorRoleHasServerCapability(input.role, "editServerSettings"),
    labs: input.rows.map((row) => {
      const enrolled = row.enrollmentEnabled === true;
      return {
        labKey: row.labKey,
        name: row.name,
        description: row.description,
        state: row.state,
        enrolled,
        effective: input.access.enabled && row.state === "open" && enrolled,
        updatedAt: row.enrollmentUpdatedAt,
      };
    }),
  };
}

async function readModelInTransaction(
  tx: DatabaseTransaction,
  serverId: string,
  role: ServerLabActorRole,
): Promise<ServerLabsReadModel> {
  const [access, rows] = await Promise.all([
    readAccess(tx, serverId),
    readStateRows(tx, serverId),
  ]);
  return projectReadModel({ serverId, role, access, rows });
}

export async function getServerLabsForActor(
  serverId: string,
  actor: ServerLabActor,
): Promise<ServerLabsReadModel> {
  const snapshot = await readServerLabSnapshot(serverId, actor);
  const first = snapshot[0];
  if (!first?.role) {
    throw new ServerLabServiceError(
      "SERVER_MEMBERSHIP_REQUIRED",
      "Server membership is required",
    );
  }
  if (first.serverKind === "joint_storage" || first.serverDeletedAt !== null) {
    throw new ServerLabServiceError("SERVER_NOT_FOUND", "Server not found");
  }

  const rows: ServerLabStateRow[] = snapshot
    .filter((row): row is ServerLabSnapshotRow & {
      labKey: string;
      name: string;
      description: string;
      state: ServerLabCatalogState;
    } => (
      row.labKey !== null
      && row.name !== null
      && row.description !== null
      && row.state !== null
    ))
    .filter((row) => (
      row.state !== "draft"
      && (row.state !== "retired" || row.enrollmentEnabled !== null)
    ));
  return projectReadModel({
    serverId,
    role: first.role,
    access: {
      enabled: first.accessEnabled ?? false,
      version: first.accessVersion ?? 0,
    },
    rows,
  });
}

async function advanceAccessVersion(
  tx: DatabaseTransaction,
  input: {
    serverId: string;
    enabled: boolean;
    expectedVersion: number;
    nextVersion: number;
    actor: ServerLabActor;
    now: Date;
  },
): Promise<void> {
  const [updated] = await tx
    .update(serverLabAccess)
    .set({
      enabled: input.enabled,
      version: input.nextVersion,
      updatedByActorType: input.actor.type,
      updatedByActorId: input.actor.id,
      updatedAt: input.now,
    })
    .where(and(
      eq(serverLabAccess.serverId, input.serverId),
      eq(serverLabAccess.version, input.expectedVersion),
    ))
    .returning({ version: serverLabAccess.version });
  if (updated) return;

  if (input.expectedVersion !== 0) {
    throw new ServerLabServiceError(
      "SERVER_LABS_VERSION_CONFLICT",
      "Server Labs version changed",
      input.expectedVersion,
    );
  }
  const [inserted] = await tx
    .insert(serverLabAccess)
    .values({
      serverId: input.serverId,
      enabled: input.enabled,
      version: input.nextVersion,
      updatedByActorType: input.actor.type,
      updatedByActorId: input.actor.id,
      updatedAt: input.now,
    })
    .onConflictDoNothing({ target: serverLabAccess.serverId })
    .returning({ version: serverLabAccess.version });
  if (!inserted) {
    throw new ServerLabServiceError(
      "SERVER_LABS_VERSION_CONFLICT",
      "Server Labs version changed",
      input.expectedVersion,
    );
  }
}

async function insertAudit(
  tx: DatabaseTransaction,
  input: {
    serverId: string;
    operation: "master_access_set" | "enrollment_set";
    labKey: string | null;
    actor: ServerLabActor;
    requestId: string;
    versionBefore: number;
    versionAfter: number;
    beforeSnapshot: Record<string, unknown>;
    afterSnapshot: Record<string, unknown>;
  },
): Promise<string> {
  const id = randomUUID();
  const [inserted] = await tx.insert(serverLabAuditEvents).values({
    id,
    serverId: input.serverId,
    operation: input.operation,
    labKey: input.labKey,
    actorType: input.actor.type,
    actorId: input.actor.id,
    requestId: input.requestId,
    versionBefore: input.versionBefore,
    versionAfter: input.versionAfter,
    before: input.beforeSnapshot,
    after: input.afterSnapshot,
  }).returning({ id: serverLabAuditEvents.id });
  if (!inserted || inserted.id !== id) {
    throw new Error("Server Labs audit insert affected no row");
  }
  return id;
}

export async function setServerLabsAccess(input: {
  serverId: string;
  enabled: boolean;
  expectedVersion: number;
  actor: ServerLabActor;
  requestId: string;
}): Promise<ServerLabMutationResult> {
  assertExpectedVersion(input.expectedVersion);
  assertRequestId(input.requestId);
  const role = await requireActorRole(input.serverId, input.actor);
  if (role !== "owner") {
    throw new ServerLabServiceError(
      "SERVER_OWNER_REQUIRED",
      "Only the server owner can change Labs access",
    );
  }

  return getDb().transaction(async (tx) => {
    await lockLiveServer(tx, input.serverId);
    const access = await readAccess(tx, input.serverId);
    if (access.version !== input.expectedVersion) {
      throw new ServerLabServiceError(
        "SERVER_LABS_VERSION_CONFLICT",
        "Server Labs version changed",
        access.version,
      );
    }
    if (access.enabled === input.enabled) {
      return {
        applied: false,
        auditEventId: null,
        labs: await readModelInTransaction(tx, input.serverId, role),
      };
    }

    const versionAfter = nextVersion(access.version);
    const now = currentDate();
    await advanceAccessVersion(tx, {
      serverId: input.serverId,
      enabled: input.enabled,
      expectedVersion: access.version,
      nextVersion: versionAfter,
      actor: input.actor,
      now,
    });
    const auditEventId = await insertAudit(tx, {
      serverId: input.serverId,
      operation: "master_access_set",
      labKey: null,
      actor: input.actor,
      requestId: input.requestId,
      versionBefore: access.version,
      versionAfter,
      beforeSnapshot: { accessEnabled: access.enabled },
      afterSnapshot: { accessEnabled: input.enabled },
    });
    return {
      applied: true,
      auditEventId,
      labs: await readModelInTransaction(tx, input.serverId, role),
    };
  });
}

export async function setServerLabEnrollment(input: {
  serverId: string;
  labKey: string;
  enabled: boolean;
  expectedVersion: number;
  actor: ServerLabActor;
  requestId: string;
}): Promise<ServerLabMutationResult> {
  assertExpectedVersion(input.expectedVersion);
  assertRequestId(input.requestId);
  const role = await requireActorRole(input.serverId, input.actor);
  if (!actorRoleHasServerCapability(role, "editServerSettings")) {
    throw new ServerLabServiceError(
      "SERVER_ADMIN_REQUIRED",
      "Only server owners and admins can change Lab enrollment",
    );
  }

  return getDb().transaction(async (tx) => {
    await lockLiveServer(tx, input.serverId);
    const access = await readAccess(tx, input.serverId);
    if (access.version !== input.expectedVersion) {
      throw new ServerLabServiceError(
        "SERVER_LABS_VERSION_CONFLICT",
        "Server Labs version changed",
        access.version,
      );
    }
    if (!access.enabled) {
      throw new ServerLabServiceError(
        "SERVER_LABS_ACCESS_DISABLED",
        "Server Labs access is disabled",
      );
    }

    const [lab] = await tx
      .select({ state: labDefinitions.state })
      .from(labDefinitions)
      .where(eq(labDefinitions.key, input.labKey))
      .limit(1);
    if (!lab) {
      throw new ServerLabServiceError("LAB_NOT_FOUND", "Lab not found");
    }
    if (lab.state !== "open") {
      throw new ServerLabServiceError("LAB_NOT_OPEN", "Lab is not open for enrollment");
    }

    const [enrollment] = await tx
      .select({ enabled: serverLabEnrollments.enabled })
      .from(serverLabEnrollments)
      .where(and(
        eq(serverLabEnrollments.serverId, input.serverId),
        eq(serverLabEnrollments.labKey, input.labKey),
      ))
      .limit(1);
    const enrollmentEnabled = enrollment?.enabled ?? false;
    if (enrollmentEnabled === input.enabled) {
      return {
        applied: false,
        auditEventId: null,
        labs: await readModelInTransaction(tx, input.serverId, role),
      };
    }

    const versionAfter = nextVersion(access.version);
    const now = currentDate();
    await tx.insert(serverLabEnrollments).values({
      serverId: input.serverId,
      labKey: input.labKey,
      enabled: input.enabled,
      version: versionAfter,
      updatedByActorType: input.actor.type,
      updatedByActorId: input.actor.id,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [serverLabEnrollments.serverId, serverLabEnrollments.labKey],
      set: {
        enabled: input.enabled,
        version: versionAfter,
        updatedByActorType: input.actor.type,
        updatedByActorId: input.actor.id,
        updatedAt: now,
      },
    });
    await advanceAccessVersion(tx, {
      serverId: input.serverId,
      enabled: access.enabled,
      expectedVersion: access.version,
      nextVersion: versionAfter,
      actor: input.actor,
      now,
    });
    const auditEventId = await insertAudit(tx, {
      serverId: input.serverId,
      operation: "enrollment_set",
      labKey: input.labKey,
      actor: input.actor,
      requestId: input.requestId,
      versionBefore: access.version,
      versionAfter,
      beforeSnapshot: {
        accessEnabled: access.enabled,
        labKey: input.labKey,
        labState: lab.state,
        enrollmentEnabled,
      },
      afterSnapshot: {
        accessEnabled: access.enabled,
        labKey: input.labKey,
        labState: lab.state,
        enrollmentEnabled: input.enabled,
      },
    });
    return {
      applied: true,
      auditEventId,
      labs: await readModelInTransaction(tx, input.serverId, role),
    };
  });
}
