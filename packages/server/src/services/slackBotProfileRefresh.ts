import { and, eq, ne, sql } from "drizzle-orm";
import { setClockTimeout, clearClockTimeout } from "@botiverse/raft-shared";
import type { Database, DatabaseTransaction } from "../db/index";
import { externalActorProjections, externalAppInstalls, externalAppRegistrations, externalChannelBindings } from "../db/schema";
import type { SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";
import type { SlackBridgeAvatarMaterializer } from "./slackBridgeProvisioningControlPlane";
import { resolveExternalBindingAuthority } from "./externalAppControlPlaneService";
import { resolveExternalInstallServerGrantAuthority } from "./externalInstallServerGrantAuthority";
import { lookupSlackProviderBot } from "./slackProviderAdapter";

export type SlackBotProfileHint = {
  serverId: string; registrationId: string; installId: string; bindingId: string;
  bindingEpoch: number; connectionEpoch: number; providerBotId: string; projectionId: string; senderAppId: string | null;
};

/** Best effort only; bot messages never wait for a provider profile or icon. */
export function createSlackBotProfileRefresher(input: {
  db: Database; provider: SlackBridgeProviderRuntime; avatarMaterializer?: SlackBridgeAvatarMaterializer;
  now: () => Date; onError?: (error: unknown) => void;
}) {
  const queue = new Map<string, SlackBotProfileHint>();
  const attempted = new Map<string, number>();
  let running = false;
  let stopped = false;
  let timer: unknown | null = null;
  let active: Promise<void> | null = null;
  let nextCallAt = 0;
  const key = (hint: SlackBotProfileHint) => `${hint.installId}:${hint.providerBotId}`;
  async function refresh(hint: SlackBotProfileHint) {
    const now = input.now();
    if (!Number.isFinite(now.getTime()) || !/^B[A-Z0-9]{2,159}$/u.test(hint.providerBotId)) return;
    const decision = await resolveExternalBindingAuthority({ serverId: hint.serverId, bindingId: hint.bindingId,
      expectedConnectionEpoch: hint.connectionEpoch, expectedBindingEpoch: hint.bindingEpoch, now }, input.db);
    if (!decision.active || decision.fact.registrationId !== hint.registrationId || decision.fact.installId !== hint.installId) return;
    const a = decision.fact;
    const fence = { installId: a.installId, providerAppId: a.providerAppId, providerAuthorityId: a.providerAuthorityId,
      providerConversationId: a.providerConversationId, connectionEpoch: a.connectionEpoch, credentialRevision: a.credentialRevision,
      bindingId: a.bindingId, bindingEpoch: a.bindingEpoch };
    const handle = await input.provider.credentialResolver.resolve({ authority: fence, now });
    if (!handle) return;
    let avatarLocator: string | undefined;
    let response;
    try {
      response = await lookupSlackProviderBot({ transport: input.provider.transport, quarantineSink: input.provider.quarantineSink,
        credentialHandle: handle, authority: fence, providerBotId: hint.providerBotId, now,
        onAvatarLocator: locator => { avatarLocator = locator; } });
    } finally { await input.provider.releaseCredential(handle); }
    if (response.kind === "rate_limited") {
      nextCallAt = Math.max(nextCallAt, input.now().getTime() + response.retryAfterMs);
      if (!stopped && (queue.size < 128 || queue.has(key(hint)))) queue.set(key(hint), hint);
      return;
    }
    if (response.kind !== "fact") return;
    const verifiedBot = response.fact.isDeleted === false && response.fact.providerAppId !== a.providerAppId
      && !(hint.senderAppId && response.fact.providerAppId && hint.senderAppId !== response.fact.providerAppId);
    const verifiedUserId = verifiedBot ? response.fact.providerUserId : null;
    async function lockCurrentAuthority(tx: DatabaseTransaction): Promise<boolean> {
      const [install] = await tx.select().from(externalAppInstalls).where(eq(externalAppInstalls.id, a.installId)).limit(1).for("update");
      const [binding] = await tx.select().from(externalChannelBindings).where(eq(externalChannelBindings.id, a.bindingId)).limit(1).for("update");
      const [registration] = await tx.select().from(externalAppRegistrations).where(eq(externalAppRegistrations.id, a.registrationId)).limit(1).for("share");
      if (!install || !binding || !registration || install.providerBotId === hint.providerBotId) return false;
      const grant = await resolveExternalInstallServerGrantAuthority(tx, { installId: a.installId, serverId: a.serverId,
        registrationId: a.registrationId }, { lock: true });
      if (!grant.current) return false;
      const fresh = await resolveExternalBindingAuthority({ serverId: a.serverId, bindingId: a.bindingId,
        expectedConnectionEpoch: a.connectionEpoch, expectedBindingEpoch: a.bindingEpoch, now: input.now() }, tx as Database);
      return fresh.active && fresh.fact.installId === a.installId && fresh.fact.credentialRevision === a.credentialRevision
        && fresh.fact.providerAuthorityId === a.providerAuthorityId && fresh.fact.providerAppId === a.providerAppId;
    }
    const refreshed = await input.db.transaction(async tx => {
      if (!await lockCurrentAuthority(tx)) return null;
      const [actor] = await tx.select().from(externalActorProjections).where(and(eq(externalActorProjections.id, hint.projectionId),
        eq(externalActorProjections.appRegistrationId, a.registrationId), eq(externalActorProjections.installId, a.installId),
        eq(externalActorProjections.workspaceId, a.providerAuthorityId), eq(externalActorProjections.externalActorId, hint.providerBotId),
        eq(externalActorProjections.actorKind, "bot"), eq(externalActorProjections.state, "active"),
        eq(externalActorProjections.deactivated, false))).limit(1).for("update");
      if (!actor) return null;
      const name = verifiedBot ? response.fact.displayNameSnapshot : null;
      const mappingNow = input.now();
      const observedAt = response.fact.observedAt;
      if (!Number.isFinite(mappingNow.getTime()) || !Number.isFinite(observedAt.getTime()) || observedAt > mappingNow
        || mappingNow.getTime() - observedAt.getTime() >= 60 * 60_000
        || (actor.slackBotMappingCheckedAt && actor.slackBotMappingCheckedAt > observedAt)) return null;
      if (actor.slackBotMappingCheckedAt?.getTime() === observedAt.getTime()) {
        // Same-millisecond responses have no trustworthy order. Even if the
        // values happen to match, an earlier equal-time invalidation must not
        // be undone by a later response; degrade to literal until a newer read.
        if (actor.slackBotUserId !== null) await tx.update(externalActorProjections).set({
          slackBotUserId: null, slackBotConnectionEpoch: null, slackBotCredentialRevision: null,
          slackBotScopeRevision: null, slackBotMappingObservedAt: null, slackBotMappingExpiresAt: null,
          slackBotMappingConflict: false, slackBotMappingRevision: actor.slackBotMappingRevision + 1, updatedAt: mappingNow,
        }).where(eq(externalActorProjections.id, actor.id));
        return null;
      }
      const mapped = verifiedUserId !== null;
      const collisions = mapped ? await tx.select({ id: externalActorProjections.id, conflict: externalActorProjections.slackBotMappingConflict })
        .from(externalActorProjections).where(and(eq(externalActorProjections.provider, "slack"),
          eq(externalActorProjections.appRegistrationId, a.registrationId), eq(externalActorProjections.installId, a.installId),
          eq(externalActorProjections.workspaceId, a.providerAuthorityId), eq(externalActorProjections.actorKind, "bot"),
          eq(externalActorProjections.slackBotUserId, verifiedUserId), ne(externalActorProjections.id, actor.id)))
        .for("update") : [];
      const conflict = collisions.length > 0;
      for (const other of collisions) if (!other.conflict) await tx.update(externalActorProjections)
        .set({ slackBotMappingConflict: true, slackBotMappingRevision: sql`${externalActorProjections.slackBotMappingRevision} + 1`,
          slackBotMappingCheckedAt: sql`GREATEST(${externalActorProjections.slackBotMappingCheckedAt}, ${observedAt})`, updatedAt: mappingNow })
        .where(eq(externalActorProjections.id, other.id));
      const sameMapping = mapped && actor.slackBotUserId === verifiedUserId
        && actor.slackBotConnectionEpoch === a.connectionEpoch && actor.slackBotCredentialRevision === a.credentialRevision
        && actor.slackBotScopeRevision === a.scopeRevision && actor.slackBotMappingConflict === conflict
        && actor.slackBotMappingExpiresAt !== null && actor.slackBotMappingExpiresAt > mappingNow;
      const previouslyMapped = actor.slackBotUserId !== null;
      const revision = actor.slackBotMappingRevision + ((mapped ? !sameMapping : previouslyMapped) ? 1 : 0);
      const fields = mapped ? { slackBotUserId: verifiedUserId, slackBotConnectionEpoch: a.connectionEpoch,
        slackBotCredentialRevision: a.credentialRevision, slackBotScopeRevision: a.scopeRevision,
        slackBotMappingObservedAt: observedAt, slackBotMappingExpiresAt: new Date(observedAt.getTime() + 60 * 60_000),
        slackBotMappingConflict: conflict, slackBotMappingRevision: revision }
        : { slackBotUserId: null, slackBotConnectionEpoch: null, slackBotCredentialRevision: null, slackBotScopeRevision: null,
          slackBotMappingObservedAt: null, slackBotMappingExpiresAt: null, slackBotMappingConflict: false, slackBotMappingRevision: revision };
      const nameChanged = Boolean(name && name !== actor.displayName);
      const [updated] = await tx.update(externalActorProjections).set({ ...fields, slackBotMappingCheckedAt: observedAt,
        ...(nameChanged ? { displayName: name!, projectionRevision: actor.projectionRevision + 1, observedAt: mappingNow } : {}),
        updatedAt: mappingNow }).where(eq(externalActorProjections.id, actor.id)).returning();
      return updated && verifiedBot ? { id: updated.id, revision: updated.projectionRevision, observedAt: updated.observedAt } : null;
    });
    if (refreshed && avatarLocator && input.avatarMaterializer) await input.avatarMaterializer.materializeExternalProjection({
      projectionId: refreshed.id, expectedProjectionRevision: refreshed.revision,
      expectedObservedAt: refreshed.observedAt, sourceLocator: avatarLocator, lockAdditionalAuthority: lockCurrentAuthority,
    });
  }
  function drain() {
    if (stopped || running || timer || queue.size === 0) return;
    const delay = Math.max(0, nextCallAt - input.now().getTime());
    if (delay > 0) { timer = setClockTimeout(() => { timer = null; drain(); }, Math.min(delay, 2_147_483_647)); return; }
    const [firstKey, hint] = queue.entries().next().value!;
    queue.delete(firstKey); running = true; nextCallAt = input.now().getTime() + 5_000;
    active = refresh(hint).catch(error => { try {
      if (input.onError) input.onError(new Error("Slack bot profile refresh failed", { cause: error }));
      else console.warn("[SlackBridge] bot profile refresh failed", { errorClass: error instanceof Error ? error.name : "unknown" });
    } catch { /* diagnostic only */ } }).finally(() => {
      running = false; active = null;
      drain();
    });
  }
  return {
    request(hint: SlackBotProfileHint) {
      if (stopped) return;
      const now = input.now().getTime(), id = key(hint);
      if (!Number.isFinite(now) || now - (attempted.get(id) ?? -Infinity) < 60_000) return;
      if (queue.size >= 128 && !queue.has(id)) return;
      attempted.set(id, now);
      if (attempted.size > 512) {
        for (const [entry, time] of attempted) if (now - time >= 60_000) attempted.delete(entry);
        while (attempted.size > 512) attempted.delete(attempted.keys().next().value!);
      }
      queue.set(id, hint); drain();
    },
    async stop() { stopped = true; if (timer) clearClockTimeout(timer); timer = null; queue.clear(); await active; },
  };
}
