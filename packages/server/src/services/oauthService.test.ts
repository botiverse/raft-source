import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import {
  integrationAuditEvents,
  oauthAccessRequests,
  oauthAccessTokens,
  oauthClients,
  oauthGrants,
} from "../db/schema.js";
import {
  __resetOAuthServiceDbForTests,
  __setOAuthServiceDbForTests,
  __setOAuthServiceReviewEmailSenderForTests,
  AUTHORIZATION_CODE_EXPIRED_ERROR,
  HUMAN_AUTHORIZATION_CODE_TTL_MS,
  approveAccessRequest,
  createOAuthClient,
  deleteOAuthClient,
  denyAccessRequest,
  exchangeAccessRequest,
  getIdentityByAccessToken,
  projectMarketplaceInstallBadge,
  requestOAuthClientPublish,
  requestOAuthClientUnpublish,
  revokeGrant,
  updateOAuthClient,
} from "./oauthService.js";

test("marketplace install badge projection pins count and publication-age boundaries", () => {
  const now = new Date("2026-08-19T12:00:00.000Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const project = (effectiveInstallCount: number, publishedDaysAgo: number) => (
    projectMarketplaceInstallBadge({ effectiveInstallCount, publishedAt: daysAgo(publishedDaysAgo), now })
  );

  assert.deepEqual(project(9, 29), { kind: "new" });
  assert.deepEqual(project(10, 29), { kind: "bucket", bucket: "10_plus" });
  assert.deepEqual(project(99, 29), { kind: "bucket", bucket: "10_plus" });
  assert.deepEqual(project(100, 29), { kind: "bucket", bucket: "100_plus" });
  assert.deepEqual(project(999, 29), { kind: "bucket", bucket: "100_plus" });
  assert.deepEqual(project(1000, 29), { kind: "bucket", bucket: "1k_plus" });

  assert.deepEqual(project(0, 29), { kind: "new" });
  assert.deepEqual(project(0, 30), { kind: "new" });
  assert.deepEqual(project(0, 31), { kind: "none" });
});

type SelectCapture = { lockMode?: string };
type UpdateCapture = { values?: Record<string, unknown>; table?: unknown };
type InsertCapture = { values?: Record<string, unknown>; table?: unknown };
type DeleteCapture = { table?: unknown };

