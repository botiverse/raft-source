import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import {
  agents,
  externalActorProjections,
  externalAddressabilityProjections,
  externalReactionStates,
  messageReactionDiscussionVersions,
  messageReactions,
  messageReactionViewerVersions,
  users,
} from "../db/schema.js";
import { enqueueExternalReactionAggregateTransition } from "./externalReactionCommandRuntime.js";

const REACTION_ACTORS_CURSOR_KIND = "message-reaction-actors-v1";
const MAX_CURSOR_LENGTH = 2_048;

type ReactionActorKind = "user" | "agent";
type ReactionRosterActorKind = ReactionActorKind | "external_projection";

type ReactionActorsCursor = {
  kind: typeof REACTION_ACTORS_CURSOR_KIND;
  principalId: string;
  serverId: string;
  parentScopeKind: "channel" | "thread";
  parentScopeId: string;
  messageId: string;
  emoji: string;
  discussionVersion: number;
  visibilityHash: string;
  actorKind: ReactionRosterActorKind;
  actorId: string;
};

export type ReactionViewerSnapshotState = {
  viewerVersion: number;
  reactedEmojis: string[];
};

export type ReactionViewerSnapshot = ReactionViewerSnapshotState & {
  serverId: string;
  messageId: string;
};

export type ReactionMutationResult = {
  changed: boolean;
  discussionVersion: number;
  viewerSnapshot?: ReactionViewerSnapshotState;
};

export class InvalidReactionActorsCursorError extends Error {
  readonly code = "invalid_reaction_actors_cursor";
}

export class ReactionDiscussionVersionChangedError extends Error {
  readonly code = "reaction_discussion_version_changed";

  constructor(readonly currentDiscussionVersion: number) {
    super("Reaction discussion changed while reading this page");
  }
}

export class ReactionActorVisibilityChangedError extends Error {
  readonly code = "reaction_actor_visibility_changed";

  constructor() {
    super("Reaction actor visibility changed while reading this page");
  }
}

function cursorSigningSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
  return secret;
}

function signCursorBody(body: string): string {
  return createHmac("sha256", cursorSigningSecret()).update(body).digest("base64url");
}

function encodeReactionActorsCursor(cursor: ReactionActorsCursor): string {
  const body = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  return `${body}.${signCursorBody(body)}`;
}

function isReactionActorKind(value: unknown): value is ReactionRosterActorKind {
  return value === "user" || value === "agent" || value === "external_projection";
}

function decodeReactionActorsCursor(raw: string): ReactionActorsCursor {
  if (!raw || raw.length > MAX_CURSOR_LENGTH) throw new InvalidReactionActorsCursorError();
  const [body, suppliedSignature, extra] = raw.split(".");
  if (!body || !suppliedSignature || extra !== undefined) throw new InvalidReactionActorsCursorError();

  const expectedSignature = Buffer.from(signCursorBody(body), "utf8");
  const candidateSignature = Buffer.from(suppliedSignature, "utf8");
  if (
    expectedSignature.length !== candidateSignature.length
    || !timingSafeEqual(expectedSignature, candidateSignature)
  ) {
    throw new InvalidReactionActorsCursorError();
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new InvalidReactionActorsCursorError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidReactionActorsCursorError();
  }
  const cursor = value as Record<string, unknown>;
  if (
    cursor.kind !== REACTION_ACTORS_CURSOR_KIND
    || typeof cursor.principalId !== "string"
    || typeof cursor.serverId !== "string"
    || (cursor.parentScopeKind !== "channel" && cursor.parentScopeKind !== "thread")
    || typeof cursor.parentScopeId !== "string"
    || typeof cursor.messageId !== "string"
    || typeof cursor.emoji !== "string"
    || typeof cursor.discussionVersion !== "number"
    || !Number.isSafeInteger(cursor.discussionVersion)
    || cursor.discussionVersion < 0
    || typeof cursor.visibilityHash !== "string"
    || !isReactionActorKind(cursor.actorKind)
    || typeof cursor.actorId !== "string"
  ) {
    throw new InvalidReactionActorsCursorError();
  }
  return cursor as ReactionActorsCursor;
}

