/**
 * The hosted runtime provider's own control surface on Raft (provider-facing,
 * never an agent's): `/internal/runtime-provider/:kind/agents/:agentId/...`.
 *
 * Authenticated by the provider's own credential, the deployment's
 * provisioning token for that provider and the agent's frozen target
 * (`ANTIPROTON_PROVISIONING_TOKEN`, or the canary token for a canary
 * provision; agentRuntimeProviderService.resolveProviderConfig), as
 * `Authorization: Bearer <token>`, compared in constant time. An agent
 * credential (`sk_agent_*`) is refused here like any other wrong token.
 *
 * `PUT|GET|DELETE .../push-webhook`: the agent's inbox push registration
 * (agentInboxPushService.ts) — endpoint and signing secret. For a personal
 * assistant this is the only way to set them while its WeChat bridge flags
 * are on (the agent-credential `PUT/DELETE /push-webhook` answer 403 then,
 * routes/internalAgentApi.ts), because the registration decides where the
 * assistant's inbox notices go. Every change is audited
 * (`agent_inbox_push.configured` / `agent_inbox_push.deleted`), in the same
 * transaction as the change. The secret is never returned.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response, type Router as RouterType } from "express";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { isAgentRuntimeProviderKind } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentCredentials, agentInboxPushRegistrations, agentRuntimeProvisions, agents } from "../db/schema";
import { resolveProviderConfig } from "../services/agentRuntimeProviderService";
import {
  AgentInboxPushError,
  deleteAgentInboxPushRegistration,
  getAgentInboxPushStatus,
  putAgentInboxPushRegistration,
} from "../services/agentInboxPushService";
import { recordIntegrationAuditEvent } from "../services/integrationAuditService";
import { addTraceEvent } from "../tracing/semanticTrace";
import { UUID_RE } from "../lib/messageId";

export const runtimeProviderControlRouter: RouterType = Router();

const UNAUTHORIZED = { error: "Runtime provider credential required", code: "runtime_provider_unauthorized" } as const;
const NOT_FOUND = { error: "No such agent on this provider", code: "runtime_provider_agent_not_found" } as const;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** The agent's live provision on `kind`, once the bearer is that provision's provider token; null when a refusal was sent. */
async function authorizeProvider(req: Request, res: Response): Promise<{ agentId: string; serverId: string; kind: string } | null> {
  const kind = req.params.kind;
  const agentId = req.params.agentId;
  const header = req.headers.authorization;
  const presented = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented || presented.startsWith("sk_")) {
    res.status(401).json(UNAUTHORIZED);
    return null;
  }
  if (!isAgentRuntimeProviderKind(kind) || typeof agentId !== "string" || !UUID_RE.test(agentId)) {
    res.status(401).json(UNAUTHORIZED);
    return null;
  }
  const [provision] = await getDb()
    .select({ serverId: agentRuntimeProvisions.serverId, provider: agentRuntimeProvisions.provider, target: agentRuntimeProvisions.providerTarget, agentDeletedAt: agents.deletedAt })
    .from(agentRuntimeProvisions)
    .innerJoin(agents, eq(agents.id, agentRuntimeProvisions.agentId))
    .where(and(
      eq(agentRuntimeProvisions.agentId, agentId.toLowerCase()),
      inArray(agentRuntimeProvisions.state, ["provisioning", "active", "failed"]),
    ))
    .limit(1);
  // The token is compared even when there is no such provision, so a probe learns nothing from timing.
  const config = resolveProviderConfig(kind, process.env, provision?.target ?? "default");
  const expected = config?.token ?? "";
  const matches = expected.length > 0 && timingSafeEqual(digest(presented), digest(expected));
  if (!matches) {
    addTraceEvent("runtime_provider_control.auth_refused");
    res.status(401).json(UNAUTHORIZED);
    return null;
  }
  if (!provision || provision.provider !== kind || provision.agentDeletedAt) {
    res.status(404).json(NOT_FOUND);
    return null;
  }
  return { agentId: agentId.toLowerCase(), serverId: provision.serverId, kind };
}

function sendPushError(res: Response, error: AgentInboxPushError): void {
  const status = error.code === "AGENT_NOT_EXTERNAL"
    ? 403
    : error.code === "AGENT_NOT_FOUND" || error.code === "CREDENTIAL_INACTIVE"
      ? 409
      : error.code === "PUSH_UNAVAILABLE"
        ? 503
        : 400;
  res.status(status).json({ error: error.message, code: error.code });
}