function makeSelectBuilder<T>(result: T, capture?: SelectCapture) {
  const builder: any = {
    from() {
      return builder;
    },
    innerJoin() {
      return builder;
    },
    leftJoin() {
      return builder;
    },
    where() {
      return builder;
    },
    orderBy() {
      return builder;
    },
    limit() {
      return builder;
    },
    for(mode: string) {
      if (capture) capture.lockMode = mode;
      return builder;
    },
    then(resolve: (value: T) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return builder;
}

function makeUpdateBuilder<T>(result: T, capture?: UpdateCapture) {
  const afterSet: any = {
    where() {
      return afterSet;
    },
    returning() {
      return afterSet;
    },
    then(resolve: (value: T) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };

  return {
    set(values: Record<string, unknown>) {
      if (capture) capture.values = values;
      return afterSet;
    },
  };
}

function makeInsertBuilder<T>(result: T, capture?: InsertCapture) {
  const afterValues: any = {
    returning() {
      return afterValues;
    },
    then(resolve: (value: T) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };

  return {
    values(values: Record<string, unknown>) {
      if (capture) capture.values = values;
      return afterValues;
    },
  };
}

function makeDeleteBuilder<T>(result: T, capture?: DeleteCapture) {
  const afterWhere: any = {
    returning() {
      return afterWhere;
    },
    then(resolve: (value: T) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };

  return {
    where() {
      return afterWhere;
    },
  };
}

function makeTx(options: {
  selects?: Array<{ result: unknown; capture?: SelectCapture }>;
  updates?: Array<{ result: unknown; capture?: UpdateCapture }>;
  inserts?: Array<{ result: unknown; capture?: InsertCapture }>;
  deletes?: Array<{ result: unknown; capture?: DeleteCapture }>;
}) {
  const selects = [...(options.selects ?? [])];
  const updates = [...(options.updates ?? [])];
  const inserts = [...(options.inserts ?? [])];
  const deletes = [...(options.deletes ?? [])];

  return {
    select() {
      const next = selects.shift();
      if (!next) throw new Error("Unexpected select");
      return makeSelectBuilder(next.result, next.capture);
    },
    update(table: unknown) {
      const next = updates.shift();
      if (!next) throw new Error("Unexpected update");
      if (next.capture) next.capture.table = table;
      return makeUpdateBuilder(next.result, next.capture);
    },
    insert(table: unknown) {
      const next = inserts.shift();
      if (!next) throw new Error("Unexpected insert");
      if (next.capture) next.capture.table = table;
      return makeInsertBuilder(next.result, next.capture);
    },
    delete(table: unknown) {
      const next = deletes.shift();
      if (!next) throw new Error("Unexpected delete");
      if (next.capture) next.capture.table = table;
      return makeDeleteBuilder(next.result, next.capture);
    },
  };
}

function humanOpenIdIdentityRow() {
  return [{
    tokenId: "token-1",
    principalType: "human",
    scopes: ["openid", "profile"],
    resource: null,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    revokedAt: null,
    grantRevokedAt: null,
    clientRecordId: "client-1",
    clientKey: "client-key",
    clientName: "Test Client",
    serverId: "server-1",
    serverSlug: "server-one",
    serverName: "Server One",
    serverAvatarUrl: null,
    serverDeletedAt: null,
    serverPlan: "free",
    humanId: "user-1",
    humanName: "user-one",
    humanDisplayName: "User One",
    humanEmail: "user@example.com",
    humanEmailVerified: true,
    humanAvatarUrl: null,
    humanDescription: null,
    humanRole: "member",
    agentRole: null,
    agentId: null,
    agentName: null,
    agentDisplayName: null,
    agentAvatarUrl: null,
    agentDescription: null,
    agentDeletedAt: null,
  }];
}

afterEach(() => {
  __resetOAuthServiceDbForTests();
});

test("createOAuthClient writes the client and success audit inside one transaction", async () => {
  const clientInsertCapture: InsertCapture = {};
  const auditInsertCapture: InsertCapture = {};
  const tx = makeTx({
    inserts: [
      {
        result: [{
          id: "client-1",
          serverId: "server-1",
          clientId: "demo-app",
          appType: "server_local",
          publishStatus: "private",
          category: "productivity",
          dataAccessSummary: null,
          publishRejectionReason: null,
          name: "Demo App",
          description: null,
          homepageUrl: "https://demo.example",
          returnUrl: "https://demo.example/callback",
          agentManifestUrl: null,
          logoUrl: null,
          humanMarketplaceVisible: true,
          createdByUserId: "user-1",
          createdAt: new Date(),
          updatedAt: new Date(),
        }],
        capture: clientInsertCapture,
      },
      { result: [{ id: "audit-1" }], capture: auditInsertCapture },
    ],
  });
  let usedTransaction = false;

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => {
      usedTransaction = true;
      return fn(tx);
    },
  }) as any);

  await createOAuthClient({
    serverId: "server-1",
    createdByUserId: "user-1",
    name: "Demo App",
    clientId: "demo-app",
    homepageUrl: "https://demo.example",
    returnUrl: "https://demo.example/callback",
  });

  assert.equal(usedTransaction, true);
  assert.equal(clientInsertCapture.table, oauthClients);
  assert.equal(auditInsertCapture.table, integrationAuditEvents);
});

test("updateOAuthClient writes the mutation and success audit inside one transaction", async () => {
  const updateCapture: UpdateCapture = {};
  const auditInsertCapture: InsertCapture = {};
  const before = {
    id: "client-1",
    serverId: "server-1",
    clientId: "demo-app",
    appType: "server_local",
    publishStatus: "private",
    category: "productivity",
    dataAccessSummary: null,
    publishRejectionReason: null,
    name: "Demo App",
    description: null,
    homepageUrl: "https://demo.example",
    returnUrl: "https://demo.example/callback",
    agentManifestUrl: null,
    logoUrl: null,
    humanMarketplaceVisible: true,
    createdByUserId: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const tx = makeTx({
    selects: [{ result: [before] }],
    updates: [{
      result: [{ ...before, name: "Updated Demo App" }],
      capture: updateCapture,
    }],
    inserts: [{ result: [{ id: "audit-1" }], capture: auditInsertCapture }],
  });
  let usedTransaction = false;

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => {
      usedTransaction = true;
      return fn(tx);
    },
  }) as any);

  await updateOAuthClient({
    serverId: "server-1",
    clientId: "client-1",
    actorUserId: "user-1",
    name: "Updated Demo App",
  });

  assert.equal(usedTransaction, true);
  assert.equal(updateCapture.table, oauthClients);
  assert.equal(auditInsertCapture.table, integrationAuditEvents);
});

