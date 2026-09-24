import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import { serverAgreements, serverMembershipAgreementAudit } from "../db/schema.js";

export type AgreementSource = "invite" | "join" | "request-access" | "admin-add";
export type AgreementSubjectType = "user" | "agent";

export class AgreementRequiredError extends Error {
  constructor(public readonly agreement: PublicAgreement) {
    super("agreement_required");
    this.name = "AgreementRequiredError";
  }
}

export class AgreementChangedError extends Error {
  constructor(public readonly agreement: PublicAgreement | null) {
    super("agreement_changed");
    this.name = "AgreementChangedError";
  }
}

export interface PublicAgreement {
  id: string;
  serverId: string;
  version: number;
  title: string;
  bodyMarkdown: string;
  effectiveAt: Date;
  enabled: boolean;
  createdAt: Date;
}

export interface AgreementAuditInput {
  serverId: string;
  subjectType: AgreementSubjectType;
  subjectId: string;
  actorUserId: string;
  source: AgreementSource;
  agreementId: string | null;
  agreementVersion: number | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface SelfServeAgreementInput {
  agreementId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export const PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH = 5_000;

function toPublicAgreement(row: typeof serverAgreements.$inferSelect): PublicAgreement {
  return {
    id: row.id,
    serverId: row.serverId,
    version: row.version,
    title: row.title,
    bodyMarkdown: row.bodyMarkdown,
    effectiveAt: row.effectiveAt,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

export async function getActiveAgreement(serverId: string, db: DatabaseExecutor = getDb()): Promise<PublicAgreement | null> {
  const [row] = await db
    .select()
    .from(serverAgreements)
    .where(and(eq(serverAgreements.serverId, serverId), eq(serverAgreements.enabled, true)));
  return row ? toPublicAgreement(row) : null;
}

export async function getLatestAgreement(serverId: string, db: DatabaseExecutor = getDb()): Promise<PublicAgreement | null> {
  const [row] = await db
    .select()
    .from(serverAgreements)
    .where(eq(serverAgreements.serverId, serverId))
    .orderBy(desc(serverAgreements.version))
    .limit(1);
  return row ? toPublicAgreement(row) : null;
}

export async function configureAgreement(
  serverId: string,
  actorUserId: string,
  input: { enabled: boolean; title?: string; bodyMarkdown?: string },
): Promise<PublicAgreement | null> {
  const title = input.title?.trim() ?? "";
  const bodyMarkdown = input.bodyMarkdown ?? "";
  if (bodyMarkdown.length > PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH) {
    throw new Error(`Agreement body must be ${PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH} characters or fewer`);
  }
  if (input.enabled) {
    if (!title) {
      throw new Error("Agreement title is required");
    }
    if (!bodyMarkdown.trim()) {
      throw new Error("Agreement body is required");
    }
  }

  return getDb().transaction(async (tx) => {
    await tx
      .update(serverAgreements)
      .set({ enabled: false })
      .where(and(eq(serverAgreements.serverId, serverId), eq(serverAgreements.enabled, true)));

    if (!input.enabled) {
      return null;
    }

    const [inserted] = await tx
      .insert(serverAgreements)
      .values({
        serverId,
        version: sql<number>`COALESCE((SELECT MAX(${serverAgreements.version}) + 1 FROM ${serverAgreements} WHERE ${serverAgreements.serverId} = ${serverId}), 1)`,
        title,
        bodyMarkdown,
        createdByUserId: actorUserId,
        enabled: true,
      })
      .returning();

    return toPublicAgreement(inserted);
  });
}

export async function requireSelfServeAgreement(
  tx: DatabaseExecutor,
  serverId: string,
  input: SelfServeAgreementInput | undefined,
): Promise<PublicAgreement | null> {
  const active = await getActiveAgreement(serverId, tx);
  if (!active) return null;
  if (!input?.agreementId) {
    throw new AgreementRequiredError(active);
  }
  if (input.agreementId !== active.id) {
    throw new AgreementChangedError(active);
  }
  return active;
}

export async function insertMembershipAgreementAudit(tx: DatabaseExecutor, input: AgreementAuditInput) {
  await tx.insert(serverMembershipAgreementAudit).values({
    serverId: input.serverId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    agreementId: input.agreementId,
    agreementVersion: input.agreementVersion,
    actorUserId: input.actorUserId,
    source: input.source,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
}

export function agreementErrorResponse(err: unknown) {
  if (err instanceof AgreementRequiredError) {
    return { status: 409, body: { error: "agreement_required", agreement: err.agreement } };
  }
  if (err instanceof AgreementChangedError) {
    return { status: 409, body: { error: "agreement_changed", agreement: err.agreement } };
  }
  return null;
}
