import express, { type ErrorRequestHandler, type RequestHandler, type Router } from "express";

import {
  asMachineId,
  isAdminOrOwner,
  RUNTIME_AUTH_SERVER_GATED_RUNTIMES,
  isRuntimeAccountUsageProvider,
  isRuntimeAuthPastedCode,
  isRuntimeAuthRuntime,
  isRuntimeAuthServerGated,
  isRuntimeLimitResetIdempotencyKey,
  isRuntimeLimitResetKind,
  claudeFiveHourLimitOf,
  CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY,
  parseRuntimeAuthProviderConnectInput,
  runtimeAuthLoginRegionFits,
  runtimeAuthOAuthMethodFits,
  runtimeAuthProviderConnectFits,
  runtimeAuthProviderIdFits,
  runtimeAuthSupports,
  runtimeLimitResetResultSchema,
  runtimeLimitResetsReadResultSchema,
  RAFT_CLIENT_CAPABILITIES_HEADER,
  runtimeAccountUsageSnapshotForClient,
  safeParseRuntimeAccountUsageSnapshot,
  type RuntimeAccountUsageProvider,
  type RuntimeLimitResetResult,
  type RuntimeLimitResetsReadResult,
  type RuntimeAuthAction,
  type RuntimeAuthProviderConnectField,
  type RuntimeAuthRuntime,
  type RuntimeAuthStatusReport,
} from "@botiverse/raft-shared";

import { getActorServerRoleInServer, actorRoleHasServerCapability } from "../lib/actorPermissions";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { getComputerLinkedMachineAttachers } from "../services/computerCredentialService";
import { evaluateFeatureFlag } from "../services/featureFlagService";
import { runtimeAccountUsageCacheService } from "../services/runtimeAccountUsageCacheService";
import * as machineService from "../services/machineService";
import { isRuntimeRevived, resolveRuntimeAdmissionPolicy } from "../services/runtimeAdmissionService";
import { runtimeAuthService } from "../services/runtimeAuthService";
import { addTraceEvent } from "../tracing/semanticTrace";
import { RouteFailureError } from "../tracing/routeFailure";
import { refuse } from "../lib/refusal";

/**
 * task #17: log a Computer's runtime (Claude Code, Codex, Kimi, Qoder, Antigravity, Grok, CodeBuddy, and
 * Pi and OpenCode per model provider) in or out from the web, or save a Qwen Code, Pi or
 * OpenCode provider's API key on it
 * (docs/contracts/runtime-auth.md). People only: `/api/servers` takes a user
 * session, never an agent credential.
 *
 * - See status: the human who attached the Computer, or `editMachines`.
 * - Log in, log out, cancel, list providers, connect one, use a limit reset,
 *   read which Claude limit resets the account holds: the human who attached
 *   it, or a server owner or admin.
 * - A login's code and cancel answer 404 to anyone but the person who started
 *   it, so another person's login is never revealed.
 * - The pasted code and a provider's API key are never logged, traced,
 *   stored or echoed, on success or failure.
 */

type MachineRecord = NonNullable<Awaited<ReturnType<typeof machineService.getMachine>>>;
interface Actors {
  machine: MachineRecord;
  canView: boolean;
  canAct: boolean;
  /**
   * The caller is the person who connected this Computer. Its Claude account is
   * usually their own subscription, so only they may spend its Claude limit
   * resets (redeem, or a read with consent at the 5-hour limit).
   */
  attachedByCaller: boolean;
  /** A Computer with no attaching human cannot relay a login (its events would be dropped). */
  attached: boolean;
}

/** The code route, parsed before the global JSON parser so a malformed body is never echoed into a log. */
export const RUNTIME_AUTH_CODE_PATH = "/api/servers/:id/machines/:machineId/runtime-auth/:runtime/login/:loginId/code";
export const runtimeAuthCodeBodyParser: RequestHandler = express.json({ limit: "8kb" });
/** Not JSON, or too large: the route's own 400, without the parser's error (which can quote the body). */
export const runtimeAuthCodeBodyErrorHandler: ErrorRequestHandler = (_err, _req, res, _next) => {
  res.status(400).json({ error: "Paste the whole code from the sign-in page.", code: "invalid_code" });
};

/**
 * The provider connect route. Its body carries a provider's API key, so it is
 * parsed here, ahead of the global JSON parser, whose error can quote the
 * body: a malformed one gets this route's own plain 400.
 */
export const RUNTIME_AUTH_CONNECT_PROVIDER_PATH = "/api/servers/:id/machines/:machineId/runtime-auth/:runtime/connect-provider";
export const runtimeAuthConnectProviderBodyParser: RequestHandler = express.json({ limit: "16kb" });
export const runtimeAuthConnectProviderBodyErrorHandler: ErrorRequestHandler = (_err, _req, res, _next) => {
  res.status(400).json({ error: "Check the provider details and try again.", code: "invalid_input" });
};