test("marketplace publish requests email the fixed review summary with a stable retry key", async () => {
  const requestedAt = new Date("2026-07-23T12:00:00.000Z");
  const client = {
    id: "client-1",
    serverId: "server-1",
    clientId: "demo-app",
    appType: "server_local",
    publishStatus: "publish_requested",
    category: "Productivity & Collaboration",
    dataAccessSummary: null,
    publishRejectionReason: null,
    name: "Demo App",
    description: "A useful app",
    homepageUrl: "https://demo.example",
    returnUrl: "https://demo.example/callback",
    agentManifestUrl: null,
    allowedScopes: ["openid", "profile"],
    logoUrl: null,
    humanMarketplaceVisible: true,
    createdByUserId: "user-1",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: requestedAt,
    publishRequestedAt: requestedAt,
  };
  const tx = makeTx({
    selects: [{
      result: [{
        description: client.description,
        publishStatus: "private",
      }],
    }],
    updates: [{ result: [client] }],
    inserts: [{ result: [{ id: "audit-1" }] }],
  });
  const sends: Array<{ input: unknown; idempotencyKey?: string }> = [];

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);
  __setOAuthServiceReviewEmailSenderForTests(async (emailInput, options) => {
    sends.push({ input: emailInput, idempotencyKey: options?.idempotencyKey });
    return "email-1";
  });

  const result = await requestOAuthClientPublish({
    serverId: "server-1",
    clientId: "client-1",
    requestedByUserId: "user-1",
  });

  assert.equal(result?.publishStatus, "publish_requested");
  assert.deepEqual(sends, [{
    input: {
      requestKind: "publish",
      appName: "Demo App",
      clientKey: "demo-app",
      description: "A useful app",
      homepageUrl: "https://demo.example",
      category: "Productivity & Collaboration",
      allowedScopes: ["openid", "profile"],
    },
    idempotencyKey: "oauth-client-review:publish:client-1:2026-07-23T12:00:00.000Z",
  }]);
  assert.equal("publishRequestedAt" in (result ?? {}), false, "internal retry timestamp must not leak through the API record");
});

test("repeated queued requests reuse the same provider idempotency key for delivery retries", async () => {
  const requestedAt = new Date("2026-07-23T12:00:00.000Z");
  const client = {
    id: "client-1",
    serverId: "server-1",
    clientId: "demo-app",
    appType: "server_local",
    publishStatus: "publish_requested",
    category: "Infrastructure",
    dataAccessSummary: null,
    publishRejectionReason: null,
    name: "Demo App",
    description: "Queued app",
    homepageUrl: null,
    returnUrl: "https://demo.example/callback",
    agentManifestUrl: null,
    allowedScopes: ["openid"],
    logoUrl: null,
    humanMarketplaceVisible: true,
    createdByUserId: "user-1",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-23T12:05:00.000Z"),
    publishRequestedAt: requestedAt,
  };
  const tx = makeTx({
    selects: [
      [{ description: client.description, publishStatus: "publish_requested" }],
      [client],
    ].map((result) => ({ result })),
    updates: [{ result: [] }],
  });
  const keys: string[] = [];

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);
  __setOAuthServiceReviewEmailSenderForTests(async (_emailInput, options) => {
    keys.push(options?.idempotencyKey ?? "");
    return "email-1";
  });

  await requestOAuthClientPublish({
    serverId: "server-1",
    clientId: "client-1",
    requestedByUserId: "user-1",
  });

  assert.deepEqual(keys, ["oauth-client-review:publish:client-1:2026-07-23T12:00:00.000Z"]);
});

