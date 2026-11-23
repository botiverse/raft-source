import express, { type ErrorRequestHandler, type RequestHandler, type Router } from "express";

import {
  asMachineId,
  asMachineOperationId,
  asServerId,
  type MachineOperationStarted,
  isRuntimeAccountUsageProvider,
  isRuntimeAuthPastedCode,
  isRuntimeAuthRuntime,
  isRuntimeLimitResetIdempotencyKey,
  isRuntimeLimitResetKind,
  claudeFiveHourLimitOf,
  CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY,
  RUNTIME_UPGRADE_FEATURE_FLAG_KEY,
  RUNTIME_UPGRADE_RELAY_BUDGET_MS,
  runtimeUpgradeResultSchema,
  type RuntimeUpgradeResult,
  RUNTIME_INSTALL_FEATURE_FLAG_KEY,
  RUNTIME_INSTALL_RELAY_BUDGET_MS,
  runtimeInstallPlanSchema,
  runtimeInstallResultSchema,
  type RuntimeInstallPlan,
  type RuntimeInstallResult,
  parseRuntimeAuthProviderConnectInput,
  runtimeAuthLoginRegionFits,
  runtimeAuthOAuthMethodFits,
  runtimeAuthProviderConnectFits,
  runtimeAuthProviderIdFits,
  runtimeAuthSupports,
  runtimeLimitResetResultSchema,
  runtimeLimitResetsReadResultSchema,
  RAFT_CLIENT_CAPABILITIES_HEADER,
  safeParseRuntimeAccountUsageSnapshot,
  type RuntimeAccountUsageProvider,
  type RuntimeLimitResetResult,
  type RuntimeLimitResetsReadResult,
  type RuntimeAuthAction,
  type RuntimeAuthProviderConnectField,
  type RuntimeAuthRuntime,
  type RuntimeUpdates,
  type ServerRole,
} from "@botiverse/raft-shared";

import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { computerActorAllowed, controllerUserIdFromAttachers } from "../services/computerControlAuthorization";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { getComputerLinkedMachineAttachers } from "../services/computerCredentialService";
import { evaluateFeatureFlag } from "../services/featureFlagService";
import { recordIntegrationAuditEventBestEffort, serverAuditContextMetadata } from "../services/integrationAuditService";
import { claudeLimitResetReadSpentGuard } from "../services/claudeLimitResetReadSpentGuard";
import { runtimeAccountUsageCacheService } from "../services/runtimeAccountUsageCacheService";
import { runtimeAccountUsageSnapshotForViewer } from "../services/runtimeAccountUsageViewer";
import * as machineService from "../services/machineService";
import { runtimeAuthService } from "../services/runtimeAuthService";
import { recordLimitResetUsedByOther, spentLimitReset } from "../services/runtimeLimitResetUsedByOther";
import { addTraceEvent } from "../tracing/semanticTrace";
import { RouteFailureError } from "../tracing/routeFailure";
import { refuse } from "../lib/refusal";
import { readMachineOperation, startMachineOperation, type MachineOperationAnswer } from "../services/machineOperations";

/**
 * task #17: log a Computer's runtime (Claude Code, Codex, Kimi, Qoder, Antigravity, Grok, and
 * Pi and OpenCode per model provider) in or out from the web, or save a Qwen Code, Pi or
 * OpenCode provider's API key on it
 * (docs/contracts/runtime-auth.md). People only: `/api/servers` takes a user
 * session, never an agent credential.
 *
 * Both through computerActorAllowed (services/computerControlAuthorization.ts),
 * the one Computer check: its live attacher, or a role holding the action's
 * capability (today owner and admin).
 * - See status: the human who attached the Computer, or `edit` (`editMachines`).
 * - Log in, log out, cancel, list providers, connect one, use a limit reset,
 *   read which Claude limit resets the account holds: the human who attached
 *   it, or `control` (`controlComputers`: these send commands to the Computer). A limit reset an owner or admin uses on a
 *   Computer someone else attached is audited and that person is emailed
 *   (recordLimitResetUsedByOther).
 * - Upgrade a runtime's command-line tool (behind runtime_upgrade_button):
 *   the same people as a sign-in. Only when a person presses Upgrade; Raft
 *   never upgrades a runtime on its own.
 * - Read what installing a runtime would run, and install it (behind
 *   runtime_install_button): the same people as Upgrade (`canAct`). Only the
 *   runtime is taken from the request; what runs is OAR's on the Computer.
 *   Each install is recorded in the server audit (`computer.runtime_install`).
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
   * The caller is the person who connected this Computer. A limit reset anyone
   * else (an owner or admin) uses on it is audited and told to that person.
   */
  attachedByCaller: boolean;
  /** The person who connected this Computer, if anyone. */
  attachedBy: string | null;
  /** The caller's role on the server, as the permission check read it (for the audit). */
  callerRole: ServerRole | null;
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
  // The machine's controller: its live attacher (controllerUserIdFromAttachers), as on every Computer route.
  const attachedBy = controllerUserIdFromAttachers(attachers, machine);
  const attachedByCaller = attachedBy === userId;
  const actor = { userId, role: callerRole };
  return {
    machine,
    canView: computerActorAllowed(actor, attachedBy, "edit"),
    canAct: computerActorAllowed(actor, attachedBy, "control"),
    attachedByCaller,
    attachedBy,
    callerRole,
    attached: Boolean(attachedBy),
  };
}