/** A connect's field the person can fix, by name only. */
const CONNECT_FIELD_ERRORS: Record<RuntimeAuthProviderConnectField, { error: string; code: string }> = {
  providerId: { error: "Choose a provider.", code: "invalid_provider" },
  apiKey: { error: "Paste the whole API key.", code: "invalid_api_key" },
  baseUrl: { error: "Enter an http or https URL.", code: "invalid_base_url" },
  modelIds: { error: "Enter the model's name.", code: "invalid_model" },
};

async function resolveActors(serverId: string, machineIdParam: string, userId: string): Promise<Actors | null> {
  const machine = await machineService.getMachine(asMachineId(machineIdParam));
  if (!machine || machine.serverId !== serverId) return null;
  const [callerRole, attachers] = await Promise.all([
    getActorServerRoleInServer(serverId, "user", userId),
    getComputerLinkedMachineAttachers(serverId),
  ]);
  const attachedByCaller = attachers.get(machine.id) === userId;
  return {
    machine,
    canView: attachedByCaller || actorRoleHasServerCapability(callerRole, "editMachines"),
    canAct: attachedByCaller || isAdminOrOwner(callerRole),
    attachedByCaller,
    attached: Boolean(attachers.get(machine.id)),
  };
}

function orchestratorOf(req: { app: { get(name: string): unknown } }): AgentOrchestrator {
  return req.app.get("agentOrchestrator") as AgentOrchestrator;
}

type Unavailable = "computer_offline" | "computer_upgrade_required" | "computer_not_attached";

function sendAvailabilityError(res: { status(code: number): { json(body: unknown): void } }, availability: Unavailable): void {
  res.status(409).json(
    availability === "computer_offline"
      ? { error: "This Computer is offline.", code: "computer_offline" }
      : availability === "computer_not_attached"
        ? { error: "This Computer has no owner, so its runtimes cannot be signed in from here.", code: "computer_not_attached" }
        : { error: "Upgrade this Computer to sign in from here.", code: "computer_upgrade_required" },
  );
}

/**
 * The server-gated runtimes (Antigravity) this server does not offer: those
 * whose deprecated runtime its flag does not revive
 * (`agent_runtime_oar_antigravity`). Empty when none is gated off. A server
 * gated runtime's auth id is its Raft runtime id.
 */
async function runtimesNotOffered(serverId: string, userId: string): Promise<ReadonlySet<RuntimeAuthRuntime>> {
  const policy = await resolveRuntimeAdmissionPolicy({ serverId, userId });
  return new Set<RuntimeAuthRuntime>(RUNTIME_AUTH_SERVER_GATED_RUNTIMES.filter((runtime) => !isRuntimeRevived(runtime, policy)));
}

/** The stored report without the runtimes this server does not offer. */
function offeredStatus(status: RuntimeAuthStatusReport | null, hidden: ReadonlySet<RuntimeAuthRuntime>): RuntimeAuthStatusReport | null {
  if (!status || hidden.size === 0) return status;
  const runtimes = { ...status.runtimes };
  for (const runtime of hidden) delete runtimes[runtime];
  return { ...status, runtimes };
}

/** The runtime named in the path, when OAR can take this action for it. */
function actionableRuntime(value: string | undefined, action: RuntimeAuthAction): RuntimeAuthRuntime | null {
  return isRuntimeAuthRuntime(value) && runtimeAuthSupports(value, action) ? value : null;
}

/** `claude_limit_reset` for this server; an evaluation failure reads as off. */
async function claudeLimitResetOn(serverId: string, userId: string): Promise<boolean> {
  try {
    return (await evaluateFeatureFlag({ key: CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY, serverId, userId })).enabled;
  } catch {
    return false;
  }
}

/** Claude limit resets are not offered on this server: as if the route did not exist for Claude. */
function refuseClaudeLimitResetOff(res: Parameters<typeof refuse>[0]): void {
  refuse(res, 404, { code: "claude_limit_reset_disabled", error: "Claude limit resets cannot be used from here on this server." });
}

/**
 * A Claude limit reset spent by someone other than the person who connected
 * this Computer: an owner or admin may view the resets but not spend them.
 */
function refuseClaudeLimitResetOwnerOnly(res: Parameters<typeof refuse>[0]): void {
  refuse(res, 403, { code: "claude_limit_reset_owner_only", error: "Only the person who connected this Computer can use its Claude limit resets." });
}

/**
 * What the card shows about Claude limit resets on this Computer, for a
 * person who may act: `ok` (the Computer answers Claude limit resets by kind,
 * through OAR) or `computer_upgrade_required` (a Computer without the
 * capability: an older one, or one on another platform than Linux, where the
 * card shows nothing). Absent while the flag is off,
 * the Computer is offline, or the viewer may not act: the card shows nothing.
 */
async function claudeLimitResetsView(req: { params: { id: string }; userId?: string; app: { get(name: string): unknown } }, actors: Actors): Promise<"ok" | "computer_upgrade_required" | undefined> {
  if (!actors.canAct || !actors.attached) return undefined;
  if (!await claudeLimitResetOn(req.params.id, req.userId!)) return undefined;
  const availability = await orchestratorOf(req).claudeLimitResetAvailability(actors.machine.id);
  return availability === "computer_offline" ? undefined : availability;
}