test("marketplace offline email failures surface only after the audit transaction commits", async () => {
  const requestedAt = new Date("2026-07-23T13:00:00.000Z");
  const client = {
    id: "client-2",
    serverId: "server-1",
    clientId: "offline-app",
    appType: "third_party_global",
    publishStatus: "unpublish_requested",
    category: "Infrastructure",
    dataAccessSummary: null,
    publishRejectionReason: null,
    name: "Offline App",
    description: "Take this app offline",
    homepageUrl: "https://offline.example",
    returnUrl: "https://offline.example/callback",
    agentManifestUrl: null,
    allowedScopes: ["openid"],
    logoUrl: null,
    humanMarketplaceVisible: true,
    createdByUserId: "user-1",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: requestedAt,
    publishRequestedAt: requestedAt,
  };
  const tx = makeTx({
    selects: [{ result: [{ id: client.id, publishStatus: "published" }] }],
    updates: [{ result: [client] }],
    inserts: [{ result: [{ id: "audit-2" }] }],
  });
  let committed = false;
  let sendObservedCommit = false;

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => {
      const result = await fn(tx);
      committed = true;
      return result;
    },
  }) as any);
  __setOAuthServiceReviewEmailSenderForTests(async (emailInput, options) => {
    sendObservedCommit = committed;
    assert.equal(emailInput.requestKind, "offline");
    assert.equal(options?.idempotencyKey, "oauth-client-review:offline:client-2:2026-07-23T13:00:00.000Z");
    throw new Error("email unavailable");
  });

  await assert.rejects(
    requestOAuthClientUnpublish({
      serverId: "server-1",
      clientId: "client-2",
      requestedByUserId: "user-1",
    }),
    /email unavailable/,
  );

  assert.equal(sendObservedCommit, true);
});

test("exchangeAccessRequest consumes remembered requests on first exchange", async () => {
  const consumeCapture: UpdateCapture = {};
  const tokenInsertCapture: InsertCapture = {};
  const auditInsertCapture: InsertCapture = {};
  const tx = makeTx({
    selects: [
      {
        result: [{
          id: "request-1",
          clientId: "client-1",
          serverId: "server-1",
          agentId: "agent-1",
          scopes: ["identity"],
          status: "approved",
          remember: true,
          consumedAt: null,
        }],
      },
      {
        result: [{
          id: "grant-1",
          serverId: "server-1",
          agentId: "agent-1",
          clientId: "client-1",
          revokedAt: null,
        }],
      },
    ],
    inserts: [
      { result: [{ id: "token-1" }], capture: tokenInsertCapture },
      { result: [{ id: "audit-1" }], capture: auditInsertCapture },
    ],
    updates: [{ result: undefined, capture: consumeCapture }],
  });

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);

  await exchangeAccessRequest({ clientId: "client-1", requestId: "request-1" });

  assert.equal(tokenInsertCapture.table, oauthAccessTokens);
  assert.equal(consumeCapture.table, oauthAccessRequests);
  assert.ok(consumeCapture.values?.consumedAt instanceof Date);
  assert.equal(auditInsertCapture.table, integrationAuditEvents);
  assert.deepEqual(auditInsertCapture.values?.metadata, {
    stage: "token_exchange",
    result: "issued",
    principalType: "agent",
  });
  assert.equal(auditInsertCapture.values?.requestId, null);
  assert.equal(auditInsertCapture.values?.correlationId, null);
});