async function readDiscussionVersion(
  executor: DatabaseExecutor,
  messageId: string,
  emoji: string,
): Promise<number> {
  const [row] = await executor
    .select({ version: messageReactionDiscussionVersions.version })
    .from(messageReactionDiscussionVersions)
    .where(and(
      eq(messageReactionDiscussionVersions.messageId, messageId),
      eq(messageReactionDiscussionVersions.emoji, emoji),
    ))
    .limit(1);
  return row?.version ?? 0;
}

async function readViewerVersion(
  executor: DatabaseExecutor,
  messageId: string,
  userId: string,
): Promise<number> {
  const [row] = await executor
    .select({ version: messageReactionViewerVersions.version })
    .from(messageReactionViewerVersions)
    .where(and(
      eq(messageReactionViewerVersions.messageId, messageId),
      eq(messageReactionViewerVersions.userId, userId),
    ))
    .limit(1);
  return row?.version ?? 0;
}

async function bumpDiscussionVersion(
  executor: DatabaseExecutor,
  messageId: string,
  emoji: string,
): Promise<number> {
  const [row] = await executor
    .insert(messageReactionDiscussionVersions)
    .values({ messageId, emoji, version: 1 })
    .onConflictDoUpdate({
      target: [messageReactionDiscussionVersions.messageId, messageReactionDiscussionVersions.emoji],
      set: {
        version: sql`${messageReactionDiscussionVersions.version} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ version: messageReactionDiscussionVersions.version });
  if (!row) throw new Error("Failed to advance reaction discussion version");
  return row.version;
}

async function bumpViewerVersion(
  executor: DatabaseExecutor,
  messageId: string,
  userId: string,
): Promise<number> {
  const [row] = await executor
    .insert(messageReactionViewerVersions)
    .values({ messageId, userId, version: 1 })
    .onConflictDoUpdate({
      target: [messageReactionViewerVersions.messageId, messageReactionViewerVersions.userId],
      set: {
        version: sql`${messageReactionViewerVersions.version} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ version: messageReactionViewerVersions.version });
  if (!row) throw new Error("Failed to advance reaction viewer version");
  return row.version;
}

async function readViewerReactionEmojis(
  executor: DatabaseExecutor,
  messageId: string,
  userId: string,
): Promise<string[]> {
  const rows = await executor
    .select({ emoji: messageReactions.emoji })
    .from(messageReactions)
    .where(and(
      eq(messageReactions.messageId, messageId),
      eq(messageReactions.reactorType, "user"),
      eq(messageReactions.reactorId, userId),
    ))
    .orderBy(asc(messageReactions.emoji));
  return rows.map((row) => row.emoji).sort();
}

export function projectReactionViewerSnapshot(input: {
  serverId: string;
  messageId: string;
  state: ReactionViewerSnapshotState;
}): ReactionViewerSnapshot {
  return {
    serverId: input.serverId,
    messageId: input.messageId,
    viewerVersion: input.state.viewerVersion,
    reactedEmojis: input.state.reactedEmojis,
  };
}

export async function mutateMessageReaction(input: {
  messageId: string;
  emoji: string;
  actor: { kind: ReactionActorKind; id: string };
  operation: "add" | "remove";
}): Promise<ReactionMutationResult> {
  return getDb().transaction(async (tx) => {
    const [aggregateBeforeRow] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(messageReactions)
      .where(and(
        eq(messageReactions.messageId, input.messageId),
        eq(messageReactions.emoji, input.emoji),
      ));
    const aggregateBefore = aggregateBeforeRow?.count ?? 0;
    let changedRows: Array<{ messageId: string }>;
    if (input.operation === "add") {
      changedRows = await tx
        .insert(messageReactions)
        .values({
          messageId: input.messageId,
          reactorType: input.actor.kind,
          reactorId: input.actor.id,
          emoji: input.emoji,
        })
        .onConflictDoNothing()
        .returning({ messageId: messageReactions.messageId });
    } else {
      changedRows = await tx
        .delete(messageReactions)
        .where(and(
          eq(messageReactions.messageId, input.messageId),
          eq(messageReactions.reactorType, input.actor.kind),
          eq(messageReactions.reactorId, input.actor.id),
          eq(messageReactions.emoji, input.emoji),
        ))
        .returning({ messageId: messageReactions.messageId });
    }

    const changed = changedRows.length > 0;
    const discussionVersion = changed
      ? await bumpDiscussionVersion(tx, input.messageId, input.emoji)
      : await readDiscussionVersion(tx, input.messageId, input.emoji);

    if (changed) {
      const localAggregateCount = input.operation === "add"
        ? aggregateBefore + 1
        : Math.max(0, aggregateBefore - 1);
      if ((aggregateBefore === 0) !== (localAggregateCount === 0)) {
        await enqueueExternalReactionAggregateTransition({
          tx,
          raftMessageId: input.messageId,
          canonicalEmoji: input.emoji,
          localDiscussionVersion: discussionVersion,
          localAggregateCount,
          desiredPresent: localAggregateCount > 0,
          now: new Date(),
        });
      }
    }

    if (input.actor.kind !== "user") return { changed, discussionVersion };
    const viewerVersion = changed
      ? await bumpViewerVersion(tx, input.messageId, input.actor.id)
      : await readViewerVersion(tx, input.messageId, input.actor.id);
    return {
      changed,
      discussionVersion,
      viewerSnapshot: {
        viewerVersion,
        reactedEmojis: await readViewerReactionEmojis(tx, input.messageId, input.actor.id),
      },
    };
  });
}

export async function listReactionActors(input: {
  principalId: string;
  serverId: string;
  parentScope: { kind: "channel" | "thread"; id: string };
  messageId: string;
  emoji: string;
  limit: number;
  cursor?: string;
  visibleActorIds: {
    users: string[];
    agents: string[];
  };
}) {
  const db = getDb();
  const externalVisibleRows = await db.select({
    actorId: externalReactionStates.projectionId,
    displayName: externalActorProjections.displayName,
  }).from(externalReactionStates)
    .innerJoin(externalActorProjections, and(
      eq(externalActorProjections.id, externalReactionStates.projectionId),
      eq(externalActorProjections.state, "active"),
      eq(externalActorProjections.deactivated, false),
    ))
    .innerJoin(externalAddressabilityProjections, and(
      eq(externalAddressabilityProjections.projectionId, externalReactionStates.projectionId),
      eq(externalAddressabilityProjections.bindingId, externalReactionStates.bindingId),
      eq(externalAddressabilityProjections.bindingEpoch, externalReactionStates.bindingEpoch),
      eq(externalAddressabilityProjections.connectionEpoch, externalReactionStates.connectionEpoch),
      eq(externalAddressabilityProjections.state, "active"),
      gt(externalAddressabilityProjections.expiresAt, sql`now()`),
    ))
    .where(and(
      eq(externalReactionStates.raftMessageId, input.messageId),
      eq(externalReactionStates.canonicalEmoji, input.emoji),
      eq(externalReactionStates.present, true),
    ));
  const externalVisible = [...new Map(
    externalVisibleRows.map((row) => [row.actorId, row] as const),
  ).values()];
  const visibilityHash = createHash("sha256")
    .update(JSON.stringify({
      users: [...new Set(input.visibleActorIds.users)].sort(),
      agents: [...new Set(input.visibleActorIds.agents)].sort(),
      externalProjections: externalVisible.map((row) => row.actorId).sort(),
    }))
    .digest("base64url");
  const decodedCursor = input.cursor ? decodeReactionActorsCursor(input.cursor) : undefined;
  if (decodedCursor && (
    decodedCursor.principalId !== input.principalId
    || decodedCursor.serverId !== input.serverId
    || decodedCursor.parentScopeKind !== input.parentScope.kind
    || decodedCursor.parentScopeId !== input.parentScope.id
    || decodedCursor.messageId !== input.messageId
    || decodedCursor.emoji !== input.emoji
  )) {
    throw new InvalidReactionActorsCursorError();
  }
  if (decodedCursor && decodedCursor.visibilityHash !== visibilityHash) {
    throw new ReactionActorVisibilityChangedError();
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const discussionVersion = await readDiscussionVersion(db, input.messageId, input.emoji);
    if (decodedCursor && decodedCursor.discussionVersion !== discussionVersion) {
      throw new ReactionDiscussionVersionChangedError(discussionVersion);
    }

    const cursorPredicate = decodedCursor
      ? or(
        sql`${messageReactions.reactorType} > ${decodedCursor.actorKind}`,
        and(
          sql`${messageReactions.reactorType} = ${decodedCursor.actorKind}`,
          gt(messageReactions.reactorId, decodedCursor.actorId),
        ),
      )
      : undefined;
    const actorVisibilityPredicate = or(
      input.visibleActorIds.users.length > 0
        ? and(
          eq(messageReactions.reactorType, "user"),
          inArray(messageReactions.reactorId, input.visibleActorIds.users),
        )
        : undefined,
      input.visibleActorIds.agents.length > 0
        ? and(
          eq(messageReactions.reactorType, "agent"),
          inArray(messageReactions.reactorId, input.visibleActorIds.agents),
        )
        : undefined,
    ) ?? sql`false`;

    const rows = await db
      .select({
        actorKind: messageReactions.reactorType,
        actorId: messageReactions.reactorId,
        userName: users.name,
        userDisplayName: users.displayName,
        agentName: agents.name,
        agentDisplayName: agents.displayName,
      })
      .from(messageReactions)
      .leftJoin(users, and(
        eq(messageReactions.reactorType, "user"),
        eq(messageReactions.reactorId, users.id),
      ))
      .leftJoin(agents, and(
        eq(messageReactions.reactorType, "agent"),
        eq(messageReactions.reactorId, agents.id),
      ))
      .where(and(
        eq(messageReactions.messageId, input.messageId),
        eq(messageReactions.emoji, input.emoji),
        actorVisibilityPredicate,
        cursorPredicate,
      ))
      .orderBy(
        asc(messageReactions.reactorType),
        asc(messageReactions.reactorId),
      )
      .limit(input.limit + 1);

    const versionAfterRead = await readDiscussionVersion(db, input.messageId, input.emoji);
    if (versionAfterRead !== discussionVersion) {
      if (decodedCursor || attempt === 1) {
        throw new ReactionDiscussionVersionChangedError(versionAfterRead);
      }
      continue;
    }

    const externalAfterCursor = externalVisible
      .filter((row) => !decodedCursor
        || decodedCursor.actorKind < "external_projection"
        || (decodedCursor.actorKind === "external_projection" && row.actorId > decodedCursor.actorId))
      .map((row) => ({
        actorKind: "external_projection" as const,
        actorId: row.actorId,
        userName: null,
        userDisplayName: null,
        agentName: null,
        agentDisplayName: null,
        externalDisplayName: row.displayName,
      }));
    const combined = [
      ...rows.map((row) => ({ ...row, externalDisplayName: null as string | null })),
      ...externalAfterCursor,
    ].sort((left, right) => (
      left.actorKind === right.actorKind
        ? left.actorId.localeCompare(right.actorId)
        : left.actorKind.localeCompare(right.actorKind)
    ));
    const hasMore = combined.length > input.limit;
    const pageRows = combined.slice(0, input.limit);
    const last = hasMore ? pageRows.at(-1) : undefined;
    return {
      discussionVersion,
      actors: pageRows.map((row) => ({
        actorRef: { kind: row.actorKind, id: row.actorId },
        name: row.actorKind === "agent"
          ? row.agentName
          : row.actorKind === "external_projection"
            ? row.externalDisplayName
            : row.userName,
        displayName: row.actorKind === "agent"
          ? row.agentDisplayName || row.agentName || "Unknown agent"
          : row.actorKind === "external_projection"
            ? row.externalDisplayName || "Unknown external actor"
            : row.userDisplayName || row.userName || "Unknown user",
      })),
      nextCursor: last
        ? encodeReactionActorsCursor({
          kind: REACTION_ACTORS_CURSOR_KIND,
          principalId: input.principalId,
          serverId: input.serverId,
          parentScopeKind: input.parentScope.kind,
          parentScopeId: input.parentScope.id,
          messageId: input.messageId,
          emoji: input.emoji,
          discussionVersion,
          visibilityHash,
          actorKind: last.actorKind,
          actorId: last.actorId,
        })
        : null,
    };
  }
  throw new ReactionDiscussionVersionChangedError(
    await readDiscussionVersion(db, input.messageId, input.emoji),
  );
}

export async function hydrateReactionViewer(input: { messageId: string; userId: string }) {
  const db = getDb();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const version = await readViewerVersion(db, input.messageId, input.userId);
    const reactedEmojis = await readViewerReactionEmojis(db, input.messageId, input.userId);
    const versionAfterRead = await readViewerVersion(db, input.messageId, input.userId);
    if (versionAfterRead === version) {
      return {
        viewerVersion: version,
        reactedEmojis,
      };
    }
    if (attempt === 1) {
      throw new Error("Reaction viewer state changed repeatedly while hydrating");
    }
  }
  throw new Error("Failed to hydrate reaction viewer state");
}