/**
 * Whether the cached usage leaves any doubt that the Claude account is NOT at
 * its 5-hour limit. The Computer refuses a read there without the person's
 * consent, and reads usage again itself before typing anything when this
 * says no.
 */
async function claudeAtFiveHourLimit(machineId: string): Promise<boolean> {
  try {
    const cached = await runtimeAccountUsageCacheService.read(machineId, "claude");
    return claudeFiveHourLimitOf(cached.snapshot) !== "not_at_limit";
  } catch {
    return true;
  }
}

export function mountRuntimeAuthRoutes(serverRouter: Router): void {
  serverRouter.get("/:id/machines/:machineId/runtime-auth", async (req, res) => {
    try {
      const actors = await resolveActors(req.params.id, req.params.machineId, req.userId!);
      if (!actors) {
        res.status(404).json({ error: "Computer not found" });
        return;
      }
      if (!actors.canView) {
        res.status(403).json({ error: "Only the person who connected this Computer, or an owner or admin, can see its runtime accounts" });
        return;
      }
      const [status, availability, hidden, claudeLimitResets] = await Promise.all([
        runtimeAuthService.getStatus(actors.machine.id),
        orchestratorOf(req).runtimeAuthAvailability(actors.machine.id),
        runtimesNotOffered(req.params.id, req.userId!),
        claudeLimitResetsView(req, actors),
      ]);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        // A runtime this server does not offer (Antigravity without its flag) is left out of both,
        // so the web shows it as before: no card, no orange badge, no sign-in notice.
        status: offeredStatus(status, hidden),
        availability: actors.attached || availability.state !== "ok" ? availability.state : "computer_not_attached",
        // The runtimes this Computer signs in from here: the web offers an upgrade instead for the others.
        runtimes: availability.state === "ok" ? availability.runtimes.filter((runtime) => !hidden.has(runtime)) : [],
        // The ones it also signs out from here (Antigravity only from a daemon that runs its logout).
        logoutRuntimes: availability.state === "ok" ? availability.logoutRuntimes.filter((runtime) => !hidden.has(runtime)) : [],
        canAct: actors.canAct,
        // Behind claude_limit_reset: the card's "View available resets" for Claude Code, or why there is none.
        ...(claudeLimitResets ? { claudeLimitResets } : {}),
        // What this viewer may do with them: only the person who connected the Computer spends its
        // Claude resets (a use, or a read with consent at the 5-hour limit). Advisory for the web;
        // the limit-reset routes enforce it either way.
        ...(claudeLimitResets ? { claudeLimitResetAccess: { canUse: actors.attachedByCaller, canConsent: actors.attachedByCaller } } : {}),
      });
    } catch {
      res.status(500).json({ error: "Failed to read runtime accounts" });
    }
  });

  serverRouter.post("/:id/machines/:machineId/runtime-auth/:runtime/login", async (req, res) => {
    try {
      const runtime = actionableRuntime(req.params.runtime, "login");
      if (!runtime) {
        res.status(404).json({ error: "This runtime cannot be signed in from the web" });
        return;
      }
      // Kimi's login needs the region the person chose; no other runtime takes one.
      const region: unknown = (req.body as { region?: unknown } | undefined)?.region;
      if (!runtimeAuthLoginRegionFits(runtime, region)) {
        res.status(400).json({ error: "Choose the region of the account to sign in.", code: "invalid_region" });
        return;
      }
      // Pi's and OpenCode's login names the provider to sign in; no other runtime's does.
      const providerId: unknown = (req.body as { providerId?: unknown } | undefined)?.providerId;
      if (!runtimeAuthProviderIdFits(runtime, providerId)) {
        refuse(res, 400, CONNECT_FIELD_ERRORS.providerId);
        return;
      }
      // OpenCode's may name the OAuth method the person chose (its label); no other runtime's does.
      const oauthMethod: unknown = (req.body as { oauthMethod?: unknown } | undefined)?.oauthMethod;
      if (!runtimeAuthOAuthMethodFits(runtime, oauthMethod)) {
        refuse(res, 400, { error: "Choose a way to sign in.", code: "invalid_oauth_method" });
        return;
      }
      const actors = await resolveActors(req.params.id, req.params.machineId, req.userId!);
      if (!actors) {
        res.status(404).json({ error: "Computer not found" });
        return;
      }
      if (!actors.canAct) {
        res.status(403).json({ error: "Only the person who connected this Computer, or an owner or admin, can sign its runtimes in or out" });
        return;
      }
      // Antigravity without its flag on this server: as if it could not be signed in at all.
      if (isRuntimeAuthServerGated(runtime) && (await runtimesNotOffered(req.params.id, req.userId!)).has(runtime)) {
        refuse(res, 404, { code: "runtime_auth_not_offered", error: "This runtime cannot be signed in from the web on this server." });
        return;
      }
      const orchestrator = orchestratorOf(req);
      const availability = await orchestrator.runtimeAuthAvailability(actors.machine.id);
      if (availability.state !== "ok") {
        sendAvailabilityError(res, availability.state);
        return;
      }
      // An older daemon drops a runtime it does not know: the person would wait for the login's TTL.
      if (!availability.runtimes.includes(runtime)) {
        sendAvailabilityError(res, "computer_upgrade_required");
        return;
      }
      if (!actors.attached) {
        sendAvailabilityError(res, "computer_not_attached");
        return;
      }
      const started = await runtimeAuthService.startLogin({ serverId: req.params.id, machineId: actors.machine.id, runtime, userId: req.userId!, connectionEpochId: availability.connectionEpochId });
      if (started.kind === "rate_limited") {
        addTraceEvent("runtime_auth.login.rate_limited", { machine_id: actors.machine.id, runtime, user_id: req.userId });
        res.status(429).json({ error: "Too many sign-in attempts on this Computer. Try again in a few minutes.", code: "rate_limited" });
        return;
      }
      if (started.kind === "login_in_progress") {
        res.status(409).json({ error: "A sign-in for this runtime is already running on this Computer.", code: "login_in_progress" });
        return;
      }
      try {
        await orchestrator.sendRuntimeAuthCommand(actors.machine.id, {
          type: "machine:runtime_auth:login:start",
          loginId: started.session.loginId,
          runtime,
          ...(region ? { region } : {}),
          ...(providerId ? { providerId } : {}),
          ...(oauthMethod ? { oauthMethod } : {}),
        });
      } catch (error) {
        await runtimeAuthService.endLogin(started.session);
        if (error instanceof RouteFailureError && error.subkind === "daemon_offline") {
          sendAvailabilityError(res, "computer_offline");
          return;
        }
        throw error;
      }
      // The login is bound to the connection read before the send; if the
      // Computer reconnected in between, that binding is wrong and the start
      // may have gone to the dead connection. Undo it and let the person retry.
      const after = await orchestrator.runtimeAuthAvailability(actors.machine.id);
      if (after.state !== "ok" || after.connectionEpochId !== started.session.connectionEpochId) {
        await orchestrator.sendRuntimeAuthCommand(actors.machine.id, { type: "machine:runtime_auth:login:cancel", loginId: started.session.loginId }).catch(() => undefined);
        await runtimeAuthService.endLogin(started.session);
        sendAvailabilityError(res, "computer_offline");
        return;
      }
      addTraceEvent("runtime_auth.login.started", { machine_id: actors.machine.id, runtime, region, provider_id: providerId, user_id: req.userId });
      res.status(200).json({ loginId: started.session.loginId });
    } catch {
      res.status(500).json({ error: "Failed to start the sign-in" });
    }
  });

  serverRouter.post("/:id/machines/:machineId/runtime-auth/:runtime/login/:loginId/code", async (req, res) => {
    // The body carries the one-time code: nothing below logs, traces or echoes it.
    try {
      const actors = await resolveActors(req.params.id, req.params.machineId, req.userId!);
      const session = actors?.canAct
        ? await runtimeAuthService.getSessionForRequester({ loginId: req.params.loginId, machineId: actors.machine.id, runtime: req.params.runtime, userId: req.userId! })
        : null;
      if (!actors || !session) {
        res.status(404).json({ error: "Sign-in not found" });
        return;
      }
      // Trimmed first: a paste often brings a trailing line break.
      const code = typeof req.body?.code === "string" ? req.body.code.trim() : null;
      if (!isRuntimeAuthPastedCode(code)) {
        res.status(400).json({ error: "Paste the whole code from the sign-in page.", code: "invalid_code" });
        return;
      }
      try {
        await orchestratorOf(req).sendRuntimeAuthCommand(actors.machine.id, { type: "machine:runtime_auth:login:code", loginId: session.loginId, code });
      } catch (error) {
        if (error instanceof RouteFailureError && error.subkind === "daemon_offline") {
          sendAvailabilityError(res, "computer_offline");
          return;
        }
        throw error;
      }
      addTraceEvent("runtime_auth.login.code_relayed", { machine_id: actors.machine.id, runtime: session.runtime, user_id: req.userId });
      res.status(202).json({ accepted: true });
    } catch {
      res.status(500).json({ error: "Failed to send the code" });
    }
  });

  serverRouter.post("/:id/machines/:machineId/runtime-auth/:runtime/login/:loginId/cancel", async (req, res) => {
    try {
      const actors = await resolveActors(req.params.id, req.params.machineId, req.userId!);
      const session = actors?.canAct
        ? await runtimeAuthService.getSessionForRequester({ loginId: req.params.loginId, machineId: actors.machine.id, runtime: req.params.runtime, userId: req.userId! })
        : null;
      if (!actors || !session) {
        res.status(404).json({ error: "Sign-in not found" });
        return;
      }
      try {
        await orchestratorOf(req).sendRuntimeAuthCommand(actors.machine.id, { type: "machine:runtime_auth:login:cancel", loginId: session.loginId });
      } catch (error) {
        // An offline Computer has already stopped the login (a disconnect cancels it); release it here too.
        if (!(error instanceof RouteFailureError && error.subkind === "daemon_offline")) throw error;
        await runtimeAuthService.endLogin(session);
      }
      addTraceEvent("runtime_auth.login.cancel_requested", { machine_id: actors.machine.id, runtime: session.runtime, user_id: req.userId });
      res.status(202).json({ accepted: true });
    } catch {
      res.status(500).json({ error: "Failed to cancel the sign-in" });
    }
  });

  serverRouter.post("/:id/machines/:machineId/runtime-auth/:runtime/logout", async (req, res) => {
    try {
      const runtime = actionableRuntime(req.params.runtime, "logout");
      if (!runtime) {
        res.status(404).json({ error: "This runtime cannot be signed out from the web" });
        return;
      }
      // Pi and OpenCode sign out one provider at a time, named here; no other runtime takes one.
      const providerId: unknown = (req.body as { providerId?: unknown } | undefined)?.providerId;
      if (!runtimeAuthProviderIdFits(runtime, providerId)) {
        refuse(res, 400, CONNECT_FIELD_ERRORS.providerId);
        return;
      }
      const actors = await resolveActors(req.params.id, req.params.machineId, req.userId!);
      if (!actors) {
        res.status(404).json({ error: "Computer not found" });
        return;
      }
      if (!actors.canAct) {
        res.status(403).json({ error: "Only the person who connected this Computer, or an owner or admin, can sign its runtimes in or out" });
        return;
      }
      // Antigravity without its flag on this server: answered as its login is there.
      if (isRuntimeAuthServerGated(runtime) && (await runtimesNotOffered(req.params.id, req.userId!)).has(runtime)) {
        refuse(res, 404, { code: "runtime_auth_not_offered", error: "This runtime cannot be signed out from the web on this server." });
        return;
      }
      const orchestrator = orchestratorOf(req);
      const availability = await orchestrator.runtimeAuthAvailability(actors.machine.id);
      if (availability.state !== "ok") {
        sendAvailabilityError(res, availability.state);
        return;
      }
      // An older daemon drops a runtime it does not know, or (Antigravity on OAR 0.97) answers its logout unsupported.
      if (!availability.logoutRuntimes.includes(runtime)) {
        sendAvailabilityError(res, "computer_upgrade_required");
        return;
      }
      try {
        const result = await orchestrator.logoutRuntime(actors.machine.id, runtime, providerId);
        addTraceEvent("runtime_auth.logout.result", {
          machine_id: actors.machine.id,
          runtime,
          provider_id: providerId,
          user_id: req.userId,
          outcome: result.kind,
          ...("reason" in result ? { reason: result.reason } : {}),
        });
        res.status(200).json({ result });
      } catch (error) {
        if (error instanceof RouteFailureError && error.subkind === "daemon_timeout") {
          res.status(504).json({ error: "The Computer did not answer in time. Try again.", code: "computer_timeout" });
          return;
        }
        if (error instanceof RouteFailureError && error.subkind === "daemon_offline") {
          sendAvailabilityError(res, "computer_offline");
          return;
        }
        throw error;
      }
    } catch {
      res.status(500).json({ error: "Failed to sign out" });
    }
  });

  /**
   * Spend one of a runtime account's limit resets on this Computer (Codex,
   * OAR `redeemLimitReset`; Claude, by `kind`, behind claude_limit_reset).
   * Codex: same people as a sign-out, the human who attached it or a server
   * owner or admin. Claude: only the human who attached it (its Claude
   * account is usually their own subscription; an owner or admin is refused
   * `claude_limit_reset_owner_only`). Never an agent (`/api/servers`
   * takes a user session only, and no agent route or CLI command reaches it).
   * The web mints `idempotencyKey` once per confirmed click and sends it again
   * to retry an attempt whose outcome it never learned; it is passed through
   * unchanged, so a retry never spends a second reset. Answers OAR's outcome
   * (or `unknown`) with the usage read the Computer ran right after it.
   *
   * Claude needs a `kind` (the Computer never picks one) and a Computer with
   * DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET_CLAUDE_KINDS. The result shapes an
   * older web bundle cannot read (`fiveHourSpent`, the Claude driver's
   * unsupported reasons) answer only a request that named a kind, which only
   * the current bundle sends: a Claude redeem without one is refused here,
   * and a Codex redeem never yields them.
   */
  serverRouter.post("/:id/machines/:machineId/runtime-account-usage/:provider/limit-reset", async (req, res) => {
    try {
      const provider = req.params.provider;
      if (!isRuntimeAccountUsageProvider(provider)) {
        refuse(res, 404, { code: "provider_not_found", error: "This runtime account usage provider does not exist." });
        return;
      }
      const actors = await resolveActors(req.params.id, req.params.machineId, req.userId!);
      if (!actors) {
        refuse(res, 404, { code: "computer_not_found", error: "This Computer is not on this server." });
        return;
      }
      if (!actors.canAct) {
        refuse(res, 403, { code: "forbidden", error: "Only the person who connected this Computer, or an owner or admin, can use its limit resets." });
        return;
      }
      const idempotencyKey: unknown = req.body?.idempotencyKey;
      if (!isRuntimeLimitResetIdempotencyKey(idempotencyKey)) {
        refuse(res, 400, { code: "invalid_idempotency_key", error: "The request needs an idempotency key of 16 to 128 letters, digits, dashes or underscores." });
        return;
      }
      const kindValue: unknown = req.body?.kind;
      if (kindValue !== undefined && (provider !== "claude" || !isRuntimeLimitResetKind(kindValue))) {
        refuse(res, 400, { code: "invalid_kind", error: "Choose one of Claude's limit resets: five_hour, weekly, fable or full." });
        return;
      }
      const kind = isRuntimeLimitResetKind(kindValue) ? kindValue : undefined;
      if (provider === "claude") {
        if (!await claudeLimitResetOn(req.params.id, req.userId!)) {
          refuseClaudeLimitResetOff(res);
          return;
        }
        if (!actors.attachedByCaller) {
          refuseClaudeLimitResetOwnerOnly(res);
          return;
        }
        if (!kind) {
          refuse(res, 400, { code: "kind_required", error: "Choose which of Claude's limit resets to use." });
          return;
        }
      }
      const orchestrator = orchestratorOf(req);
      const availability = provider === "claude"
        ? await orchestrator.claudeLimitResetAvailability(actors.machine.id)
        : await orchestrator.runtimeLimitResetAvailability(actors.machine.id);
      if (availability !== "ok") {
        refuse(res, 409, availability === "computer_offline"
          ? { code: "computer_offline", error: "This Computer is offline." }
          : { code: "computer_upgrade_required", error: "Upgrade this Computer to use a limit reset from here." });
        return;
      }
      if (!actors.attached) {
        // Its usage cannot be cached without an attaching human, so the reset's effect could not be shown.
        sendAvailabilityError(res, "computer_not_attached");
        return;
      }
      // Each Claude redeem starts the person's Claude Code on the Computer: bounded per person and Computer.
      if (provider === "claude" && !await runtimeAuthService.allowClaudeLimitResetRequest("redeem", req.userId!, actors.machine.id)) {
        addTraceEvent("runtime_account_usage.limit_reset.rate_limited", { machine_id: actors.machine.id, provider, user_id: req.userId });
        sendRateLimited(res);
        return;
      }
      try {
        const reply = await orchestrator.redeemRuntimeLimitReset(actors.machine.id, provider, idempotencyKey, kind);
        const parsedResult = runtimeLimitResetResultSchema.safeParse(reply.result);
        // An answer this server cannot read says nothing about whether a reset was spent.
        const result: RuntimeLimitResetResult = parsedResult.success ? parsedResult.data : { kind: "unknown" };
        const parsedSnapshot = reply.snapshot === undefined ? null : safeParseRuntimeAccountUsageSnapshot(reply.snapshot);
        addTraceEvent("runtime_account_usage.limit_reset.result", {
          machine_id: actors.machine.id,
          provider,
          user_id: req.userId,
          outcome: result.kind,
          ...("reason" in result ? { reason: result.reason } : {}),
          ...(kind ? { reset_kind: kind } : {}),
          ...(result.kind === "unknown" && result.fiveHourSpent ? { five_hour_spent: true } : {}),
          snapshot: parsedSnapshot?.success ? "fresh" : "none",
        });
        res.setHeader("Cache-Control", "private, no-store");
        // Window scopes only to a client that reads them (an older web bundle's strict parse would drop the snapshot).
        const snapshot = parsedSnapshot?.success ? runtimeAccountUsageSnapshotForClient(parsedSnapshot.data, req.header(RAFT_CLIENT_CAPABILITIES_HEADER)) : null;
        res.status(200).json({ result, snapshot });
      } catch (error) {
        if (error instanceof RouteFailureError && error.subkind === "daemon_timeout") {
          addTraceEvent("runtime_account_usage.limit_reset.result", { machine_id: actors.machine.id, provider, user_id: req.userId, outcome: "timeout" });
          res.status(504).json({ error: "The Computer did not answer in time. Try again; it won't use a second reset.", code: "computer_timeout" });
          return;
        }
        if (error instanceof RouteFailureError && error.subkind === "daemon_offline") {
          addTraceEvent("runtime_account_usage.limit_reset.result", { machine_id: actors.machine.id, provider, user_id: req.userId, outcome: "computer_offline" });
          sendAvailabilityError(res, "computer_offline");
          return;
        }
        throw error;
      }
    } catch {
      res.status(500).json({ error: "Failed to use a limit reset" });
    }
  });

  /**
   * Read which limit resets a Claude account holds on this Computer, behind
   * claude_limit_reset: its daemon opens Claude Code's own command for each
   * kind and cancels it. Only on a person's click (POST: on Claude's older
   * program, opening the command at the 5-hour limit spends that reset), by
   * the person who connected the Computer or an owner or admin.
   * `consent: true` says the person accepted that; without it the Computer
   * refuses a read at the limit (`unsupported: consent_required`). A read
   * with consent can spend the 5-hour reset, so only the person who
   * connected the Computer may send one (`claude_limit_reset_owner_only`).
   * Answers the Computer's read, or `unknown` when it cannot be read. A new route: only a web bundle that
   * reads these shapes calls it.
   */
  serverRouter.post("/:id/machines/:machineId/runtime-account-usage/:provider/limit-resets/read", async (req, res) => {
    try {
      const provider = req.params.provider;
      if (provider !== "claude") {
        refuse(res, 404, { code: "provider_not_found", error: "Only Claude's limit resets can be read from here." });
        return;
      }
      const actors = await resolveActors(req.params.id, req.params.machineId, req.userId!);
      if (!actors) {
        refuse(res, 404, { code: "computer_not_found", error: "This Computer is not on this server." });
        return;
      }
      if (!actors.canAct) {
        refuse(res, 403, { code: "forbidden", error: "Only the person who connected this Computer, or an owner or admin, can see its Claude limit resets." });
        return;
      }
      if (!await claudeLimitResetOn(req.params.id, req.userId!)) {
        refuseClaudeLimitResetOff(res);
        return;
      }
      const consent: unknown = req.body?.consent;
      if (consent !== undefined && typeof consent !== "boolean") {
        refuse(res, 400, { code: "invalid_consent", error: "consent is true or false." });
        return;
      }
      if (consent === true && !actors.attachedByCaller) {
        refuseClaudeLimitResetOwnerOnly(res);
        return;
      }
      const orchestrator = orchestratorOf(req);
      const availability = await orchestrator.claudeLimitResetAvailability(actors.machine.id);
      if (availability !== "ok") {
        refuse(res, 409, availability === "computer_offline"
          ? { code: "computer_offline", error: "This Computer is offline." }
          : { code: "computer_upgrade_required", error: "Upgrade this Computer to see its Claude limit resets from here." });
        return;
      }
      if (!actors.attached) {
        sendAvailabilityError(res, "computer_not_attached");
        return;
      }
      // Each read starts the person's Claude Code on the Computer: bounded per person and Computer.
      if (!await runtimeAuthService.allowClaudeLimitResetRequest("read", req.userId!, actors.machine.id)) {
        addTraceEvent("runtime_account_usage.limit_resets.read.rate_limited", { machine_id: actors.machine.id, user_id: req.userId });
        sendRateLimited(res);
        return;
      }
      const usageProvider: RuntimeAccountUsageProvider = provider;
      try {
        const reply = await orchestrator.readRuntimeLimitResets(actors.machine.id, usageProvider, {
          atFiveHourLimit: await claudeAtFiveHourLimit(actors.machine.id),
          atFiveHourLimitConsent: consent === true,
          includeFiveHour: true,
        });
        const parsed = runtimeLimitResetsReadResultSchema.safeParse(reply.result);
        // An answer this server cannot read: nothing is known, not even whether the older program spent its reset.
        const result: RuntimeLimitResetsReadResult = parsed.success ? parsed.data : { kind: "unknown" };
        addTraceEvent("runtime_account_usage.limit_resets.read.result", {
          machine_id: actors.machine.id,
          provider: usageProvider,
          user_id: req.userId,
          outcome: result.kind,
          consent: consent === true,
          ...("reason" in result ? { reason: result.reason } : {}),
          ...(result.kind === "read" ? {
            ...(result.program ? { program: result.program } : {}),
            ...(result.fiveHourSpent ? { five_hour_spent: true } : {}),
            available_kinds: result.resets.filter((reset) => reset.state === "available").length,
          } : {}),
        });
        res.setHeader("Cache-Control", "private, no-store");
        res.status(200).json({ result });
      } catch (error) {
        if (error instanceof RouteFailureError && error.subkind === "daemon_timeout") {
          addTraceEvent("runtime_account_usage.limit_resets.read.result", { machine_id: actors.machine.id, provider: usageProvider, user_id: req.userId, outcome: "timeout" });
          res.status(504).json({ error: "The Computer did not answer in time. Try again.", code: "computer_timeout" });
          return;
        }
        if (error instanceof RouteFailureError && error.subkind === "daemon_offline") {
          sendAvailabilityError(res, "computer_offline");
          return;
        }
        throw error;
      }
    } catch {
      res.status(500).json({ error: "Failed to read the limit resets" });
    }
  });

  /**
   * The providers a runtime with `connect_provider` (Qwen Code) offers on this
   * Computer, read there. Relayed like a logout: the Computer answers or the
   * request ends at the relay budget.
   */
  serverRouter.get("/:id/machines/:machineId/runtime-auth/:runtime/providers", async (req, res) => {
    try {
      const target = await providerTarget(req, res);
      if (!target) return;
      if (!await runtimeAuthService.allowProviderRequest("list", req.userId!, target.machineId)) {
        addTraceEvent("runtime_auth.providers.rate_limited", { machine_id: target.machineId, runtime: target.runtime, user_id: req.userId });
        sendRateLimited(res);
        return;
      }
      try {
        const result = await orchestratorOf(req).listRuntimeProviders(target.machineId, target.runtime);
        addTraceEvent("runtime_auth.providers.result", {
          machine_id: target.machineId,
          runtime: target.runtime,
          user_id: req.userId,
          outcome: result.kind,
          ...("reason" in result ? { reason: result.reason } : {}),
          ...(result.kind === "listed" ? { provider_count: result.providers.length } : {}),
        });
        res.status(200).json({ result });
      } catch (error) {
        if (sendRelayFailure(res, error)) return;
        throw error;
      }
    } catch {
      res.status(500).json({ error: "Failed to read the providers" });
    }
  });

  /**
   * Saves a provider's API key in the runtime's settings on this Computer. The
   * key is checked here, sent once over that Computer's socket, and dropped:
   * nothing below stores, logs, traces or echoes it, on success or failure.
   */
  serverRouter.post("/:id/machines/:machineId/runtime-auth/:runtime/connect-provider", async (req, res) => {
    try {
      const parsed = parseRuntimeAuthProviderConnectInput(req.body);
      // Drop the body's reference to the key: only `parsed` carries it on.
      if (req.body && typeof req.body === "object") Reflect.deleteProperty(req.body, "apiKey");
      const target = await providerTarget(req, res);
      if (!target) return;
      if (!parsed.ok) {
        res.status(400).json(CONNECT_FIELD_ERRORS[parsed.field]);
        return;
      }
      // Pi and OpenCode take a provider and a key only, and only a key they keep
      // literal: for Pi one starting with `!` would be run as a command and a `$`
      // filled in from the environment on every Pi read; for OpenCode no
      // `{env:}` / `{file:}` reference. Named by its field, never echoed.
      const fits = runtimeAuthProviderConnectFits(target.runtime, parsed.input);
      if (!fits.ok) {
        refuse(res, 400, CONNECT_FIELD_ERRORS[fits.field]);
        return;
      }
      if (!await runtimeAuthService.allowProviderRequest("connect", req.userId!, target.machineId)) {
        addTraceEvent("runtime_auth.connect_provider.rate_limited", { machine_id: target.machineId, runtime: target.runtime, user_id: req.userId });
        sendRateLimited(res);
        return;
      }
      try {
        const result = await orchestratorOf(req).connectRuntimeProvider(target.machineId, target.runtime, parsed.input);
        addTraceEvent("runtime_auth.connect_provider.result", {
          machine_id: target.machineId,
          runtime: target.runtime,
          user_id: req.userId,
          // The runtime's provider id (Qwen's menu, pi's /login list), checked against a short pattern: no secret.
          provider_id: parsed.input.providerId,
          outcome: result.kind,
          ...("reason" in result ? { reason: result.reason } : {}),
        });
        res.status(200).json({ result });
      } catch (error) {
        if (sendRelayFailure(res, error)) return;
        throw error;
      }
    } catch {
      res.status(500).json({ error: "Failed to connect the provider" });
    }
  });
}