test("exchangeAccessRequest rejects remembered requests once already consumed", async () => {
  const tx = makeTx({
    selects: [{
      result: [{
        id: "request-1",
        clientId: "client-1",
        status: "approved",
        remember: true,
        consumedAt: new Date(),
      }],
    }],
  });

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);

  await assert.rejects(
    () => exchangeAccessRequest({ clientId: "client-1", requestId: "request-1" }),
    /request_already_consumed/,
  );
});

test("exchangeAccessRequest rejects remembered requests when active grant is gone", async () => {
  const tx = makeTx({
    selects: [
      {
        result: [{
          id: "request-1",
          clientId: "client-1",
          serverId: "server-1",
          agentId: "agent-1",
          scopes: ["identity"],
          status: "approved",
          remember: true,
          consumedAt: null,
        }],
      },
      { result: [] },
    ],
  });

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);

  await assert.rejects(
    () => exchangeAccessRequest({ clientId: "client-1", requestId: "request-1" }),
    /access_denied/,
  );
});

test("exchangeAccessRequest mints human tokens without requiring an agent grant", async () => {
  const tokenInsertCapture: InsertCapture = {};
  const auditInsertCapture: InsertCapture = {};
  const tx = makeTx({
    selects: [
      {
        result: [{
          id: "request-1",
          clientId: "client-1",
          serverId: "server-1",
          principalType: "human",
          agentId: null,
          userId: "user-1",
          scopes: ["openid", "profile"],
          status: "approved",
          remember: false,
          consumedAt: null,
          createdAt: new Date("2026-07-21T00:00:00.000Z"),
        }],
      },
      { result: humanOpenIdIdentityRow() },
    ],
    inserts: [
      { result: [{ id: "token-1" }], capture: tokenInsertCapture },
      { result: [{ id: "audit-1" }], capture: auditInsertCapture },
    ],
    updates: [{ result: undefined }],
  });

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);

  const result = await exchangeAccessRequest({
    clientId: "client-1",
    requestId: "request-1",
    now: new Date("2026-07-21T00:00:00.000Z"),
  });

  assert.equal(tokenInsertCapture.table, oauthAccessTokens);
  assert.equal(tokenInsertCapture.values?.principalType, "human");
  assert.equal(tokenInsertCapture.values?.agentId, null);
  assert.equal(tokenInsertCapture.values?.userId, "user-1");
  assert.equal(result.identity?.humanId, "user-1");
  assert.equal(auditInsertCapture.table, integrationAuditEvents);
  assert.deepEqual(auditInsertCapture.values?.metadata, {
    stage: "token_exchange",
    result: "issued",
    principalType: "human",
  });
});

test("exchangeAccessRequest accepts human authorization codes at the TTL boundary", async () => {
  const boundary = new Date("2026-07-21T00:10:00.000Z");
  const tokenInsertCapture: InsertCapture = {};
  const auditInsertCapture: InsertCapture = {};
  const consumeCapture: UpdateCapture = {};
  const tx = makeTx({
    selects: [
      {
        result: [{
          id: "request-1",
          clientId: "client-1",
          serverId: "server-1",
          principalType: "human",
          agentId: null,
          userId: "user-1",
          scopes: ["openid", "profile"],
          status: "approved",
          remember: false,
          consumedAt: null,
          createdAt: new Date(boundary.getTime() - HUMAN_AUTHORIZATION_CODE_TTL_MS),
        }],
      },
      { result: humanOpenIdIdentityRow() },
    ],
    inserts: [
      { result: [{ id: "token-1" }], capture: tokenInsertCapture },
      { result: [{ id: "audit-1" }], capture: auditInsertCapture },
    ],
    updates: [{ result: undefined, capture: consumeCapture }],
  });

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);

  await exchangeAccessRequest({
    clientId: "client-1",
    requestId: "request-1",
    now: boundary,
  });

  assert.equal(tokenInsertCapture.table, oauthAccessTokens);
  assert.equal(auditInsertCapture.table, integrationAuditEvents);
  assert.deepEqual(auditInsertCapture.values?.metadata, {
    stage: "token_exchange",
    result: "issued",
    principalType: "human",
  });
  assert.equal(consumeCapture.values?.consumedAt, boundary);
});