function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Provider view: the delivery status plus who set it (never the secret). */
async function providerView(agentId: string, serverId: string) {
  const status = await getAgentInboxPushStatus({ agentId, serverId });
  const [row] = await getDb()
    .select({ configuredBy: agentInboxPushRegistrations.configuredBy })
    .from(agentInboxPushRegistrations)
    .where(and(eq(agentInboxPushRegistrations.agentId, agentId), eq(agentInboxPushRegistrations.serverId, serverId)))
    .limit(1);
  return { ...status, configuredBy: row?.configuredBy ?? null };
}

runtimeProviderControlRouter.get("/:kind/agents/:agentId/push-webhook", async (req, res, next) => {
  try {
    const auth = await authorizeProvider(req, res);
    if (!auth) return;
    res.setHeader("Cache-Control", "no-store");
    res.json(await providerView(auth.agentId, auth.serverId));
  } catch (error) {
    next(error);
  }
});

runtimeProviderControlRouter.put("/:kind/agents/:agentId/push-webhook", async (req, res, next) => {
  try {
    const auth = await authorizeProvider(req, res);
    if (!auth) return;
    const body = req.body as unknown;
    // `capabilities` is still accepted from providers that send it and ignored:
    // nothing depends on what a runtime declares any more.
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => key !== "url" && key !== "secret" && key !== "capabilities")) {
      res.status(400).json({ error: "Body must be {url, secret}", code: "INVALID_BODY" });
      return;
    }
    const { url, secret } = body as { url?: unknown; secret?: unknown };
    const result = await getDb().transaction(async (tx) => {
      // The registration is bound to the agent's own provider-held (main) credential: revoking it disables push.
      const [credential] = await tx.select({ id: agentCredentials.id }).from(agentCredentials).where(and(
        eq(agentCredentials.agentId, auth.agentId),
        eq(agentCredentials.issuedVia, "provision"),
        isNull(agentCredentials.revokedAt),
      )).orderBy(desc(agentCredentials.createdAt)).limit(1);
      if (!credential) throw new AgentInboxPushError("CREDENTIAL_INACTIVE", "The agent has no live provider credential");
      const [previous] = await tx.select({ endpointUrl: agentInboxPushRegistrations.endpointUrl, configuredBy: agentInboxPushRegistrations.configuredBy })
        .from(agentInboxPushRegistrations).where(eq(agentInboxPushRegistrations.agentId, auth.agentId)).limit(1);
      const status = await putAgentInboxPushRegistration({
        agentId: auth.agentId,
        serverId: auth.serverId,
        credentialId: credential.id,
        url,
        secret,
        configuredBy: "provider",
      }, tx);
      await recordIntegrationAuditEvent({
        serverId: auth.serverId,
        eventType: "agent_inbox_push.configured",
        outcome: "success",
        source: "system",
        actor: { type: "system", id: null },
        subject: { type: "agent", id: auth.agentId },
        target: { type: "agent_inbox_push_registration", id: auth.agentId },
        metadata: {
          agentId: auth.agentId,
          providerKind: auth.kind,
          configuredBy: "provider",
          endpointOrigin: originOf(status.url),
          previousEndpointOrigin: originOf(previous?.endpointUrl),
          endpointChanged: previous?.endpointUrl !== status.url,
          previousConfiguredBy: previous?.configuredBy ?? null,
          secretSet: true,
        },
      }, tx);
      return status;
    });
    addTraceEvent("runtime_provider_control.push_webhook.put", { outcome: "stored" });
    res.json(await providerView(auth.agentId, auth.serverId).catch(() => result));
  } catch (error) {
    if (error instanceof AgentInboxPushError) {
      sendPushError(res, error);
      return;
    }
    next(error);
  }
});

runtimeProviderControlRouter.delete("/:kind/agents/:agentId/push-webhook", async (req, res, next) => {
  try {
    const auth = await authorizeProvider(req, res);
    if (!auth) return;
    await getDb().transaction(async (tx) => {
      const deleted = await deleteAgentInboxPushRegistration({ agentId: auth.agentId, serverId: auth.serverId }, tx);
      if (!deleted) return;
      await recordIntegrationAuditEvent({
        serverId: auth.serverId,
        eventType: "agent_inbox_push.deleted",
        outcome: "success",
        source: "system",
        actor: { type: "system", id: null },
        subject: { type: "agent", id: auth.agentId },
        target: { type: "agent_inbox_push_registration", id: auth.agentId },
        metadata: { agentId: auth.agentId, providerKind: auth.kind, configuredBy: "provider" },
      }, tx);
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