/**
 * The Computer and runtime a provider list or connect is for, once the
 * runtime has one, the person may act, and the Computer can take it now;
 * otherwise the answer is sent and null returned. An older daemon drops a
 * request for a runtime it does not know, so a Computer without its
 * capability gets 409 `computer_upgrade_required` instead of a wait.
 */
async function providerTarget(
  req: { params: Record<string, string | undefined>; userId?: string; app: { get(name: string): unknown } },
  res: { status(code: number): { json(body: unknown): void } },
): Promise<{ machineId: string; runtime: RuntimeAuthRuntime } | null> {
  const runtime = actionableRuntime(req.params.runtime, "connect_provider");
  if (!runtime) {
    res.status(404).json({ error: "This runtime has no provider to connect from the web" });
    return null;
  }
  const actors = await resolveActors(req.params.id!, req.params.machineId!, req.userId!);
  if (!actors) {
    res.status(404).json({ error: "Computer not found" });
    return null;
  }
  if (!actors.canAct) {
    res.status(403).json({ error: "Only the person who connected this Computer, or an owner or admin, can connect its runtimes to a provider" });
    return null;
  }
  const availability = await orchestratorOf(req).runtimeAuthAvailability(actors.machine.id);
  if (availability.state !== "ok") {
    sendAvailabilityError(res, availability.state);
    return null;
  }
  if (!availability.runtimes.includes(runtime)) {
    sendAvailabilityError(res, "computer_upgrade_required");
    return null;
  }
  if (!actors.attached) {
    sendAvailabilityError(res, "computer_not_attached");
    return null;
  }
  return { machineId: actors.machine.id, runtime };
}

function sendRateLimited(res: { status(code: number): { json(body: unknown): void } }): void {
  res.status(429).json({ error: "Too many attempts on this Computer. Try again in a few minutes.", code: "rate_limited" });
}

/** A relay that could not reach the Computer, or got no answer in time; false for any other error. */
function sendRelayFailure(res: { status(code: number): { json(body: unknown): void } }, error: unknown): boolean {
  if (error instanceof RouteFailureError && error.subkind === "daemon_timeout") {
    res.status(504).json({ error: "The Computer did not answer in time. Try again.", code: "computer_timeout" });
    return true;
  }
  if (error instanceof RouteFailureError && error.subkind === "daemon_offline") {
    sendAvailabilityError(res, "computer_offline");
    return true;
  }
  return false;
}