test("exchangeAccessRequest rejects expired unused human authorization codes", async () => {
  const now = new Date("2026-07-21T00:10:00.001Z");
  const tx = makeTx({
    selects: [{
      result: [{
        id: "request-1",
        clientId: "client-1",
        serverId: "server-1",
        principalType: "human",
        agentId: null,
        userId: "user-1",
        scopes: ["openid", "profile"],
        status: "approved",
        remember: false,
        consumedAt: null,
        createdAt: new Date(now.getTime() - HUMAN_AUTHORIZATION_CODE_TTL_MS - 1),
      }],
    }],
  });

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);

  await assert.rejects(
    () => exchangeAccessRequest({ clientId: "client-1", requestId: "request-1", now }),
    new RegExp(AUTHORIZATION_CODE_EXPIRED_ERROR),
  );
});

test("exchangeAccessRequest keeps consumed replay ordering before human authorization expiry", async () => {
  const now = new Date("2026-07-21T00:10:00.001Z");
  const tx = makeTx({
    selects: [{
      result: [{
        id: "request-1",
        clientId: "client-1",
        serverId: "server-1",
        principalType: "human",
        agentId: null,
        userId: "user-1",
        scopes: ["openid", "profile"],
        status: "approved",
        remember: false,
        consumedAt: new Date("2026-07-21T00:00:30.000Z"),
        createdAt: new Date(now.getTime() - HUMAN_AUTHORIZATION_CODE_TTL_MS - 1),
      }],
    }],
  });

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);

  await assert.rejects(
    () => exchangeAccessRequest({ clientId: "client-1", requestId: "request-1", now }),
    /request_already_consumed/,
  );
});

test("exchangeAccessRequest tolerates modest future clock skew for human authorization codes", async () => {
  const now = new Date("2026-07-21T00:10:00.000Z");
  const tokenInsertCapture: InsertCapture = {};
  const auditInsertCapture: InsertCapture = {};
  const tx = makeTx({
    selects: [
      {
        result: [{
          id: "request-1",
          clientId: "client-1",
          serverId: "server-1",
          principalType: "human",
          agentId: null,
          userId: "user-1",
          scopes: ["openid", "profile"],
          status: "approved",
          remember: false,
          consumedAt: null,
          createdAt: new Date(now.getTime() + 30_000),
        }],
      },
      { result: humanOpenIdIdentityRow() },
    ],
    inserts: [
      { result: [{ id: "token-1" }], capture: tokenInsertCapture },
      { result: [{ id: "audit-1" }], capture: auditInsertCapture },
    ],
    updates: [{ result: undefined }],
  });

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);

  await exchangeAccessRequest({ clientId: "client-1", requestId: "request-1", now });

  assert.equal(tokenInsertCapture.table, oauthAccessTokens);
  assert.equal(auditInsertCapture.table, integrationAuditEvents);
});

test("revokeGrant also revokes outstanding access tokens", async () => {
  const grantUpdateCapture: UpdateCapture = {};
  const tokenUpdateCapture: UpdateCapture = {};
  const tx = makeTx({
    selects: [{
      result: [{
        id: "grant-1",
        serverId: "server-1",
        revokedAt: null,
      }],
    }],
    updates: [
      { result: [{ id: "grant-1", revokedAt: new Date() }], capture: grantUpdateCapture },
      { result: undefined, capture: tokenUpdateCapture },
    ],
  });

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);

  await revokeGrant({ serverId: "server-1", grantId: "grant-1", revokedByUserId: "user-1" });

  assert.equal(grantUpdateCapture.table, oauthGrants);
  assert.equal(tokenUpdateCapture.table, oauthAccessTokens);
  assert.ok(tokenUpdateCapture.values?.revokedAt instanceof Date);
});

