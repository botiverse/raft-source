import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import {
  linkCardAttempts, linkCardClientRequests, linkCardHandleUses, linkCardOperations, linkCardPreparedActions, linkCardUpdateTokens,
} from "../db/schema";
import { nativeInstallationKey } from "./linkCardTokens";

// RFC 076 §5.2: the identity domain is never null, so request uniqueness holds
// for native providers too, and the state, resolution, lifetime and receipt
// invariants are enforced by the database, not only by the service.
const test = createApiTest();

async function rejects(run: () => Promise<unknown>, constraint: string) {
  await assert.rejects(run, (error: { cause?: { constraint?: string; constraint_name?: string; message?: string }; message?: string }) => {
    const text = `${error.cause?.constraint ?? ""} ${error.cause?.constraint_name ?? ""} ${error.cause?.message ?? ""} ${error.message ?? ""}`;
    assert.ok(text.includes(constraint), `expected ${constraint}, got: ${text}`);
    return true;
  });
}

test("link card rows: non-null identity domain, unique requests and handles, enforced invariants", async ({ app }) => {
  void app; // the fixture initializes the database
  const db = getDb();
  const serverId = randomUUID();
  const viewerId = randomUUID();
  const native = { serverId, providerKind: "native" as const, providerKey: "workspace-artifacts", installationKey: nativeInstallationKey(serverId, "workspace-artifacts") };
  const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const urlSha256 = createHash("sha256").update("https://vault.raft.build/requests/1").digest("hex");
  const operation = (extra: Partial<typeof linkCardOperations.$inferInsert> = {}) => ({
    operationId: randomUUID(), viewerId, ...native, registrationRevision: "native", viewNonce: "n1", messageId: randomUUID(),
    urlSha256, createdAt, firstSendDeadline: new Date(createdAt.getTime() + 600_000),
    actionId: "share", requestSha256: "r".repeat(64), state: "unknown" as const, ...extra,
  });
  const [op1] = await db.insert(linkCardOperations).values(operation()).returning();
  const [op2] = await db.insert(linkCardOperations).values(operation()).returning();

  // Request uniqueness, including for native providers (no NULLs in the key).
  const request = (operationId: string, extra: Partial<typeof linkCardClientRequests.$inferInsert> = {}) => ({
    viewerId, ...native, clientRequestId: "c".repeat(32), operationId, urlSha256, actionId: "share", requestSha256: "r".repeat(64), ...extra,
  });
  await db.insert(linkCardClientRequests).values(request(op1!.operationId));
  await rejects(() => db.insert(linkCardClientRequests).values(request(op2!.operationId)), "link_card_client_requests_pk");
  await rejects(() => db.insert(linkCardClientRequests).values(request(op2!.operationId, { clientRequestId: "d".repeat(32), installationKey: `native:${randomUUID()}:workspace-artifacts` })), "link_card_client_requests_installation_key_valid");
  await rejects(() => db.insert(linkCardClientRequests).values(request(op2!.operationId, { clientRequestId: "e".repeat(32), providerKind: "app", installationKey: "native:spoof" })), "link_card_client_requests_installation_key_valid");
  await rejects(() => db.insert(linkCardClientRequests).values(request(op2!.operationId, { clientRequestId: "f".repeat(32), providerKind: "app", installationKey: "" })), "link_card_client_requests_installation_key_valid");
  await rejects(() => db.insert(linkCardClientRequests).values(request(op2!.operationId, { clientRequestId: "short" })), "link_card_client_requests_id_valid");
  await rejects(() => db.insert(linkCardClientRequests).values(request(randomUUID(), { clientRequestId: "g".repeat(32) })), "link_card_client_requests_operation_fk");

  // A handle is consumed once.
  await db.insert(linkCardHandleUses).values({ handleSha256: "h".repeat(64), operationId: op1!.operationId, expiresAt: new Date(Date.now() + 600_000) });
  await rejects(() => db.insert(linkCardHandleUses).values({ handleSha256: "h".repeat(64), operationId: op2!.operationId, expiresAt: new Date(Date.now() + 600_000) }), "link_card_handle_uses_pkey");

  // Manual resolution is all-or-nothing, with a real reason.
  const resolved = { resolvedByUserId: randomUUID(), resolutionReason: "Checked in Vault: approved by owner", resolvedAt: new Date() };
  await db.insert(linkCardOperations).values(operation({ state: "resolved_manually", ...resolved }));
  await rejects(() => db.insert(linkCardOperations).values(operation({ state: "resolved_manually" })), "link_card_operations_manual_resolution");
  await rejects(() => db.insert(linkCardOperations).values(operation({ state: "resolved_manually", ...resolved, resolutionReason: "  " })), "link_card_operations_manual_resolution");
  await rejects(() => db.insert(linkCardOperations).values(operation({ resolvedByUserId: randomUUID() })), "link_card_operations_manual_resolution");

  // Prepared records live at most 5 minutes and are consumed by one operation.
  const readAt = new Date();
  const prepared = (extra: Partial<typeof linkCardPreparedActions.$inferInsert> = {}) => ({
    preparedActionId: randomUUID(), viewerId, ...native, viewNonce: "n1", handleSha256: "p".repeat(64), descriptionSha256: "s".repeat(64),
    businessRevision: "br-1", readAt, expiresAt: new Date(readAt.getTime() + 300_000), ...extra,
  });
  await db.insert(linkCardPreparedActions).values(prepared({ consumedByOperationId: op1!.operationId }));
  await rejects(() => db.insert(linkCardPreparedActions).values(prepared({ consumedByOperationId: op1!.operationId })), "link_card_prepared_actions_consumed_by_operation_id_unique");
  await rejects(() => db.insert(linkCardPreparedActions).values(prepared({ expiresAt: new Date(readAt.getTime() + 300_001) })), "link_card_prepared_actions_lifetime");

  // Every attempt is attributed: prepare to its minted prepared id, execute/status to an operation.
  const attempt = { viewerId, ...native };
  await db.insert(linkCardAttempts).values({ ...attempt, jti: randomUUID(), phase: "prepare", preparedActionId: randomUUID() });
  await db.insert(linkCardAttempts).values({ ...attempt, jti: randomUUID(), phase: "status", operationId: op1!.operationId });
  await rejects(() => db.insert(linkCardAttempts).values({ ...attempt, jti: randomUUID(), phase: "prepare" }), "link_card_attempts_subject");
  await rejects(() => db.insert(linkCardAttempts).values({ ...attempt, jti: randomUUID(), phase: "execute" }), "link_card_attempts_subject");
  await rejects(() => db.insert(linkCardAttempts).values({ ...attempt, jti: randomUUID(), phase: "execute", operationId: op1!.operationId, preparedActionId: randomUUID() }), "link_card_attempts_subject");

  // The state machine (0387 trigger): forward only, terminal states never move.
  const setState = (operationId: string, state: typeof linkCardOperations.$inferInsert.state, extra: Partial<typeof linkCardOperations.$inferInsert> = {}) =>
    db.update(linkCardOperations).set({ state, ...extra }).where(eq(linkCardOperations.operationId, operationId));
  await setState(op2!.operationId, "needs_reconciliation");
  // Only Feature Flag Admin's role may resolve manually (covered by the real-PG contract test).
  await rejects(() => setState(op2!.operationId, "resolved_manually", resolved), "link_card_operations_state_transition");
  await setState(op2!.operationId, "done");
  await rejects(() => setState(op2!.operationId, "needs_reconciliation"), "link_card_operations_state_transition");
  const [op3] = await db.insert(linkCardOperations).values(operation({ state: "done" })).returning();
  await rejects(() => setState(op3!.operationId, "unknown"), "link_card_operations_state_transition");
  await rejects(() => setState(op1!.operationId, "requested"), "link_card_operations_state_transition");
  await setState(op1!.operationId, "accepted");

  // Where execute goes (0400): an app operation records the endpoint and origin it was sent to; a native one has neither.
  const appDomain = { providerKind: "app" as const, providerKey: "vault-50e32c", installationKey: randomUUID() };
  const sentTo = { actionEndpointSha256: "a".repeat(64), actionOrigin: "https://vault.raft.build" };
  await db.insert(linkCardOperations).values(operation({ ...appDomain, ...sentTo }));
  await rejects(() => db.insert(linkCardOperations).values(operation({ ...appDomain })), "link_card_operations_send_target");
  await rejects(() => db.insert(linkCardOperations).values(operation({ ...appDomain, ...sentTo, actionEndpointSha256: "not-a-digest" })), "link_card_operations_send_target");
  await rejects(() => db.insert(linkCardOperations).values(operation({ ...sentTo })), "link_card_operations_send_target");
  // url_sha256 is 64 lowercase hex, like action_endpoint_sha256.
  await rejects(() => db.insert(linkCardOperations).values(operation({ urlSha256: "u".repeat(64) })), "link_card_operations_url_sha256_valid");
  await rejects(() => db.insert(linkCardOperations).values(operation({ urlSha256: urlSha256.toUpperCase() })), "link_card_operations_url_sha256_valid");

  // The first-send deadline is created_at + 10 minutes from one whole-second reading, and neither ever moves.
  await rejects(() => db.insert(linkCardOperations).values(operation({ createdAt: new Date(createdAt.getTime() + 1), firstSendDeadline: new Date(createdAt.getTime() + 600_001) })),
    "link_card_operations_first_send_deadline");
  await rejects(() => db.insert(linkCardOperations).values(operation({ firstSendDeadline: new Date(createdAt.getTime() + 601_000) })), "link_card_operations_first_send_deadline");
  const later = new Date(createdAt.getTime() + 60_000);
  await rejects(() => db.update(linkCardOperations).set({ createdAt: later, firstSendDeadline: new Date(later.getTime() + 600_000) })
    .where(eq(linkCardOperations.operationId, op1!.operationId)), "link_card_operations_send_deadline_immutable");
  await rejects(() => db.update(linkCardOperations).set({ firstSendDeadline: new Date(createdAt.getTime() + 600_000 + 3_600_000) })
    .where(eq(linkCardOperations.operationId, op1!.operationId)), "link_card_operations_send_deadline_immutable");
  await db.update(linkCardOperations).set({ lastStatusAt: new Date() }).where(eq(linkCardOperations.operationId, op1!.operationId));

  // A consumed update token keeps the receipt it replays.
  const token = (extra: Partial<typeof linkCardUpdateTokens.$inferInsert> = {}) => ({
    tokenSha256: randomUUID(), operationId: op1!.operationId, ...native, registrationRevision: "native", expiresAt: new Date(Date.now() + 600_000), ...extra,
  });
  await db.insert(linkCardUpdateTokens).values(token());
  await db.insert(linkCardUpdateTokens).values(token({ consumedUpdateId: "u1", contentSha256: "x".repeat(64), receipt: { operationId: op1!.operationId, state: "done", receiptRevision: 1 } }));
  await rejects(() => db.insert(linkCardUpdateTokens).values(token({ consumedUpdateId: "u2", contentSha256: "x".repeat(64) })), "link_card_update_tokens_consumed");
});