function orchestratorOf(req: { app: { get(name: string): unknown } }): AgentOrchestrator {
  return req.app.get("agentOrchestrator") as AgentOrchestrator;
}

type Unavailable = "computer_offline" | "computer_upgrade_required" | "computer_not_attached";

function availabilityErrorBody(availability: Unavailable): { error: string; code: Unavailable } {
  return availability === "computer_offline"
    ? { error: "This Computer is offline.", code: "computer_offline" }
    : availability === "computer_not_attached"
      ? { error: "This Computer has no owner, so its runtimes cannot be signed in from here.", code: "computer_not_attached" }
      : { error: "Upgrade this Computer to sign in from here.", code: "computer_upgrade_required" };
}

function sendAvailabilityError(res: { status(code: number): { json(body: unknown): void } }, availability: Unavailable): void {
  res.status(409).json(availabilityErrorBody(availability));
}

/**
 * Answer what waits on the Computer (#otter-lounge:#1): at once, or, for a
 * client that asked (`respondAsync: true`), as 202 `{operationId}` with the
 * answer kept for GET …/machine-operations/:operationId, since the edge in
 * front of the API closes a request that sends nothing for 30 s.
 */
async function answerMachineWait(
  req: express.Request,
  res: express.Response,
  wait: () => Promise<MachineOperationAnswer>,
  failure: MachineOperationAnswer,
  /** How long the operation is kept; past the wait's own budget (MACHINE_OPERATION_TTL_SECONDS by default). */
  ttlSeconds?: number,
): Promise<void> {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.body?.respondAsync === true) {
    const operationId = await startMachineOperation({ userId: req.userId!, serverId: asServerId(req.serverId!), surface: "web" }, wait, failure, ttlSeconds);
    res.status(202).json({ operationId } satisfies MachineOperationStarted);
    return;
  }
  const answer = await wait().catch(() => failure);
  res.status(answer.status).json(answer.body);
}

/** The runtime named in the path, when OAR can take this action for it. */
function actionableRuntime(value: string | undefined, action: RuntimeAuthAction): RuntimeAuthRuntime | null {
  return isRuntimeAuthRuntime(value) && runtimeAuthSupports(value, action) ? value : null;
}

/** `claude_limit_reset_v2` for this server; an evaluation failure reads as off. */
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

/** An upgrade's wait (RUNTIME_UPGRADE_RELAY_BUDGET_MS) runs past the default operation TTL: kept two minutes longer than it. */
const RUNTIME_UPGRADE_OPERATION_TTL_SECONDS = Math.ceil(RUNTIME_UPGRADE_RELAY_BUDGET_MS / 1000) + 120;

/** `runtime_upgrade_button` for this server; an evaluation failure reads as off. */
async function runtimeUpgradeOn(serverId: string, userId: string): Promise<boolean> {
  try {
    return (await evaluateFeatureFlag({ key: RUNTIME_UPGRADE_FEATURE_FLAG_KEY, serverId, userId })).enabled;
  } catch {
    return false;
  }
}

/**
 * Whether the web offers Upgrade for this Computer's runtimes: the flag is on,
 * the viewer may sign its runtimes in, and the Computer is online and runs a
 * runtime's updater (DAEMON_CAPABILITY_RUNTIME_UPGRADE). Offered: the runtimes
 * its last status report named upgradable (possibly none), with the update
 * checks it reported for them (`updates`, possibly none); null otherwise.
 */
async function runtimeUpgradeOffered(req: { params: { id: string }; userId?: string; app: { get(name: string): unknown } }, actors: Actors): Promise<{ runtimes: RuntimeAuthRuntime[]; updates: RuntimeUpdates } | null> {
  if (!actors.canAct) return null;
  if (!await runtimeUpgradeOn(req.params.id, req.userId!)) return null;
  if ((await orchestratorOf(req).runtimeUpgradeAvailability(actors.machine.id)) !== "ok") return null;
  const [runtimes, updates] = await Promise.all([
    runtimeAuthService.getUpgradable(actors.machine.id),
    runtimeAuthService.getUpdates(actors.machine.id),
  ]);
  return { runtimes, updates };
}