test("revokeGrant ignores grants outside the caller server", async () => {
  const tx = makeTx({
    selects: [{
      result: [{
        id: "grant-1",
        serverId: "server-2",
        revokedAt: null,
      }],
    }],
  });

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);

  const result = await revokeGrant({ serverId: "server-1", grantId: "grant-1", revokedByUserId: "user-1" });
  assert.equal(result, null);
});

test("deleteOAuthClient locks the client row, revokes active grants and tokens, then deletes the client", async () => {
  const selectCapture: SelectCapture = {};
  const grantUpdateCapture: UpdateCapture = {};
  const tokenUpdateCapture: UpdateCapture = {};
  const auditInsertCapture: InsertCapture = {};
  const clientDeleteCapture: DeleteCapture = {};
  const tx = makeTx({
    selects: [{
      result: [{
        id: "client-1",
        serverId: "server-1",
        clientId: "demo-client",
        appType: "server_local",
        publishStatus: "private",
      }],
      capture: selectCapture,
    }],
    updates: [
      { result: undefined, capture: grantUpdateCapture },
      { result: undefined, capture: tokenUpdateCapture },
    ],
    inserts: [{ result: [{ id: "audit-1" }], capture: auditInsertCapture }],
    deletes: [{
      result: [{
        id: "client-1",
        serverId: "server-1",
        clientId: "demo-client",
        appType: "server_local",
        name: "Demo",
      }],
      capture: clientDeleteCapture,
    }],
  });

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);

  const result = await deleteOAuthClient({ serverId: "server-1", clientId: "client-1" });

  assert.equal(selectCapture.lockMode, "update");
  assert.equal(grantUpdateCapture.table, oauthGrants);
  assert.ok(grantUpdateCapture.values?.revokedAt instanceof Date);
  assert.equal(tokenUpdateCapture.table, oauthAccessTokens);
  assert.ok(tokenUpdateCapture.values?.revokedAt instanceof Date);
  assert.equal(auditInsertCapture.table, integrationAuditEvents);
  assert.equal(clientDeleteCapture.table, oauthClients);
  assert.equal(result?.id, "client-1");
});

test("getIdentityByAccessToken rejects tokens whose parent grant was revoked", async () => {
  __setOAuthServiceDbForTests(() => ({
    select: () => makeSelectBuilder([{
      tokenId: "token-1",
      principalType: "agent",
      scopes: ["identity"],
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      grantRevokedAt: new Date(),
      clientKey: "client-key",
      clientName: "Client",
      serverId: "server-1",
      serverSlug: "acme",
      serverDeletedAt: null,
      agentId: "agent-1",
      agentName: "ray",
      agentDisplayName: "Ray",
      agentAvatarUrl: null,
      agentDescription: null,
      agentDeletedAt: null,
      agentRole: "member",
    }]),
  }) as any);

  const token = await getIdentityByAccessToken("slock_at_test");
  assert.equal(token, null);
});

test("getIdentityByAccessToken rejects human tokens after server membership is removed", async () => {
  __setOAuthServiceDbForTests(() => ({
    select: () => makeSelectBuilder([{
      tokenId: "token-1",
      principalType: "human",
      scopes: ["openid", "profile"],
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      grantRevokedAt: null,
      clientKey: "client-key",
      clientName: "Client",
      serverId: "server-1",
      serverSlug: "acme",
      serverDeletedAt: null,
      humanId: "user-1",
      humanName: "alice",
      humanDisplayName: "Alice",
      humanAvatarUrl: null,
      humanDescription: null,
      humanRole: null,
    }]),
  }) as any);

  const token = await getIdentityByAccessToken("slock_at_test");
  assert.equal(token, null);
});

test("getIdentityByAccessToken rejects agent tokens after server membership is removed", async () => {
  __setOAuthServiceDbForTests(() => ({
    select: () => makeSelectBuilder([{
      tokenId: "token-1",
      principalType: "agent",
      scopes: ["openid", "profile"],
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      grantRevokedAt: null,
      clientKey: "client-key",
      clientName: "Client",
      serverId: "server-1",
      serverSlug: "acme",
      serverDeletedAt: null,
      agentId: "agent-1",
      agentName: "ray",
      agentDisplayName: "Ray",
      agentAvatarUrl: null,
      agentDescription: null,
      agentDeletedAt: null,
      agentRole: null,
    }]),
  }) as any);

  const token = await getIdentityByAccessToken("slock_at_test");
  assert.equal(token, null);
});

