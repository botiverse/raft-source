/**
 * A Server's SSO settings (rfcs/083-server-sso.md §4, §5.5, §7), mounted at
 * /api/servers/:id/sso behind requireServerMatchesParam (which answers a
 * non-member 403 before this router runs). While `server_sso_v1` is off for
 * the Server every route answers 404.
 *
 * Who: the connection and the rules need `manageSso` (owner only); domains
 * need `editServerSettings` (owners and admins); reading needs either.
 * The source-available edition has no SSO (edition.ts): every route, reads
 * included, answers 404 (refuseWithoutEnterpriseSso).
 */
import { revokeSocketAccess } from "../socket/accessRevocation";
import { forgetSsoRequirementCache, ssoRequirementReviewed, usersManagedBy } from "../services/sso/ssoEnforcement";
import { Router, type Request, type Response, type Router as RouterType } from "express";
import type { ServerRole } from "@botiverse/raft-shared";
import { actorRoleHasServerCapability, getActorServerRoleInServer } from "../lib/actorPermissions";
import { getDb } from "../db/index";
import { evaluateFeatureFlag, SERVER_SSO_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { recordIntegrationAuditEvent, serverAuditContextMetadata } from "../services/integrationAuditService";
import { isSsoSecretStoreConfigured, SsoSecretUnavailableError } from "../services/sso/ssoConnectionSecret";
import {
  deleteServerSsoConnection,
  getServerSsoConnection,
  parseSsoConnectionInput,
  parseSsoRulesInput,
  saveServerSsoConnection,
  serverSsoConnectionView,
  SsoConnectionConflictError,
  SsoConnectionInputError,
  updateServerSsoRules,
} from "../services/sso/ssoConnections";
import {
  addServerSsoDomain,
  checkServerSsoDomain,
  getServerSsoDomain,
  SSO_DOMAIN_VERIFY_COOLDOWN_MS,
  listServerSsoDomains,
  removeServerSsoDomain,
  serverSsoDomainView,
  SsoDomainError,
} from "../services/sso/ssoDomains";
import { guardUuidPathParams } from "../lib/uuidPathParams";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { refuseWithoutEnterpriseSso, ssoStartUrl } from "./sso";

/**
 * After a tightening (require on, a shorter max age, a newly verified
 * domain): the people this Server's requirement manages reconnect, and their
 * sockets meet the rule at the handshake, which reads fresh (RFC 083 §6.2).
 * HTTP is checked on every request anyway. Other changes (the flag turned on,
 * an owner leaving, an email moved onto a domain) are caught by the periodic
 * socket re-check.
 */
function reconnectManagedPeople(serverId: string): void {
  // After the response, never inside it: the rule has committed, and a failure here must not turn it into a 500.
  setImmediate(() => {
    void (async () => {
      const connection = await getServerSsoConnection(serverId);
      if (!connection || connection.status !== "active" || !connection.required) return;
      // Not reviewed: the requirement manages no one, so there is no one to reconnect.
      if (!(await ssoRequirementReviewed(serverId))) return;
      for (const userId of await usersManagedBy(serverId)) await revokeSocketAccess({ userId });
    })().catch((error) => logFailure("reconnect managed people", error));
  });
}

class SsoRulesRefusedError extends Error {
  constructor(readonly code: "connection_inactive" | "sso_required_not_reviewed", message: string) {
    super(message);
  }
}

export const serverSsoRouter: RouterType = Router({ mergeParams: true });
serverSsoRouter.use(refuseWithoutEnterpriseSso);
guardUuidPathParams(serverSsoRouter, { domainId: "Domain" });

function logFailure(route: string, error: unknown): void {
  console.error(`[sso] ${route} failed:`, serializeErrorForLog(error));
}

function routeParam(req: Request, name: string): string | null {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  return typeof value === "string" ? value : null;
}

type Access = { serverId: string; role: ServerRole; canManageConnection: boolean; canManageDomains: boolean };

/** The caller's access, or null after answering: 404 while the flag is off or for a non-member, 403 without a capability. */
async function access(req: Request, res: Response, need: "read" | "connection" | "domains"): Promise<Access | null> {
  const serverId = routeParam(req, "id");
  if (!serverId) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  const flag = await evaluateFeatureFlag({ key: SERVER_SSO_FEATURE_FLAG_KEY, serverId }).catch(() => ({ enabled: false }));
  const role = flag.enabled ? await getActorServerRoleInServer(serverId, "user", req.userId!) : null;
  if (!role) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  const canManageConnection = actorRoleHasServerCapability(role, "manageSso");
  const canManageDomains = actorRoleHasServerCapability(role, "editServerSettings");
  const allowed = need === "connection" ? canManageConnection
    : need === "domains" ? canManageDomains
    : canManageConnection || canManageDomains;
  if (!allowed) {
    res.status(403).json({
      error: need === "connection"
        ? "Only the server owner can change the SSO connection"
        : "Only server owners and admins can manage SSO",
    });
    return null;
  }
  return { serverId, role, canManageConnection, canManageDomains };
}

function answerInputError(res: Response, error: unknown): boolean {
  if (error instanceof SsoConnectionInputError) {
    res.status(400).json({ error: error.message, field: error.field });
    return true;
  }
  if (error instanceof SsoDomainError) {
    res.status(400).json({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof SsoConnectionConflictError) {
    res.status(409).json({ error: error.message, code: "sso_connection_conflict" });
    return true;
  }
  if (error instanceof SsoSecretUnavailableError) {
    res.status(503).json({ error: "SSO is not available on this Raft deployment yet", code: "sso_unavailable" });
    return true;
  }
  return false;
}

serverSsoRouter.get("/", async (req, res) => {
  try {
    const caller = await access(req, res, "read");
    if (!caller) return;
    const [connection, domains, requireReviewed] = await Promise.all([
      getServerSsoConnection(caller.serverId),
      listServerSsoDomains(caller.serverId),
      // An unreadable flag keeps enforcing; the settings must not say it does not.
      ssoRequirementReviewed(caller.serverId, undefined, { unreadable: true }),
    ]);
    res.json({
      connection: connection ? serverSsoConnectionView(connection) : null,
      domains: domains.map(serverSsoDomainView),
      canManageConnection: caller.canManageConnection,
      canManageDomains: caller.canManageDomains,
      requireReviewed,
      secretStoreConfigured: isSsoSecretStoreConfigured(),
    });
  } catch (error) {
    logFailure("GET /sso", error);
    res.status(500).json({ error: "Failed to load SSO settings" });
  }
});

serverSsoRouter.put("/connection", async (req, res) => {
  try {
    const caller = await access(req, res, "connection");
    if (!caller) return;
    const connection = parseSsoConnectionInput(req.body);
    const saved = await getDb().transaction(async (tx) => {
      const result = await saveServerSsoConnection({ serverId: caller.serverId, actorUserId: req.userId!, connection }, tx);
      await recordIntegrationAuditEvent({
        serverId: caller.serverId,
        eventType: "sso.connection_saved",
        outcome: "success",
        source: "web",
        actor: { type: "human", id: req.userId! },
        target: { type: "sso_connection", id: result.row.id },
        metadata: {
          connectionId: result.row.id,
          protocol: connection.config.protocol,
          status: result.row.status,
          draft: result.row.draftConfig !== null,
          created: result.created,
          ...serverAuditContextMetadata({ actorRole: caller.role }),
        },
      }, tx);
      return result;
    });
    res.status(saved.created ? 201 : 200).json({ connection: serverSsoConnectionView(saved.row) });
  } catch (error) {
    if (answerInputError(res, error)) return;
    logFailure("PUT /sso/connection", error);
    res.status(500).json({ error: "Failed to save the SSO connection" });
  }
});

serverSsoRouter.delete("/connection", async (req, res) => {
  try {
    const caller = await access(req, res, "connection");
    if (!caller) return;
    const removed = await getDb().transaction(async (tx) => {
      const row = await deleteServerSsoConnection(caller.serverId, tx);
      if (!row) return null;
      await recordIntegrationAuditEvent({
        serverId: caller.serverId,
        eventType: "sso.connection_deleted",
        outcome: "success",
        source: "web",
        actor: { type: "human", id: req.userId! },
        target: { type: "sso_connection", id: row.id },
        metadata: { connectionId: row.id, protocol: row.protocol, status: row.status, ...serverAuditContextMetadata({ actorRole: caller.role }) },
      }, tx);
      return row;
    });
    if (!removed) {
      res.status(404).json({ error: "This Server has no SSO connection" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    logFailure("DELETE /sso/connection", error);
    res.status(500).json({ error: "Failed to delete the SSO connection" });
  }
});

/**
 * POST /test: the owner's test sign-in (RFC 083 §4): a start link for a leg
 * that proves the connection works (its draft, when an active connection has
 * one) and then activates it or promotes the draft. It writes no person.
 */
serverSsoRouter.post("/test", async (req, res) => {
  try {
    const caller = await access(req, res, "connection");
    if (!caller) return;
    const connection = await getServerSsoConnection(caller.serverId);
    if (!connection) {
      res.status(404).json({ error: "This Server has no SSO connection" });
      return;
    }
    const draft = connection.status === "active" && connection.draftConfig !== null;
    res.json({ url: ssoStartUrl({ cid: connection.id, test: { uid: req.userId!, draft } }), testsDraft: draft });
  } catch (error) {
    logFailure("POST /sso/test", error);
    res.status(500).json({ error: "Failed to start the test sign-in" });
  }
});

serverSsoRouter.patch("/rules", async (req, res) => {
  try {
    const caller = await access(req, res, "connection");
    if (!caller) return;
    const rules = parseSsoRulesInput(req.body);
    // Read outside the transaction: the flag is the platform's, not this row's.
    const reviewed = rules.required === true ? await ssoRequirementReviewed(caller.serverId) : true;
    let tightened = false;
    const updated = await getDb().transaction(async (tx) => {
      const connection = await getServerSsoConnection(caller.serverId, tx);
      if (!connection) return null;
      // An active connection already passed the owner's test sign-in; the owner is never managed by it.
      if (rules.required === true && !connection.required && connection.status !== "active") {
        throw new SsoRulesRefusedError("connection_inactive", "Activate the connection with a test sign-in first");
      }
      if (rules.required === true && !connection.required && !reviewed) {
        throw new SsoRulesRefusedError("sso_required_not_reviewed", "Raft has to review this organization before it can require single sign-on");
      }
      const required = rules.required ?? connection.required;
      tightened = required && (!connection.required || (rules.sessionMaxAgeDays ?? connection.sessionMaxAgeDays) < connection.sessionMaxAgeDays);
      const row = await updateServerSsoRules(connection.id, rules, tx);
      await recordIntegrationAuditEvent({
        serverId: caller.serverId,
        eventType: "sso.rules_updated",
        outcome: "success",
        source: "web",
        actor: { type: "human", id: req.userId! },
        target: { type: "sso_connection", id: connection.id },
        metadata: { connectionId: connection.id, ...rules, ...serverAuditContextMetadata({ actorRole: caller.role }) },
      }, tx);
      return row;
    });
    if (!updated) {
      res.status(404).json({ error: "This Server has no SSO connection" });
      return;
    }
    forgetSsoRequirementCache();
    if (tightened) reconnectManagedPeople(caller.serverId);
    res.json({ connection: serverSsoConnectionView(updated) });
  } catch (error) {
    if (error instanceof SsoRulesRefusedError) {
      res.status(409).json({ error: error.message, code: error.code });
      return;
    }
    if (answerInputError(res, error)) return;
    logFailure("PATCH /sso/rules", error);
    res.status(500).json({ error: "Failed to update the SSO rules" });
  }
});

serverSsoRouter.post("/domains", async (req, res) => {
  try {
    const caller = await access(req, res, "domains");
    if (!caller) return;
    const added = await getDb().transaction(async (tx) => {
      const result = await addServerSsoDomain({ serverId: caller.serverId, domain: req.body?.domain, actorUserId: req.userId! }, tx);
      if (result.created) {
        await recordIntegrationAuditEvent({
          serverId: caller.serverId,
          eventType: "sso.domain_added",
          outcome: "success",
          source: "web",
          actor: { type: "human", id: req.userId! },
          target: { type: "sso_domain", id: result.row.id },
          metadata: { domainId: result.row.id, domain: result.row.domain, ...serverAuditContextMetadata({ actorRole: caller.role }) },
        }, tx);
      }
      return result;
    });
    res.status(added.created ? 201 : 200).json({ domain: serverSsoDomainView(added.row) });
  } catch (error) {
    if (answerInputError(res, error)) return;
    logFailure("POST /sso/domains", error);
    res.status(500).json({ error: "Failed to add the domain" });
  }
});

serverSsoRouter.post("/domains/:domainId/verify", async (req, res) => {
  try {
    const caller = await access(req, res, "domains");
    if (!caller) return;
    const current = await getServerSsoDomain(caller.serverId, routeParam(req, "domainId") ?? "");
    if (!current) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }
    if (current.lastCheckedAt && Date.now() - current.lastCheckedAt.getTime() < SSO_DOMAIN_VERIFY_COOLDOWN_MS) {
      res.status(429).json({ error: "This domain was just checked; try again in a few seconds", code: "sso_domain_check_cooldown" });
      return;
    }
    const checked = await checkServerSsoDomain({
      serverId: caller.serverId,
      domainId: routeParam(req, "domainId") ?? "",
      actor: { type: "human", id: req.userId!, role: caller.role },
      source: "web",
    });
    if (!checked) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }
    forgetSsoRequirementCache();
    // A newly verified domain under a required connection manages more people now.
    if (checked.row.verifiedAt && !current.verifiedAt) reconnectManagedPeople(caller.serverId);
    res.json({ domain: serverSsoDomainView(checked.row), result: checked.result });
  } catch (error) {
    logFailure("POST /sso/domains/:domainId/verify", error);
    res.status(500).json({ error: "Failed to check the domain" });
  }
});

serverSsoRouter.delete("/domains/:domainId", async (req, res) => {
  try {
    const caller = await access(req, res, "domains");
    if (!caller) return;
    const removed = await getDb().transaction(async (tx) => {
      const row = await removeServerSsoDomain(caller.serverId, routeParam(req, "domainId") ?? "", tx);
      if (!row) return null;
      await recordIntegrationAuditEvent({
        serverId: caller.serverId,
        eventType: "sso.domain_removed",
        outcome: "success",
        source: "web",
        actor: { type: "human", id: req.userId! },
        target: { type: "sso_domain", id: row.id },
        metadata: { domainId: row.id, domain: row.domain, verified: row.verifiedAt !== null, ...serverAuditContextMetadata({ actorRole: caller.role }) },
      }, tx);
      return row;
    });
    if (!removed) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }
    forgetSsoRequirementCache();
    res.status(204).end();
  } catch (error) {
    logFailure("DELETE /sso/domains/:domainId", error);
    res.status(500).json({ error: "Failed to remove the domain" });
  }
});