/** The update checks of the runtimes Upgrade is offered for, and only theirs. */
function offeredRuntimeUpdates(updates: RuntimeUpdates, offered: readonly RuntimeAuthRuntime[]): RuntimeUpdates {
  return Object.fromEntries(offered.flatMap((runtime) => (updates[runtime] ? [[runtime, updates[runtime]]] : [])));
}

/** An install's wait (RUNTIME_INSTALL_RELAY_BUDGET_MS) runs past the default operation TTL: kept two minutes longer than it. */
const RUNTIME_INSTALL_OPERATION_TTL_SECONDS = Math.ceil(RUNTIME_INSTALL_RELAY_BUDGET_MS / 1000) + 120;

/** `runtime_install_button` for this server; an evaluation failure reads as off. */
async function runtimeInstallOn(serverId: string, userId: string): Promise<boolean> {
  try {
    return (await evaluateFeatureFlag({ key: RUNTIME_INSTALL_FEATURE_FLAG_KEY, serverId, userId })).enabled;
  } catch {
    return false;
  }
}

/**
 * Whether the web offers Install for this Computer's runtimes: as Upgrade
 * (`runtimeUpgradeOffered`), the flag is on, the viewer may act (`canAct`),
 * and the Computer is online and runs a runtime's installer
 * (DAEMON_CAPABILITY_RUNTIME_INSTALL). Offered: the runtimes its last status
 * report named installable (possibly none); null otherwise.
 */
async function runtimeInstallOffered(req: { params: { id: string }; userId?: string; app: { get(name: string): unknown } }, actors: Actors): Promise<RuntimeAuthRuntime[] | null> {
  if (!actors.canAct) return null;
  if (!await runtimeInstallOn(req.params.id, req.userId!)) return null;
  if ((await orchestratorOf(req).runtimeInstallAvailability(actors.machine.id)) !== "ok") return null;
  return runtimeAuthService.getInstallable(actors.machine.id);
}

/**
 * The checks both Install routes make before anything reaches the Computer,
 * in Upgrade's order: the flag (404), a runtime id (404), the Computer on
 * this server (404), the same people as Upgrade (`resolveActors(...).canAct`,
 * 403), a server-gated runtime not offered here (404), and a Computer online
 * that runs installers (409). Answers and returns null on a refusal.
 */
async function installRouteTarget(
  req: { params: { id: string; machineId: string; runtime: string }; userId?: string; app: { get(name: string): unknown } },
  res: express.Response,
): Promise<{ actors: Actors; runtime: RuntimeAuthRuntime; orchestrator: AgentOrchestrator } | null> {
  if (!await runtimeInstallOn(req.params.id, req.userId!)) {
    refuse(res, 404, { code: "runtime_install_disabled", error: "Runtimes cannot be installed from here on this server." });
    return null;
  }
  const runtime = isRuntimeAuthRuntime(req.params.runtime) ? req.params.runtime : null;
  if (!runtime) {
    refuse(res, 404, { code: "runtime_not_installable", error: "This runtime cannot be installed from the web." });
    return null;
  }
  const actors = await resolveActors(req.params.id, req.params.machineId, req.userId!);
  if (!actors) {
    refuse(res, 404, { code: "computer_not_found", error: "This Computer was not found on this server." });
    return null;
  }
  if (!actors.canAct) {
    refuse(res, 403, { code: "forbidden", error: "Only the person who connected this Computer, or an owner or admin, can install its runtimes." });
    return null;
  }
  const orchestrator = orchestratorOf(req);
  // An older daemon drops the request: say so rather than wait.
  const availability = await orchestrator.runtimeInstallAvailability(actors.machine.id);
  if (availability !== "ok") {
    refuse(res, 409, availability === "computer_offline"
      ? availabilityErrorBody("computer_offline")
      : { code: "computer_upgrade_required", error: "Update this Computer to install runtimes from here." });
    return null;
  }
  return { actors, runtime, orchestrator };
}

/** How an install attempt ended, for its audit record: the Computer's outcome, or the request's end without one. */
type RuntimeInstallEnd = RuntimeInstallResult | { kind: "computer_timeout" | "computer_offline" | "request_failed" };

/**
 * The Computer's record of an install attempt (`computer.runtime_install`):
 * who pressed it, the runtime, how it ended. Best effort: the install has
 * already happened (or not) on the Computer.
 */