test("getIdentityByAccessToken rejects tokens for deleted servers and agents", async () => {
  __setOAuthServiceDbForTests(() => ({
    select: () => makeSelectBuilder([{
      tokenId: "token-1",
      principalType: "agent",
      scopes: ["identity"],
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      grantRevokedAt: null,
      clientKey: "client-key",
      clientName: "Client",
      serverId: "server-1",
      serverSlug: "acme",
      serverDeletedAt: new Date(),
      agentId: "agent-1",
      agentName: "ray",
      agentDisplayName: "Ray",
      agentAvatarUrl: null,
      agentDescription: null,
      agentDeletedAt: null,
      agentRole: "member",
    }]),
  }) as any);

  assert.equal(await getIdentityByAccessToken("slock_at_test"), null);

  __setOAuthServiceDbForTests(() => ({
    select: () => makeSelectBuilder([{
      tokenId: "token-2",
      principalType: "agent",
      scopes: ["identity"],
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      grantRevokedAt: null,
      clientKey: "client-key",
      clientName: "Client",
      serverId: "server-1",
      serverSlug: "acme",
      serverDeletedAt: null,
      agentId: "agent-1",
      agentName: "ray",
      agentDisplayName: "Ray",
      agentAvatarUrl: null,
      agentDescription: null,
      agentDeletedAt: new Date(),
      agentRole: "member",
    }]),
  }) as any);

  assert.equal(await getIdentityByAccessToken("slock_at_test"), null);
});

test("approveAccessRequest locks the request row and returns a stable shape for non-pending requests", async () => {
  const selectCapture: SelectCapture = {};
  const tx = makeTx({
    selects: [{
      result: [{
        id: "request-1",
        serverId: "server-1",
        status: "approved",
      }],
      capture: selectCapture,
    }],
  });

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);

  const result = await approveAccessRequest({
    serverId: "server-1",
    requestId: "request-1",
    resolvedByUserId: "user-1",
    remember: true,
  });

  assert.equal(selectCapture.lockMode, "update");
  assert.deepEqual(result, {
    request: {
      id: "request-1",
      serverId: "server-1",
      status: "approved",
    },
    grantId: null,
  });
});

test("approveAccessRequest rejects requests outside the caller server", async () => {
  const tx = makeTx({
    selects: [{
      result: [{
        id: "request-1",
        serverId: "server-2",
        status: "pending",
      }],
    }],
  });

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);

  await assert.rejects(
    () => approveAccessRequest({
      serverId: "server-1",
      requestId: "request-1",
      resolvedByUserId: "user-1",
      remember: true,
    }),
    /Access request not found/,
  );
});

test("denyAccessRequest locks the row and does not overwrite non-pending requests", async () => {
  const selectCapture: SelectCapture = {};
  const tx = makeTx({
    selects: [{
      result: [{
        id: "request-1",
        serverId: "server-1",
        status: "approved",
      }],
      capture: selectCapture,
    }],
  });

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);

  const result = await denyAccessRequest({
    serverId: "server-1",
    requestId: "request-1",
    resolvedByUserId: "user-1",
  });

  assert.equal(selectCapture.lockMode, "update");
  assert.deepEqual(result, {
    id: "request-1",
    serverId: "server-1",
    status: "approved",
  });
});

test("denyAccessRequest ignores requests outside the caller server", async () => {
  const tx = makeTx({
    selects: [{
      result: [{
        id: "request-1",
        serverId: "server-2",
        status: "pending",
      }],
    }],
  });

  __setOAuthServiceDbForTests(() => ({
    transaction: async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx),
  }) as any);

  const result = await denyAccessRequest({
    serverId: "server-1",
    requestId: "request-1",
    resolvedByUserId: "user-1",
  });
  assert.equal(result, null);
});