async function recordRuntimeInstall(serverId: string, actors: Actors, userId: string, runtime: RuntimeAuthRuntime, end: RuntimeInstallEnd): Promise<void> {
  await recordIntegrationAuditEventBestEffort({
    serverId,
    eventType: "computer.runtime_install",
    outcome: end.kind === "installed" || end.kind === "already_installed" ? "success" : "failure",
    source: "web",
    actor: { type: "human", id: userId },
    target: { type: "machine", id: actors.machine.id },
    metadata: {
      machineId: actors.machine.id,
      machineName: actors.machine.name,
      runtime,
      result: end.kind,
      ...((end.kind === "installed" || end.kind === "already_installed") && end.version ? { version: end.version } : {}),
      ...(end.kind === "failed" ? { exitCode: end.exitCode } : {}),
      ...(end.kind === "unsupported" ? { reason: end.reason } : {}),
      ...(end.kind === "error" ? { errorCode: end.code } : {}),
      ...serverAuditContextMetadata({ actorRole: actors.callerRole }),
    },
  });
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

/** Whether a read on this Computer already spent its Claude account's 5-hour reset; a failed lookup forwards the use as before. */
async function claudeFiveHourSpentByRead(machineId: string): Promise<boolean> {
  try {
    return await claudeLimitResetReadSpentGuard.readSpent(machineId);
  } catch {
    return false;
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
      const [status, availability, claudeLimitResets, runtimeUpgrade, runtimeInstall] = await Promise.all([
        runtimeAuthService.getStatus(actors.machine.id),
        orchestratorOf(req).runtimeAuthAvailability(actors.machine.id),
        claudeLimitResetsView(req, actors),
        runtimeUpgradeOffered(req, actors),
        runtimeInstallOffered(req, actors),
      ]);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        status,
        availability: actors.attached || availability.state !== "ok" ? availability.state : "computer_not_attached",
        // The runtimes this Computer signs in from here: the web offers an upgrade instead for the others.
        runtimes: availability.state === "ok" ? availability.runtimes : [],
        // The ones it also signs out from here (Antigravity only from a daemon that runs its logout).
        logoutRuntimes: availability.state === "ok" ? availability.logoutRuntimes : [],
        canAct: actors.canAct,
        // Behind claude_limit_reset_v2: the card's "View available resets" for Claude Code, or why there is none.
        ...(claudeLimitResets ? { claudeLimitResets } : {}),
        // What this viewer may do with them: the same people who see them (the person who connected
        // the Computer, or an owner or admin) use them and consent to a read at the 5-hour limit, so
        // both are true whenever it is sent. Kept for older web bundles, which read `canUse` (false
        // there meant a view-only list); the limit-reset routes enforce the rule either way.
        ...(claudeLimitResets ? { claudeLimitResetAccess: { canUse: actors.canAct, canConsent: actors.canAct } } : {}),
        // Behind runtime_upgrade_button, for a viewer who may act on a Computer that runs a runtime's updater:
        // Upgrade is offered, on the card for each runtime the Computer reports it can upgrade.
        // `runtimeUpdates`: the Computer's update check for those it checked, so Upgrade is offered only where there is a newer version.
        ...(runtimeUpgrade
          ? { runtimeUpgrade: true, upgradableRuntimes: runtimeUpgrade.runtimes, runtimeUpdates: offeredRuntimeUpdates(runtimeUpgrade.updates, runtimeUpgrade.runtimes) }
          : {}),
        // Behind runtime_install_button, for the same viewers as Upgrade on a Computer that runs a runtime's installer:
        // Install is offered on the "not installed" chip of each runtime the Computer reports it can install.
        ...(runtimeInstall ? { runtimeInstall: true, installableRuntimes: runtimeInstall } : {}),
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
      // Each sign-out runs on the Computer: bounded per person and Computer, like a connect.
      if (!await runtimeAuthService.allowProviderRequest("logout", req.userId!, actors.machine.id)) {
        addTraceEvent("runtime_auth.logout.rate_limited", { machine_id: actors.machine.id, runtime, user_id: req.userId });
        sendRateLimited(res);
        return;
      }
      await answerMachineWait(req, res, async (): Promise<MachineOperationAnswer> => {
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
          return { status: 200, body: { result } };
        } catch (error) {
          if (error instanceof RouteFailureError && error.subkind === "daemon_timeout") {
            return { status: 504, body: { error: "The Computer did not answer in time. Try again.", code: "computer_timeout" } };
          }
          if (error instanceof RouteFailureError && error.subkind === "daemon_offline") {
            return { status: 409, body: availabilityErrorBody("computer_offline") };
          }
          throw error;
        }
      }, { status: 500, body: { error: "Failed to sign out" } });
    } catch {
      res.status(500).json({ error: "Failed to sign out" });
    }
  });

  /**
   * Upgrade a runtime's command-line tool on this Computer (behind
   * runtime_upgrade_button): the Computer runs the runtime's own updater
   * through OAR, then re-detects its runtimes. Same people as a sign-in.
   * Answers the outcome's kind and versions (never the updater's output);
   * waits on the Computer like a logout, for up to
   * RUNTIME_UPGRADE_RELAY_BUDGET_MS (`respondAsync` for the web).
   */
  serverRouter.post("/:id/machines/:machineId/runtimes/:runtime/upgrade", async (req, res) => {
    try {
      if (!await runtimeUpgradeOn(req.params.id, req.userId!)) {
        refuse(res, 404, { code: "runtime_upgrade_disabled", error: "Runtimes cannot be upgraded from here on this server." });
        return;
      }
      const runtime = isRuntimeAuthRuntime(req.params.runtime) ? req.params.runtime : null;
      if (!runtime) {
        refuse(res, 404, { code: "runtime_not_upgradable", error: "This runtime cannot be upgraded from the web." });
        return;
      }
      const actors = await resolveActors(req.params.id, req.params.machineId, req.userId!);
      if (!actors) {
        refuse(res, 404, { code: "computer_not_found", error: "This Computer was not found on this server." });
        return;
      }
      if (!actors.canAct) {
        refuse(res, 403, { code: "forbidden", error: "Only the person who connected this Computer, or an owner or admin, can upgrade its runtimes." });
        return;
      }
      const orchestrator = orchestratorOf(req);
      // An older daemon drops the request: say so rather than wait.
      const availability = await orchestrator.runtimeUpgradeAvailability(actors.machine.id);
      if (availability !== "ok") {
        refuse(res, 409, availability === "computer_offline"
          ? availabilityErrorBody("computer_offline")
          : { code: "computer_upgrade_required", error: "Update this Computer to upgrade its runtimes from here." });
        return;
      }
      // Each upgrade runs the runtime's own updater there: bounded per person and Computer, like a sign-out.
      if (!await runtimeAuthService.allowProviderRequest("upgrade", req.userId!, actors.machine.id)) {
        addTraceEvent("runtime.upgrade.rate_limited", { machine_id: actors.machine.id, runtime, user_id: req.userId });
        sendRateLimited(res);
        return;
      }
      await answerMachineWait(req, res, async (): Promise<MachineOperationAnswer> => {
        const startedAt = Date.now();
        try {
          const reply = await orchestrator.upgradeRuntime(actors.machine.id, runtime);
          const parsed = runtimeUpgradeResultSchema.safeParse(reply);
          // An answer this server cannot read: an internal error, and nothing of it is traced or passed on.
          const result: RuntimeUpgradeResult = parsed.success ? parsed.data : { kind: "error", code: "internal" };
          if (!parsed.success) addTraceEvent("runtime.upgrade.result_rejected", { machine_id: actors.machine.id, runtime });
          addTraceEvent("runtime.upgrade.result", {
            machine_id: actors.machine.id,
            runtime,
            user_id: req.userId,
            outcome: result.kind,
            ...(result.kind === "upgraded" ? { from_version: result.from, to_version: result.to } : {}),
            ...("reason" in result ? { reason: result.reason } : {}),
            ...("code" in result ? { code: result.code } : {}),
            duration_ms: Date.now() - startedAt,
          });
          return { status: 200, body: { result } };
        } catch (error) {
          if (error instanceof RouteFailureError && error.subkind === "daemon_timeout") {
            return { status: 504, body: { error: "The Computer did not answer in time. Check the runtime's version on the Computer page.", code: "computer_timeout" } };
          }
          if (error instanceof RouteFailureError && error.subkind === "daemon_offline") {
            return { status: 409, body: availabilityErrorBody("computer_offline") };
          }
          throw error;
        }
      }, { status: 500, body: { error: "Failed to upgrade the runtime" } }, RUNTIME_UPGRADE_OPERATION_TTL_SECONDS);
    } catch {
      res.status(500).json({ error: "Failed to upgrade the runtime" });
    }
  });

  /**
   * What installing a runtime on this Computer would run (behind
   * runtime_install_button), read there without running anything: OAR's
   * plan, its steps as the person reads them and the vendor's page, or why
   * it will not run one (with the steps to run by hand where OAR gives them).
   * Same people as Upgrade. Only the runtime goes to the Computer. The steps
   * can name a home path: answered to this person only, never traced.
   */
  serverRouter.post("/:id/machines/:machineId/runtimes/:runtime/install-plan", async (req, res) => {
    try {
      const target = await installRouteTarget(req, res);
      if (!target) return;
      const { actors, runtime, orchestrator } = target;
      // Read each time Install is pressed, running nothing there: the provider list's bound, counted apart.
      if (!await runtimeAuthService.allowProviderRequest("install_plan", req.userId!, actors.machine.id)) {
        addTraceEvent("runtime.install.plan.rate_limited", { machine_id: actors.machine.id, runtime, user_id: req.userId });
        sendRateLimited(res);
        return;
      }
      await answerMachineWait(req, res, async (): Promise<MachineOperationAnswer> => {
        try {
          const reply = await orchestrator.runtimeInstallPlan(actors.machine.id, runtime);
          const parsed = runtimeInstallPlanSchema.safeParse(reply);
          // An answer this server cannot read: an internal error, and nothing of it is traced or passed on.
          const plan: RuntimeInstallPlan = parsed.success ? parsed.data : { kind: "error", code: "internal" };
          addTraceEvent("runtime.install.plan.result", {
            machine_id: actors.machine.id,
            runtime,
            user_id: req.userId,
            outcome: plan.kind,
            ...(plan.kind === "unsupported" ? { reason: plan.reason } : {}),
            rejected: !parsed.success,
          });
          return { status: 200, body: { plan } };
        } catch (error) {
          if (error instanceof RouteFailureError && error.subkind === "daemon_timeout") {
            return { status: 504, body: { error: "The Computer did not answer in time. Try again.", code: "computer_timeout" } };
          }
          if (error instanceof RouteFailureError && error.subkind === "daemon_offline") {
            return { status: 409, body: availabilityErrorBody("computer_offline") };
          }
          throw error;
        }
      }, { status: 500, body: { error: "Failed to read the install plan" } });
    } catch {
      res.status(500).json({ error: "Failed to read the install plan" });
    }
  });

  /**
   * Install a runtime that is not on this Computer (behind
   * runtime_install_button): the Computer runs the runtime's own official
   * installer through OAR (the plan the person was shown), then re-detects
   * its runtimes. Same people as Upgrade. The body names nothing: the
   * runtime is the path's, and what runs is OAR's there. Answers the
   * outcome's kind and version (never the installer's output); waits on the
   * Computer for up to RUNTIME_INSTALL_RELAY_BUDGET_MS (`respondAsync` for
   * the web). Every attempt that reaches the Computer is recorded
   * (`computer.runtime_install`) once it ends.
   */
  serverRouter.post("/:id/machines/:machineId/runtimes/:runtime/install", async (req, res) => {
    try {
      const target = await installRouteTarget(req, res);
      if (!target) return;
      const { actors, runtime, orchestrator } = target;
      // Each install runs the runtime's own installer there: bounded per person and Computer, like an upgrade.
      if (!await runtimeAuthService.allowProviderRequest("install", req.userId!, actors.machine.id)) {
        addTraceEvent("runtime.install.rate_limited", { machine_id: actors.machine.id, runtime, user_id: req.userId });
        sendRateLimited(res);
        return;
      }
      const serverId = req.params.id;
      const userId = req.userId!;
      await answerMachineWait(req, res, async (): Promise<MachineOperationAnswer> => {
        const startedAt = Date.now();
        let end: RuntimeInstallEnd = { kind: "request_failed" };
        try {
          const reply = await orchestrator.installRuntime(actors.machine.id, runtime);
          const parsed = runtimeInstallResultSchema.safeParse(reply);
          // An answer this server cannot read: an internal error, and nothing of it is traced or passed on.
          const result: RuntimeInstallResult = parsed.success ? parsed.data : { kind: "error", code: "internal" };
          if (!parsed.success) addTraceEvent("runtime.install.result_rejected", { machine_id: actors.machine.id, runtime });
          end = result;
          addTraceEvent("runtime.install.result", {
            machine_id: actors.machine.id,
            runtime,
            user_id: userId,
            outcome: result.kind,
            ...(result.kind === "installed" || result.kind === "already_installed" ? { version: result.version } : {}),
            ...("reason" in result ? { reason: result.reason } : {}),
            ...("code" in result ? { code: result.code } : {}),
            duration_ms: Date.now() - startedAt,
          });
          return { status: 200, body: { result } };
        } catch (error) {
          if (error instanceof RouteFailureError && error.subkind === "daemon_timeout") {
            end = { kind: "computer_timeout" };
            return { status: 504, body: { error: "The Computer did not answer in time. Check the Computer page for the runtime.", code: "computer_timeout" } };
          }
          if (error instanceof RouteFailureError && error.subkind === "daemon_offline") {
            end = { kind: "computer_offline" };
            return { status: 409, body: availabilityErrorBody("computer_offline") };
          }
          throw error;
        } finally {
          await recordRuntimeInstall(serverId, actors, userId, runtime, end);
        }
      }, { status: 500, body: { error: "Failed to install the runtime" } }, RUNTIME_INSTALL_OPERATION_TTL_SECONDS);
    } catch {
      res.status(500).json({ error: "Failed to install the runtime" });
    }
  });

  /**
   * Spend one of a runtime account's limit resets on this Computer (Codex,
   * OAR `redeemLimitReset`; Claude, by `kind`, behind claude_limit_reset_v2).
   * Same people as a sign-out, for Claude as for Codex: the human who
   * attached it or a server owner or admin. When the Computer answers that a
   * reset was spent (`reset`, `already_redeemed`, or `unknown` with
   * `fiveHourSpent`: spentLimitReset) to anyone but the human who attached
   * it, the use is audited (`computer.limit_reset_used_by_other`) and that
   * human is emailed; no other answer, refusal or timeout is. Never an agent (`/api/servers`
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
   * and a Codex redeem never yields them. `onboarding_required` (OAR 0.114)
   * is newer than some of those bundles, so it answers only a request whose
   * body says `onboardingRequiredReason: true`.
   */
  /**
   * A Computer wait started with `respondAsync` (answerMachineWait): pending,
   * or the status and body the request would have answered. Only the person
   * who started it; anyone else, an unknown id or an expired one is 404.
   */
  serverRouter.get("/:id/machine-operations/:operationId", async (req, res) => {
    try {
      const operationId = asMachineOperationId(req.params.operationId);
      const view = operationId ? await readMachineOperation({ userId: req.userId!, serverId: asServerId(req.serverId!), surface: "web" }, operationId) : null;
      res.setHeader("Cache-Control", "private, no-store");
      if (!view) {
        refuse(res, 404, { code: "operation_not_found", error: "This operation is unknown or has expired." });
        return;
      }
      res.status(200).json(view);
    } catch {
      res.status(500).json({ error: "Failed to read the operation" });
    }
  });

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
          addTraceEvent("runtime_account_usage.limit_reset.result", { machine_id: actors.machine.id, provider, user_id: req.userId, outcome: "disabled" });
          refuseClaudeLimitResetOff(res);
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
        // Refused before the Computer is asked: still one result event, so a daily count sees every attempt.
        addTraceEvent("runtime_account_usage.limit_reset.result", { machine_id: actors.machine.id, provider, user_id: req.userId, outcome: availability === "computer_offline" ? "computer_offline" : "upgrade_required" });
        refuse(res, 409, availability === "computer_offline"
          ? { code: "computer_offline", error: "This Computer is offline." }
          : { code: "computer_upgrade_required", error: "Upgrade this Computer to use a limit reset from here." });
        return;
      }
      if (!actors.attached) {
        // Its usage cannot be cached without an attaching human, so the reset's effect could not be shown.
        addTraceEvent("runtime_account_usage.limit_reset.result", { machine_id: actors.machine.id, provider, user_id: req.userId, outcome: "not_attached" });
        sendAvailabilityError(res, "computer_not_attached");
        return;
      }
      // A read already spent this account's 5-hour reset (Claude's older program): a later 5-hour use,
      // whatever its key, is answered here and never reaches the Computer (a card still showing the limit).
      if (provider === "claude" && kind === "five_hour" && await claudeFiveHourSpentByRead(actors.machine.id)) {
        addTraceEvent("runtime_account_usage.limit_reset.read_spent_guard", { machine_id: actors.machine.id, provider, user_id: req.userId, reset_kind: kind });
        addTraceEvent("runtime_account_usage.limit_reset.result", { machine_id: actors.machine.id, provider, user_id: req.userId, outcome: "nothing_to_reset", reset_kind: kind, guard: "read_spent_five_hour", snapshot: "none" });
        await answerMachineWait(req, res, async (): Promise<MachineOperationAnswer> => ({
          status: 200,
          body: { result: { kind: "nothing_to_reset" } satisfies RuntimeLimitResetResult, snapshot: null },
        }), { status: 500, body: { error: "Failed to use a limit reset" } });
        return;
      }
      // Each redeem runs on the Computer (Claude's starts Claude Code): bounded per person and Computer.
      if (!await runtimeAuthService.allowClaudeLimitResetRequest(provider === "claude" ? "redeem" : "codex_redeem", req.userId!, actors.machine.id)) {
        addTraceEvent("runtime_account_usage.limit_reset.rate_limited", { machine_id: actors.machine.id, provider, user_id: req.userId });
        addTraceEvent("runtime_account_usage.limit_reset.result", { machine_id: actors.machine.id, provider, user_id: req.userId, outcome: "rate_limited" });
        sendRateLimited(res);
        return;
      }
      const clientCapabilities = req.header(RAFT_CLIENT_CAPABILITIES_HEADER);
      await answerMachineWait(req, res, async (): Promise<MachineOperationAnswer> => {
        try {
          // The page reads `unsupported: onboarding_required` only when it says so (an older bundle's strict parse refuses it).
          const reply = await orchestrator.redeemRuntimeLimitReset(actors.machine.id, provider, idempotencyKey, kind, req.body?.onboardingRequiredReason === true);
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
          // An owner or admin spent a reset of a Computer someone else connected: audited, and that person is told.
          const spent = spentLimitReset(result, kind);
          if (spent && !actors.attachedByCaller && actors.attachedBy) {
            await recordLimitResetUsedByOther({
              serverId: req.params.id,
              machine: { id: actors.machine.id, name: actors.machine.name },
              provider,
              ...spent,
              usedByUserId: req.userId!,
              usedByRole: actors.callerRole,
              connectorUserId: actors.attachedBy,
            });
          }
          // Window scopes only to a client that reads them (an older web bundle's strict parse would drop the snapshot),
          // and no agent the person may not find (a personal assistant's own account folder).
          const snapshot = parsedSnapshot?.success ? await runtimeAccountUsageSnapshotForViewer(parsedSnapshot.data, clientCapabilities, req.userId!) : null;
          return { status: 200, body: { result, snapshot } };
        } catch (error) {
          if (error instanceof RouteFailureError && error.subkind === "daemon_timeout") {
            addTraceEvent("runtime_account_usage.limit_reset.result", { machine_id: actors.machine.id, provider, user_id: req.userId, outcome: "timeout" });
            return { status: 504, body: { error: "The Computer did not answer in time. Try again; it won't use a second reset.", code: "computer_timeout" } };
          }
          if (error instanceof RouteFailureError && error.subkind === "daemon_offline") {
            addTraceEvent("runtime_account_usage.limit_reset.result", { machine_id: actors.machine.id, provider, user_id: req.userId, outcome: "computer_offline" });
            return { status: 409, body: availabilityErrorBody("computer_offline") };
          }
          throw error;
        }
      }, { status: 500, body: { error: "Failed to use a limit reset" } });
    } catch {
      res.status(500).json({ error: "Failed to use a limit reset" });
    }
  });

  /**
   * Read which limit resets a Claude account holds on this Computer, behind
   * claude_limit_reset_v2: its daemon opens Claude Code's own command for each
   * kind and cancels it. Only on a person's click (POST: on Claude's older
   * program, opening the command at the 5-hour limit spends that reset), by
   * the person who connected the Computer or an owner or admin.
   * `consent: true` says the person accepted that; without it the Computer
   * refuses a read at the limit (`unsupported: consent_required`). The same
   * people may send a read with consent, as they may use a reset; a read on
   * which the older program spent the 5-hour reset (`fiveHourSpent`) by
   * anyone but the human who attached it is audited and emailed like a use.
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
      const atFiveHourLimit = await claudeAtFiveHourLimit(actors.machine.id);
      await answerMachineWait(req, res, async (): Promise<MachineOperationAnswer> => {
        try {
          const reply = await orchestrator.readRuntimeLimitResets(actors.machine.id, usageProvider, {
            atFiveHourLimit,
            atFiveHourLimitConsent: consent === true,
            includeFiveHour: true,
            // As the redeem: only a page that says it reads `onboarding_required` may get it.
            onboardingRequiredReason: req.body?.onboardingRequiredReason === true,
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
          if (result.kind === "read" && result.fiveHourSpent) {
            // A later 5-hour use of this account is answered by the server (claudeLimitResetReadSpentGuard).
            await claudeLimitResetReadSpentGuard.recordReadSpent(actors.machine.id).catch((error: unknown) => {
              addTraceEvent("runtime_account_usage.limit_resets.read.spent_record_failed", { machine_id: actors.machine.id, error_class: error instanceof Error ? error.name : typeof error });
            });
          }
          // Opening the list spent the account's 5-hour reset (Claude's older program): a use, as a redeem's.
          if (result.kind === "read" && result.fiveHourSpent && !actors.attachedByCaller && actors.attachedBy) {
            await recordLimitResetUsedByOther({
              serverId: req.params.id,
              machine: { id: actors.machine.id, name: actors.machine.name },
              provider: usageProvider,
              resetKind: "five_hour",
              via: "read",
              answer: "five_hour_spent",
              usedByUserId: req.userId!,
              usedByRole: actors.callerRole,
              connectorUserId: actors.attachedBy,
            });
          }
          return { status: 200, body: { result } };
        } catch (error) {
          if (error instanceof RouteFailureError && error.subkind === "daemon_timeout") {
            addTraceEvent("runtime_account_usage.limit_resets.read.result", { machine_id: actors.machine.id, provider: usageProvider, user_id: req.userId, outcome: "timeout" });
            return { status: 504, body: { error: "The Computer did not answer in time. Try again.", code: "computer_timeout" } };
          }
          if (error instanceof RouteFailureError && error.subkind === "daemon_offline") {
            return { status: 409, body: availabilityErrorBody("computer_offline") };
          }
          throw error;
        }
      }, { status: 500, body: { error: "Failed to read the limit resets" } });
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
