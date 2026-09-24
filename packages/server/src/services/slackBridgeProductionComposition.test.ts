import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import sharp from "sharp";
import { runNamedCase } from "../test/runNamedCase.js";

import { and, desc, eq, gt, sql } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import {
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppInstallGrantReceipts,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppServerGrants,
  externalAuthorPolicies,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  externalInboundEvents,
  externalHumanIdentityLinks,
  externalMessageLinks,
  externalProjectionAvatarArtifacts,
  messages,
  oauthAccessRequests,
  oauthClients,
  oauthClientInstalls,
  users,
} from "../db/schema.js";
import { signAccessToken } from "../middleware/auth.js";
import { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "../routes/slackBridge.js";
import { openTestApp } from "../test/integration/app.js";
import { createServer } from "./serverService.js";
import { createAgent } from "./agentService.js";
import { createFeatureFlagRule } from "./featureFlagService.js";
import { createSlackBridgeEnvCredentialCipher } from "./slackBridgeEnvSecrets.js";
import { processExternalInboundEventOnce } from "./externalInboundWorkerService.js";
import { slackBridgeInstallGrantHash } from "./slackBridgeInstallGrantService.js";
import { createSlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime.js";
import { createSlackInboundAttachmentAdapter } from "./slackInboundAttachmentAdapter.js";
import { createSlackOutboundAttachmentAdapter } from "./slackOutboundAttachmentAdapter.js";
import { lookupSlackProviderConversation } from "./slackProviderAdapter.js";
import {
  reconcileSlackBridgeOAuthIdentityAppType,
  refreshSlackPublicConversationAuthority,
  slackBridgeProvisioningManifestHash,
  SLACK_BRIDGE_PROVISIONING_CAPABILITIES,
} from "./slackBridgeProvisioningControlPlane.js";
import { createSlackBridgeServerRuntimeFromEnv } from "./slackBridgeServerRuntime.js";
import { ExternalAppControlPlaneError } from "./externalAppControlPlaneService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const REGISTRATION_ID = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_KEY = Buffer.alloc(32, 17).toString("base64");
const PRODUCTION_ENV: NodeJS.ProcessEnv = {
  SLACK_BRIDGE_ENVIRONMENT: "test",
  SLACK_BRIDGE_REGISTRATION_ID: REGISTRATION_ID,
  SLACK_BRIDGE_PROVIDER_APP_ID: "A_PRODUCTION_COMPOSITION",
  SLACK_BRIDGE_PROVIDER_OAUTH_CLIENT_ID: "production-composition-client",
  SLACK_BRIDGE_OAUTH_REDIRECT_URI: "https://raft.example/api/slack-bridge/oauth/callback",
  SLACK_BRIDGE_EVENTS_REQUEST_URL: "https://bridge.example/api/slack-bridge/events",
  SLACK_BRIDGE_SIGNING_SECRET: "signing-secret",
  SLACK_BRIDGE_OAUTH_CLIENT_SECRET: "oauth-client-secret",
  SLACK_BRIDGE_CREDENTIAL_ENCRYPTION_KEY: CREDENTIAL_KEY,
  SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString("base64"),
  APP_URL: "http://127.0.0.1:5173",
};

const PRODUCTION_BOOTSTRAP = {
  registrationId: REGISTRATION_ID,
  environment: "test" as const,
  providerAppId: PRODUCTION_ENV.SLACK_BRIDGE_PROVIDER_APP_ID!,
  providerOAuthClientId: PRODUCTION_ENV.SLACK_BRIDGE_PROVIDER_OAUTH_CLIENT_ID!,
  oauthRedirectUri: PRODUCTION_ENV.SLACK_BRIDGE_OAUTH_REDIRECT_URI!,
  eventsRequestUrl: PRODUCTION_ENV.SLACK_BRIDGE_EVENTS_REQUEST_URL!,
  capabilityManifestVersion: 1,
  capabilityManifestHash: slackBridgeProvisioningManifestHash({
    oauthRedirectUri: PRODUCTION_ENV.SLACK_BRIDGE_OAUTH_REDIRECT_URI!,
    eventsRequestUrl: PRODUCTION_ENV.SLACK_BRIDGE_EVENTS_REQUEST_URL!,
  }),
  requiredCapabilities: SLACK_BRIDGE_PROVISIONING_CAPABILITIES,
  signingSecret: {
    encryptedSecretRef: "env:SLACK_BRIDGE_SIGNING_SECRET",
    envelopeKeyId: "env:process",
    secretRevision: 1,
  },
  oauthClientSecret: {
    encryptedSecretRef: "env:SLACK_BRIDGE_OAUTH_CLIENT_SECRET",
    envelopeKeyId: "env:process",
    secretRevision: 1,
  },
};

function requestHeaders(userId: string, serverId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${signAccessToken(userId)}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

async function seedOwner() {
  const [owner] = await getDb().insert(users).values({
    email: `slack-composition-${randomUUID()}@raft.test`,
    name: `slack-composition-${randomUUID().slice(0, 8)}`,
    displayName: "Slack Composition Owner",
    passwordHash: "not-used",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer(
    "Slack Production Composition",
    `slack-composition-${randomUUID()}`,
    owner.id,
  );
  await createFeatureFlagRule({
    flagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    stage: "server",
    decision: "allow",
    values: [server.id],
  });
  return { owner, server };
}

const PROVISIONING_REQUESTS: ReadonlyArray<readonly [string, string, unknown?]> = [
  ["GET", "/api/slack-bridge/provisioning"],
  ["POST", "/api/slack-bridge/provisioning/connect"],
  ["PUT", "/api/slack-bridge/provisioning/channel-pairs", {
    pairs: [{
      raftChannelId: "22222222-2222-4222-8222-222222222222",
      slackChannelId: "C_PRODUCTION_GENERAL",
    }],
  }],
  ["DELETE", "/api/slack-bridge/provisioning/channel-pairs", {
    pairs: [{
      raftChannelId: "22222222-2222-4222-8222-222222222222",
      slackChannelId: "C_PRODUCTION_GENERAL",
      expectedBindingEpoch: 1,
    }],
  }],
  ["POST", "/api/slack-bridge/provisioning/disconnect", { expectedConnectionEpoch: 1 }],
  ["POST", "/api/slack-bridge/provisioning/preflight"],
  ["POST", "/api/slack-bridge/provisioning/enable"],
];

async function observeProvisioningEndpoints(baseUrl: string, headers: Record<string, string>) {
  const observations: Array<{
    method: string;
    path: string;
    status: number;
    code: string | null;
  }> = [];
  for (const [method, path, body] of PROVISIONING_REQUESTS) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let code: string | null = null;
    try {
      const parsed = await response.clone().json() as { code?: unknown };
      code = typeof parsed.code === "string" ? parsed.code : null;
    } catch {
      code = null;
    }
    observations.push({ method, path, status: response.status, code });
  }
  return observations;
}

async function waitForInstallGrantReceipt(installId: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const receipts = await getDb().select().from(externalAppInstallGrantReceipts)
      .where(eq(externalAppInstallGrantReceipts.installId, installId));
    if (receipts.length > 0) return receipts;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return getDb().select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, installId));
}

test("true Server production composition makes all seven provisioning endpoints reachable", async () => {
  let runtime: Awaited<ReturnType<typeof createSlackBridgeServerRuntimeFromEnv>>;
  let driftBindingId: string | null = null;
  let grantHeaderMode: "present" | "missing" | "empty" = "present";
  let grantIdentityMode: "valid" | "wrong-team" | "wrong-user" | "missing-bot" = "valid";
  let providerAuthTestCalls = 0;
  let providerAudienceCalls = 0;
  let providerBotInConversation = true;
  let providerOtherChannelMember = false;
  const providerQueryRequests: Array<{
    method: string;
    httpMethod: string | undefined;
    body: BodyInit | null | undefined;
    authorization: string | null;
    contentType: string | null;
    query: string;
  }> = [];
  const providerFileDownloads: Array<{
    authorization: string | null;
    redirect: RequestRedirect | undefined;
  }> = [];
  const providerFileUploads: Buffer[] = [];
  const providerCompletionBodies: Array<Record<string, unknown>> = [];
  let providerCompletionCalls = 0;
  let providerAvatarFetchCalls = 0;
  const providerAvatarBytes = await sharp({
    create: { width: 72, height: 72, channels: 3, background: { r: 12, g: 34, b: 56 } },
  }).png().toBuffer();
  const providerFetch = (async (url, init) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.hostname === "avatars.slack-edge.com") {
        providerAvatarFetchCalls += 1;
        assert.equal(new Headers(init?.headers).get("authorization"), null);
        assert.equal(init?.redirect, "error");
        return new Response(new Uint8Array(providerAvatarBytes), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (requestUrl.hostname === "files.slack.com") {
        if (requestUrl.pathname.startsWith("/upload/")) {
          const chunks: Buffer[] = [];
          for await (const chunk of init?.body as unknown as AsyncIterable<Uint8Array>) {
            chunks.push(Buffer.from(chunk));
          }
          providerFileUploads.push(Buffer.concat(chunks));
          return new Response("ok", { status: 200 });
        }
        providerFileDownloads.push({
          authorization: new Headers(init?.headers).get("authorization"),
          redirect: init?.redirect,
        });
        return new Response("abcdef", {
          status: 200,
          headers: { "content-length": "6", "content-type": "application/pdf" },
        });
      }
      const method = requestUrl.pathname.split("/").at(-1);
      if (method === "auth.test") {
        providerAuthTestCalls += 1;
        if (driftBindingId) {
          const id = driftBindingId;
          driftBindingId = null;
          await getDb().update(externalChannelBindings).set({
            providerConversationId: "C_DRIFTED_DURING_ENABLE",
          }).where(eq(externalChannelBindings.id, id));
        }
        return new Response(JSON.stringify({
          ok: true,
          team_id: grantIdentityMode === "wrong-team"
            ? "T_OTHER"
            : "T_PRODUCTION_COMPOSITION",
          team: "Production Composition Workspace",
          user_id: grantIdentityMode === "wrong-user"
            ? "U_OTHER"
            : "U_PRODUCTION_BOT",
          ...(grantIdentityMode === "missing-bot" ? {} : { bot_id: "B_PRODUCTION_BOT" }),
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            ...(grantHeaderMode === "missing" ? {} : {
              "x-oauth-scopes": grantHeaderMode === "empty"
                ? ""
                : `  ${SLACK_BRIDGE_REQUIRED_BOT_SCOPES.slice().reverse().join(" , ")} , ${SLACK_BRIDGE_REQUIRED_BOT_SCOPES[0]} `,
            }),
            // This deliberately different header proves the authority reader
            // consumes the token grant, not the method's accepted scopes.
            "x-accepted-oauth-scopes": "admin",
          },
        });
      }
      if (method === "oauth.v2.access") {
        return new Response(JSON.stringify({
          ok: true,
          app_id: "A_PRODUCTION_COMPOSITION",
          access_token: "xoxb-production-composition",
          token_type: "bot",
          bot_user_id: "U_PRODUCTION_BOT",
          authed_user: { id: "U_PRODUCTION_OWNER" },
          team: {
            id: "T_PRODUCTION_COMPOSITION",
            name: "Production Composition Workspace",
          },
          scope: SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(","),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "conversations.list") {
        providerQueryRequests.push({
          method,
          httpMethod: init?.method,
          body: init?.body,
          authorization: new Headers(init?.headers).get("authorization"),
          contentType: new Headers(init?.headers).get("content-type"),
          query: requestUrl.searchParams.toString(),
        });
        return new Response(JSON.stringify({
          ok: true,
          channels: [
            { id: "C_PRODUCTION_GENERAL", name: "general", is_private: false, is_member: true },
            {
              id: "C_PRODUCTION_OTHER",
              name: "other-public",
              is_private: false,
              is_member: providerOtherChannelMember,
            },
            // Slack accepts a POST here but can silently omit app-member
            // private channels. The production transport must use GET query.
            ...(init?.method === "GET"
              ? [
                  { id: "C_PRODUCTION_PRIVATE", name: "private", is_private: true, is_member: true },
                  { id: "C_PRODUCTION_PRIVATE_2", name: "private-2", is_private: true, is_member: true },
                ]
              : []),
          ],
          response_metadata: { next_cursor: "" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "conversations.members") {
        providerAudienceCalls += 1;
        providerQueryRequests.push({
          method,
          httpMethod: init?.method,
          body: init?.body,
          authorization: new Headers(init?.headers).get("authorization"),
          contentType: new Headers(init?.headers).get("content-type"),
          query: requestUrl.searchParams.toString(),
        });
        return new Response(JSON.stringify({
          ok: true,
          members: [
            ...(providerBotInConversation ? ["U_PRODUCTION_BOT"] : []),
            "U_PRODUCTION_OWNER",
          ],
          response_metadata: { next_cursor: "" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "conversations.info") {
        providerQueryRequests.push({
          method,
          httpMethod: init?.method,
          body: init?.body,
          authorization: new Headers(init?.headers).get("authorization"),
          contentType: new Headers(init?.headers).get("content-type"),
          query: requestUrl.searchParams.toString(),
        });
        return new Response(JSON.stringify({
          ok: true,
          // Slack's read endpoint is GET/query. A POST-shaped request may be
          // accepted yet fail to return the requested conversation fact.
          ...(init?.method === "GET" ? {
            channel: {
              id: "C_PRODUCTION_GENERAL",
              name: "general",
              is_private: false,
              is_archived: false,
              is_member: true,
            },
          } : {}),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "users.info") {
        providerQueryRequests.push({
          method,
          httpMethod: init?.method,
          body: init?.body,
          authorization: new Headers(init?.headers).get("authorization"),
          contentType: new Headers(init?.headers).get("content-type"),
          query: requestUrl.searchParams.toString(),
        });
        return new Response(JSON.stringify({
          ok: true,
          user: {
            id: "U_PRODUCTION_OWNER",
            name: "production-owner",
            is_bot: false,
            is_app_user: false,
            is_restricted: false,
            is_ultra_restricted: false,
            profile: {
              display_name: "Production Owner",
              real_name: "Production Owner",
              image_72: "https://avatars.slack-edge.com/production-owner.png",
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "files.info") {
        providerQueryRequests.push({
          method,
          httpMethod: init?.method,
          body: init?.body,
          authorization: new Headers(init?.headers).get("authorization"),
          contentType: new Headers(init?.headers).get("content-type"),
          query: requestUrl.searchParams.toString(),
        });
        return new Response(JSON.stringify({
          ok: true,
          file: {
            id: requestUrl.searchParams.get("file"),
            user: "U_PRODUCTION_OWNER",
            name: "design.pdf",
            mimetype: "application/pdf",
            size: 6,
            timestamp: 1_788_541_200,
            url_private_download: "https://files.slack.com/files-pri/T_PRODUCTION-F_PRODUCTION/design.pdf",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "files.getUploadURLExternal") {
        const fileId = `F_UPLOAD_${providerFileUploads.length + 1}`;
        return new Response(JSON.stringify({
          ok: true,
          file_id: fileId,
          upload_url: `https://files.slack.com/upload/${fileId}`,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "files.completeUploadExternal") {
        providerCompletionCalls += 1;
        const request = JSON.parse(String(init?.body)) as { files: Array<{ id: string }> };
        providerCompletionBodies.push(request);
        return new Response(JSON.stringify({ ok: true, files: request.files }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "conversations.history") {
        return new Response(JSON.stringify({
          ok: true,
          messages: [{
            ts: "1788541200.000300",
            files: providerFileUploads.map((_, index) => ({ id: `F_UPLOAD_${index + 1}` })),
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected Slack method ${method}`);
    }) as typeof fetch;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, async slackBridgeFactory() {
      runtime = await createSlackBridgeServerRuntimeFromEnv(PRODUCTION_ENV, {
        db: getDb(),
        fetch: providerFetch,
      });
      assert.ok(runtime, "production runtime must start from complete environment authority");
      return runtime;
    } });
  try {
    const probe = await seedOwner();
    const observations = await observeProvisioningEndpoints(
      app.baseUrl,
      requestHeaders(probe.owner.id, probe.server.id),
    );
    assert.deepEqual(
      observations.filter(({ status }) => status === 503),
      [],
      "the real production composition must keep every provisioning endpoint out of fail-closed 503",
    );

    const { owner, server } = await seedOwner();
    const headers = requestHeaders(owner.id, server.id);
    const load = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
    assert.equal(load.status, 200, await load.clone().text());
    assert.equal((await load.json() as { snapshot: { stage: string } }).snapshot.stage, "connect");

    const connect = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/connect`, {
      method: "POST",
      headers,
    });
    assert.equal(connect.status, 200, await connect.clone().text());
    const connectBody = await connect.json() as {
      snapshot: { stage: string };
      oauthAuthority: { registrationId: string; serverGrantId: string; grantEpoch: number };
    };
    assert.equal(connectBody.snapshot.stage, "oauth");

    const [registration] = await getDb().select().from(externalAppRegistrations)
      .where(eq(externalAppRegistrations.id, REGISTRATION_ID));
    assert.ok(registration);
    const [client] = await getDb().select().from(oauthClients)
      .where(eq(oauthClients.id, registration.oauthClientId));
    const [grant] = await getDb().select().from(externalAppServerGrants)
      .where(eq(externalAppServerGrants.serverId, server.id));
    assert.ok(client && grant);
    assert.equal(client.clientId, `slack-bridge:${REGISTRATION_ID}`);
    assert.equal(client.appType, "third_party_global");
    assert.equal(client.publishStatus, "published");
    assert.equal(client.humanMarketplaceVisible, false);

    const beforeRollback = await reconcileSlackBridgeOAuthIdentityAppType({
      bootstrap: PRODUCTION_BOOTSTRAP,
      expectedAppType: "third_party_global",
      nextAppType: "third_party_global",
      dryRun: true,
    });
    const rollback = await reconcileSlackBridgeOAuthIdentityAppType({
      bootstrap: PRODUCTION_BOOTSTRAP,
      expectedAppType: "third_party_global",
      nextAppType: "slock_builtin",
      expectedAuthoritySha256: beforeRollback.authoritySha256,
    });
    assert.equal(rollback.changed, true);
    assert.equal(rollback.installCount, 2);
    assert.equal((await getDb().select({ appType: oauthClients.appType }).from(oauthClients)
      .where(eq(oauthClients.id, client.id)))[0]?.appType, "slock_builtin");

    const beforeForward = await reconcileSlackBridgeOAuthIdentityAppType({
      bootstrap: PRODUCTION_BOOTSTRAP,
      expectedAppType: "slock_builtin",
      nextAppType: "slock_builtin",
      dryRun: true,
    });
    const forward = await reconcileSlackBridgeOAuthIdentityAppType({
      bootstrap: PRODUCTION_BOOTSTRAP,
      expectedAppType: "slock_builtin",
      nextAppType: "third_party_global",
      expectedAuthoritySha256: beforeForward.authoritySha256,
    });
    assert.equal(forward.changed, true);
    assert.equal(forward.installCount, 2);
    assert.equal((await getDb().select({ appType: oauthClients.appType }).from(oauthClients)
      .where(eq(oauthClients.id, client.id)))[0]?.appType, "third_party_global");

    const assertPreflightDriftRejected = async () => {
      await assert.rejects(
        reconcileSlackBridgeOAuthIdentityAppType({
          bootstrap: PRODUCTION_BOOTSTRAP,
          expectedAppType: "third_party_global",
          nextAppType: "third_party_global",
          dryRun: true,
        }),
        (error: unknown) => error instanceof ExternalAppControlPlaneError
          && error.code === "external_app_install_conflict",
      );
      assert.equal((await getDb().select({ appType: oauthClients.appType }).from(oauthClients)
        .where(eq(oauthClients.id, client.id)))[0]?.appType, "third_party_global");
    };

    await getDb().update(oauthClients).set({ appType: "server_local" })
      .where(eq(oauthClients.id, client.id));
    await assert.rejects(
      reconcileSlackBridgeOAuthIdentityAppType({
        bootstrap: PRODUCTION_BOOTSTRAP,
        expectedAppType: "slock_builtin",
        nextAppType: "slock_builtin",
        dryRun: true,
      }),
      (error: unknown) => error instanceof ExternalAppControlPlaneError
        && error.code === "external_app_install_conflict",
    );
    assert.equal((await getDb().select({ appType: oauthClients.appType }).from(oauthClients)
      .where(eq(oauthClients.id, client.id)))[0]?.appType, "server_local");
    await getDb().update(oauthClients).set({ appType: "third_party_global" })
      .where(eq(oauthClients.id, client.id));

    await getDb().update(externalAppServerGrants).set({ grantedManifestHash: "drifted-manifest" })
      .where(eq(externalAppServerGrants.id, grant.id));
    await assertPreflightDriftRejected();
    await getDb().update(externalAppServerGrants).set({
      grantedManifestHash: registration.capabilityManifestHash,
      grantedManifestVersion: registration.capabilityManifestVersion + 1,
    }).where(eq(externalAppServerGrants.id, grant.id));
    await assertPreflightDriftRejected();
    await getDb().update(externalAppServerGrants).set({
      grantedManifestVersion: registration.capabilityManifestVersion,
      grantedCapabilities: ["drifted-capability"],
    }).where(eq(externalAppServerGrants.id, grant.id));
    await assertPreflightDriftRejected();
    await getDb().update(externalAppServerGrants).set({
      grantedCapabilities: registration.requiredCapabilities,
      grantedByType: "agent",
    }).where(eq(externalAppServerGrants.id, grant.id));
    await assertPreflightDriftRejected();
    await getDb().update(externalAppServerGrants).set({ grantedByType: grant.grantedByType })
      .where(eq(externalAppServerGrants.id, grant.id));

    await getDb().execute(sql.raw(
      'ALTER TABLE "external_app_server_grants" DROP CONSTRAINT "external_app_server_grant_epoch_positive"',
    ));
    await getDb().update(externalAppServerGrants).set({ grantEpoch: 0 })
      .where(eq(externalAppServerGrants.id, grant.id));
    await assertPreflightDriftRejected();
    await getDb().update(externalAppServerGrants).set({ grantEpoch: grant.grantEpoch })
      .where(eq(externalAppServerGrants.id, grant.id));
    await getDb().execute(sql.raw(
      'ALTER TABLE "external_app_server_grants" ADD CONSTRAINT "external_app_server_grant_epoch_positive" CHECK ("grant_epoch" > 0)',
    ));

    const [genericInstall] = await getDb().select().from(oauthClientInstalls)
      .where(and(
        eq(oauthClientInstalls.clientId, client.id),
        eq(oauthClientInstalls.serverId, server.id),
      ));
    assert.ok(genericInstall?.installedByUserId);
    const installAgent = await createAgent(server.id, `platform-install-${randomUUID().slice(0, 8)}`);
    await getDb().update(oauthClientInstalls).set({
      installedByUserId: null,
      installedByAgentId: installAgent.id,
    }).where(eq(oauthClientInstalls.id, genericInstall.id));
    await assertPreflightDriftRejected();
    await getDb().update(oauthClientInstalls).set({
      installedByUserId: genericInstall.installedByUserId,
      installedByAgentId: null,
    }).where(eq(oauthClientInstalls.id, genericInstall.id));

    await getDb().update(oauthClients).set({ humanMarketplaceVisible: true })
      .where(eq(oauthClients.id, client.id));
    await assertPreflightDriftRejected();
    await getDb().update(oauthClients).set({ humanMarketplaceVisible: false })
      .where(eq(oauthClients.id, client.id));
    const [unexpectedRequest] = await getDb().insert(oauthAccessRequests).values({
      serverId: server.id,
      principalType: "human",
      userId: owner.id,
      clientId: client.id,
      scopes: ["openid"],
      status: "approved",
      resolvedByUserId: owner.id,
      resolvedAt: new Date(),
    }).returning();
    await assertPreflightDriftRejected();
    await getDb().delete(oauthAccessRequests).where(eq(oauthAccessRequests.id, unexpectedRequest.id));

    const stablePreflight = await reconcileSlackBridgeOAuthIdentityAppType({
      bootstrap: PRODUCTION_BOOTSTRAP,
      expectedAppType: "third_party_global",
      nextAppType: "third_party_global",
      dryRun: true,
    });
    const replay = await reconcileSlackBridgeOAuthIdentityAppType({
      bootstrap: PRODUCTION_BOOTSTRAP,
      expectedAppType: "slock_builtin",
      nextAppType: "third_party_global",
      expectedAuthoritySha256: stablePreflight.authoritySha256,
    });
    assert.equal(replay.changed, false);
    assert.equal(replay.installCount, 2);

    await getDb().update(externalAppServerGrants).set({ grantEpoch: grant.grantEpoch + 1 })
      .where(eq(externalAppServerGrants.id, grant.id));
    await assert.rejects(
      reconcileSlackBridgeOAuthIdentityAppType({
        bootstrap: PRODUCTION_BOOTSTRAP,
        expectedAppType: "third_party_global",
        nextAppType: "slock_builtin",
        expectedAuthoritySha256: stablePreflight.authoritySha256,
      }),
      (error: unknown) => error instanceof ExternalAppControlPlaneError
        && error.code === "external_app_install_conflict",
    );
    assert.equal((await getDb().select({ appType: oauthClients.appType }).from(oauthClients)
      .where(eq(oauthClients.id, client.id)))[0]?.appType, "third_party_global");
    await getDb().update(externalAppServerGrants).set({ grantEpoch: grant.grantEpoch })
      .where(eq(externalAppServerGrants.id, grant.id));
    assert.deepEqual(connectBody.oauthAuthority, {
      registrationId: registration.id,
      serverGrantId: grant.id,
      grantEpoch: grant.grantEpoch,
    });

    const oauthStart = await fetch(`${app.baseUrl}/api/slack-bridge/oauth/start`, {
      method: "POST",
      headers,
      body: JSON.stringify(connectBody.oauthAuthority),
    });
    assert.equal(oauthStart.status, 201, await oauthStart.clone().text());
    const authorizationUrl = new URL(
      (await oauthStart.json() as { authorizationUrl: string }).authorizationUrl,
    );
    const state = authorizationUrl.searchParams.get("state");
    assert.ok(state);
    const oauthCallback = await fetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(state)}&code=production-composition-code`,
      { redirect: "manual" },
    );
    assert.equal(oauthCallback.status, 302, await oauthCallback.clone().text());
    assert.equal(
      oauthCallback.headers.get("location"),
      `http://127.0.0.1:5173/s/${encodeURIComponent(server.slug)}/settings/im-bridges`,
    );
    const [install] = await getDb().select().from(externalAppInstalls)
      .where(eq(externalAppInstalls.serverId, server.id));
    assert.ok(install);
    assert.equal(install.providerAuthorityId, "T_PRODUCTION_COMPOSITION");
    assert.deepEqual(install.installedScopes, [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES]);

    const postOauth = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
    assert.equal(postOauth.status, 200, await postOauth.clone().text());
    const postOauthSnapshot = (await postOauth.json() as {
      snapshot: { stage: string; slackChannels: Array<{ id: string; name: string; privacyClass: string; isMember: boolean }> };
    }).snapshot;
    assert.equal(postOauthSnapshot.stage, "channels");
    assert.deepEqual(postOauthSnapshot.slackChannels, [
      { id: "C_PRODUCTION_GENERAL", name: "general", privacyClass: "public", isMember: true },
      { id: "C_PRODUCTION_OTHER", name: "other-public", privacyClass: "public", isMember: false },
      { id: "C_PRODUCTION_PRIVATE", name: "private", privacyClass: "private", isMember: true },
      { id: "C_PRODUCTION_PRIVATE_2", name: "private-2", privacyClass: "private", isMember: true },
    ], "production provisioning must inventory a real app-member private channel");
    assert.deepEqual(providerQueryRequests.at(-1), {
      method: "conversations.list",
      httpMethod: "GET",
      body: undefined,
      authorization: "Bearer xoxb-production-composition",
      contentType: null,
      query: "exclude_archived=true&limit=200&types=public_channel%2Cprivate_channel",
    }, "private inventory must use Slack's complete GET-query shape");
    const [raftChannel] = await getDb().select().from(channels)
      .where(eq(channels.serverId, server.id)).limit(1);
    assert.ok(raftChannel);

    const nonMemberPair = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pairs: [{ raftChannelId: raftChannel.id, slackChannelId: "C_PRODUCTION_OTHER" }],
      }),
    });
    assert.equal(nonMemberPair.status, 400, await nonMemberPair.clone().text());
    assert.deepEqual(await nonMemberPair.json(), {
      ok: false,
      code: "external_app_invalid_state",
    }, "a Slack channel outside the app audience must fail before binding persistence");
    providerOtherChannelMember = true;

    const pairs = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pairs: [{ raftChannelId: raftChannel.id, slackChannelId: "C_PRODUCTION_GENERAL" }],
      }),
    });
    assert.equal(pairs.status, 200, await pairs.clone().text());

    providerBotInConversation = false;
    const missingBotPreflight = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/preflight`, {
      method: "POST",
      headers,
    });
    assert.equal(missingBotPreflight.status, 200, await missingBotPreflight.clone().text());
    const missingBotSnapshot = (await missingBotPreflight.json() as {
      snapshot: {
        stage: string;
        preflight: { state: string; checks: Array<{ id: string; state: string }> };
        rawHealth: { failingSurface: string | null };
      };
    }).snapshot;
    assert.equal(missingBotSnapshot.stage, "preflight");
    assert.equal(missingBotSnapshot.preflight.state, "failed");
    assert.deepEqual(
      missingBotSnapshot.preflight.checks.find((check) => check.id === "audience"),
      { id: "audience", state: "failed" },
    );
    assert.equal(missingBotSnapshot.rawHealth.failingSurface, "audience");

    providerBotInConversation = true;
    const preflight = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/preflight`, {
      method: "POST",
      headers,
    });
    assert.equal(preflight.status, 200, await preflight.clone().text());
    assert.equal((await preflight.json() as { snapshot: { stage: string } }).snapshot.stage, "enable");
    assert.deepEqual(providerQueryRequests.slice(-3), [{
      method: "conversations.list",
      httpMethod: "GET",
      body: undefined,
      authorization: "Bearer xoxb-production-composition",
      contentType: null,
      query: "exclude_archived=true&limit=200&types=public_channel%2Cprivate_channel",
    }, {
      method: "conversations.members",
      httpMethod: "GET",
      body: undefined,
      authorization: "Bearer xoxb-production-composition",
      contentType: null,
      query: "channel=C_PRODUCTION_GENERAL&limit=200",
    }, {
      method: "users.info",
      httpMethod: "GET",
      body: undefined,
      authorization: "Bearer xoxb-production-composition",
      contentType: null,
      query: "user=U_PRODUCTION_OWNER",
    }]);

    const [binding] = await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.serverId, server.id));
    assert.ok(binding);
    const actorsAfterPreflight = await getDb().select().from(externalActorProjections).where(and(
      eq(externalActorProjections.provider, "slack"),
      eq(externalActorProjections.appRegistrationId, registration.id),
      eq(externalActorProjections.installId, install.id),
      eq(externalActorProjections.workspaceId, install.providerAuthorityId),
      eq(externalActorProjections.externalActorId, "U_PRODUCTION_OWNER"),
      eq(externalActorProjections.state, "active"),
      eq(externalActorProjections.deactivated, false),
    ));
    assert.equal(
      actorsAfterPreflight.length,
      1,
      "successful public preflight must create the exact external actor authority",
    );
    const addressesAfterPreflight = await getDb().select()
      .from(externalAddressabilityProjections).where(and(
        eq(externalAddressabilityProjections.projectionId, actorsAfterPreflight[0]!.id),
        eq(externalAddressabilityProjections.appRegistrationId, registration.id),
        eq(externalAddressabilityProjections.installId, install.id),
        eq(externalAddressabilityProjections.workspaceId, install.providerAuthorityId),
        eq(externalAddressabilityProjections.connectionEpoch, install.connectionEpoch),
        eq(externalAddressabilityProjections.bindingId, binding.id),
        eq(externalAddressabilityProjections.bindingEpoch, binding.bindingEpoch),
        eq(externalAddressabilityProjections.conversationId, binding.providerConversationId),
        eq(externalAddressabilityProjections.state, "active"),
        gt(externalAddressabilityProjections.expiresAt, new Date()),
      ));
    assert.equal(
      addressesAfterPreflight.length,
      1,
      "successful public preflight must create active, unexpired exact addressability",
    );
    const publicAudienceSnapshots = await getDb().select()
      .from(externalBindingAudienceSnapshots)
      .where(eq(externalBindingAudienceSnapshots.bindingId, binding.id));
    assert.equal(publicAudienceSnapshots.length, 2);
    const orderedPublicAudienceSnapshots = publicAudienceSnapshots
      .sort((left, right) => left.audienceRevision - right.audienceRevision);
    assert.equal(orderedPublicAudienceSnapshots[0]?.status, "mismatch");
    assert.equal(orderedPublicAudienceSnapshots[1]?.status, "matched");
    assert.equal(orderedPublicAudienceSnapshots[1]?.externalMemberCount, 1);
    assert.equal(orderedPublicAudienceSnapshots[1]?.raftMemberCount, 1);
    driftBindingId = binding.id;
    const driftedEnable = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST",
      headers,
    });
    assert.equal(driftedEnable.status, 200, await driftedEnable.clone().text());
    assert.equal(
      (await driftedEnable.json() as { snapshot: { stage: string } }).snapshot.stage,
      "preflight",
    );
    const [driftedBinding] = await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, binding.id));
    assert.equal(driftedBinding?.state, "paused", "provider inventory drift must not activate a binding");
    await getDb().update(externalChannelBindings).set({
      providerConversationId: "C_PRODUCTION_GENERAL",
    }).where(eq(externalChannelBindings.id, binding.id));
    const recoveredPreflight = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/preflight`, {
      method: "POST",
      headers,
    });
    assert.equal(recoveredPreflight.status, 200, await recoveredPreflight.clone().text());
    assert.equal(
      (await recoveredPreflight.json() as { snapshot: { stage: string } }).snapshot.stage,
      "enable",
    );

    await getDb().execute(sql.raw(`
      CREATE FUNCTION reject_install_grant_receipt_for_test() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'directed install grant receipt failure';
      END;
      $$ LANGUAGE plpgsql
    `));
    await getDb().execute(sql.raw(`
      CREATE TRIGGER reject_install_grant_receipt_for_test
      BEFORE INSERT ON external_app_install_grant_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_install_grant_receipt_for_test()
    `));
    const failedEnable = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST",
      headers,
    });
    assert.equal(failedEnable.status, 503);
    const [stillPaused] = await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, binding.id));
    assert.equal(stillPaused?.state, "paused");
    assert.equal(
      (await getDb().select().from(externalAppInstallGrantReceipts)
        .where(eq(externalAppInstallGrantReceipts.installId, install.id))).length,
      0,
      "receipt persistence failure must roll back activation",
    );
    await getDb().execute(sql.raw(
      "DROP TRIGGER reject_install_grant_receipt_for_test ON external_app_install_grant_receipts",
    ));
    await getDb().execute(sql.raw("DROP FUNCTION reject_install_grant_receipt_for_test()"));

    await getDb().execute(sql.raw(`
      CREATE FUNCTION reject_author_policy_for_test() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'directed author policy failure';
      END;
      $$ LANGUAGE plpgsql
    `));
    await getDb().execute(sql.raw(`
      CREATE TRIGGER reject_author_policy_for_test
      BEFORE INSERT ON external_author_policies
      FOR EACH ROW EXECUTE FUNCTION reject_author_policy_for_test()
    `));
    const failedConsentEnable = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST",
      headers,
    });
    assert.equal(failedConsentEnable.status, 503);
    const [stillPausedAfterConsentFailure] = await getDb().select()
      .from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, binding.id));
    assert.equal(stillPausedAfterConsentFailure?.state, "paused");
    assert.equal(
      (await getDb().select().from(externalAppInstallGrantReceipts)
        .where(eq(externalAppInstallGrantReceipts.installId, install.id))).length,
      0,
      "author consent persistence failure must roll back the install-grant receipt",
    );
    assert.equal(
      (await getDb().select().from(externalAuthorPolicies)).length,
      0,
      "author consent persistence failure must not leave partial policy authority",
    );
    await getDb().execute(sql.raw(
      "DROP TRIGGER reject_author_policy_for_test ON external_author_policies",
    ));
    await getDb().execute(sql.raw("DROP FUNCTION reject_author_policy_for_test()"));

    const enable = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST",
      headers,
    });
    assert.equal(enable.status, 200, await enable.clone().text());
    assert.equal((await enable.json() as { snapshot: { stage: string } }).snapshot.stage, "health");
    const receipts = await getDb().select().from(externalAppInstallGrantReceipts)
      .where(eq(externalAppInstallGrantReceipts.installId, install.id));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.providerBotId, "B_PRODUCTION_BOT");
    assert.deepEqual(receipts[0]?.grantedScopes, [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES].sort());
    assert.equal(receipts[0]?.observationSource, "token_introspection");

    let managerPolicies = await getDb().select().from(externalAuthorPolicies).where(and(
      eq(externalAuthorPolicies.serverId, server.id),
      eq(externalAuthorPolicies.appRegistrationId, registration.id),
      eq(externalAuthorPolicies.installId, install.id),
      eq(externalAuthorPolicies.bindingId, binding.id),
      eq(externalAuthorPolicies.bindingEpoch, binding.bindingEpoch),
      eq(externalAuthorPolicies.authorType, "user"),
      eq(externalAuthorPolicies.authorId, owner.id),
    ));
    assert.equal(managerPolicies.length, 1);
    assert.equal(managerPolicies[0]?.state, "granted");
    assert.equal(managerPolicies[0]?.consentRevision, binding.bindingEpoch);

    await getDb().delete(externalAuthorPolicies).where(eq(
      externalAuthorPolicies.id,
      managerPolicies[0]!.id,
    ));
    const consentlessLoad = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
    assert.equal(consentlessLoad.status, 200, await consentlessLoad.clone().text());
    assert.equal(
      (await consentlessLoad.json() as { snapshot: { stage: string } }).snapshot.stage,
      "enable",
      "a manager without exact current-epoch outbound consent must not see Connected",
    );
    const repairConsent = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST",
      headers,
    });
    assert.equal(repairConsent.status, 200, await repairConsent.clone().text());
    assert.equal(
      (await repairConsent.json() as { snapshot: { stage: string } }).snapshot.stage,
      "health",
      "explicit Enable must restore the requesting manager's exact current-epoch consent",
    );
    managerPolicies = await getDb().select().from(externalAuthorPolicies).where(and(
      eq(externalAuthorPolicies.serverId, server.id),
      eq(externalAuthorPolicies.appRegistrationId, registration.id),
      eq(externalAuthorPolicies.installId, install.id),
      eq(externalAuthorPolicies.bindingId, binding.id),
      eq(externalAuthorPolicies.bindingEpoch, binding.bindingEpoch),
      eq(externalAuthorPolicies.authorType, "user"),
      eq(externalAuthorPolicies.authorId, owner.id),
    ));
    assert.equal(managerPolicies.length, 1, "consent repair must be idempotent per binding epoch");
    assert.equal(managerPolicies[0]?.state, "granted");
    assert.equal(managerPolicies[0]?.consentRevision, binding.bindingEpoch);

    const repeatEnable = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST",
      headers,
    });
    assert.equal(repeatEnable.status, 200, await repeatEnable.clone().text());
    assert.equal(
      (await repeatEnable.json() as { snapshot: { stage: string } }).snapshot.stage,
      "health",
    );
    assert.equal(
      (await waitForInstallGrantReceipt(install.id)).length,
      1,
      "a fresh repeated enable must not mint a duplicate grant observation",
    );

    await getDb().delete(externalAddressabilityProjections).where(eq(
      externalAddressabilityProjections.id,
      addressesAfterPreflight[0]!.id,
    ));
    const addresslessLoad = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
    assert.equal(addresslessLoad.status, 200, await addresslessLoad.clone().text());
    assert.equal(
      (await addresslessLoad.json() as { snapshot: { stage: string } }).snapshot.stage,
      "enable",
      "active setup must not report health after exact addressability disappears",
    );
    const repairAddress = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST",
      headers,
    });
    assert.equal(repairAddress.status, 200, await repairAddress.clone().text());
    assert.equal(
      (await repairAddress.json() as { snapshot: { stage: string } }).snapshot.stage,
      "health",
      "explicit enable must refresh missing addressability before reporting health",
    );

    await getDb().update(externalActorProjections).set({
      state: "tombstoned",
      deactivated: true,
    }).where(eq(externalActorProjections.id, actorsAfterPreflight[0]!.id));
    const actorlessLoad = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
    assert.equal(actorlessLoad.status, 200, await actorlessLoad.clone().text());
    assert.equal(
      (await actorlessLoad.json() as { snapshot: { stage: string } }).snapshot.stage,
      "enable",
      "active setup must not report health after exact actor authority disappears",
    );
    const repairActor = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST",
      headers,
    });
    assert.equal(repairActor.status, 200, await repairActor.clone().text());
    assert.equal(
      (await repairActor.json() as { snapshot: { stage: string } }).snapshot.stage,
      "health",
      "explicit enable must refresh missing actor authority before reporting health",
    );

    const providerEventId = `Ev_PRODUCTION_${randomUUID()}`;
    const providerMessageId = `${Math.floor(Date.now() / 1_000)}.000100`;
    const eventBody = Buffer.from(JSON.stringify({
      type: "event_callback",
      api_app_id: "A_PRODUCTION_COMPOSITION",
      team_id: "T_PRODUCTION_COMPOSITION",
      event_id: providerEventId,
      event: {
        type: "message",
        channel: "C_PRODUCTION_GENERAL",
        user: "U_PRODUCTION_OWNER",
        text: "production composition inbound authority",
        ts: providerMessageId,
      },
    }));
    const requestTimestamp = String(Math.floor(Date.now() / 1_000));
    const signature = `v0=${createHmac("sha256", PRODUCTION_ENV.SLACK_BRIDGE_SIGNING_SECRET!)
      .update(`v0:${requestTimestamp}:`, "utf8")
      .update(eventBody)
      .digest("hex")}`;
    const eventHeaders = {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": requestTimestamp,
      "X-Slack-Signature": signature,
    };
    const firstInbound = await fetch(`${app.baseUrl}/api/slack-bridge/events`, {
      method: "POST",
      headers: eventHeaders,
      body: eventBody,
    });
    assert.equal(firstInbound.status, 200, await firstInbound.clone().text());
    const retryInbound = await fetch(`${app.baseUrl}/api/slack-bridge/events`, {
      method: "POST",
      headers: {
        ...eventHeaders,
        "X-Slack-Retry-Num": "1",
        "X-Slack-Retry-Reason": "http_timeout",
      },
      body: eventBody,
    });
    assert.equal(retryInbound.status, 200, await retryInbound.clone().text());
    const inboundRows = await getDb().select().from(externalInboundEvents)
      .where(eq(externalInboundEvents.providerEventId, providerEventId));
    assert.equal(
      inboundRows.length,
      1,
      "initial Slack attempt and provider retry must share one durable inbound event",
    );
    assert.ok(runtime?.inboundWorkerDependencies);
    const inboundResult = await processExternalInboundEventOnce({
      db: getDb(),
      leaseOwner: `production-composition-${randomUUID()}`,
      dependencies: runtime.inboundWorkerDependencies,
    });
    assert.equal(inboundResult.kind, "committed");
    if (inboundResult.kind !== "committed") assert.fail("expected committed inbound message");
    assert.equal(
      (await getDb().select().from(externalMessageLinks).where(and(
        eq(externalMessageLinks.firstDirection, "provider_inbound"),
        eq(externalMessageLinks.providerMessageId, providerMessageId),
      ))).length,
      1,
      "initial Slack attempt and retry must create one provider-inbound link",
    );
    assert.equal(
      (await getDb().select().from(messages).where(eq(messages.id, inboundResult.messageId))).length,
      1,
      "initial Slack attempt and retry must create one canonical message",
    );

    const tamperedGrantHash = "0".repeat(64);
    await getDb().update(externalAppInstallGrantReceipts).set({
      grantHash: tamperedGrantHash,
    }).where(eq(externalAppInstallGrantReceipts.installId, install.id));
    const repairEnable = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST",
      headers,
    });
    assert.equal(repairEnable.status, 200, await repairEnable.clone().text());
    assert.equal(
      (await repairEnable.json() as { snapshot: { stage: string } }).snapshot.stage,
      "health",
    );
    const repairedGrantReceipts = await getDb().select().from(externalAppInstallGrantReceipts)
      .where(eq(externalAppInstallGrantReceipts.installId, install.id));
    assert.equal(repairedGrantReceipts.length, 2);
    const latestRepairedGrantReceipt = repairedGrantReceipts
      .sort((left, right) => right.receiptRevision - left.receiptRevision)[0]!;
    assert.equal(latestRepairedGrantReceipt.receiptRevision, 2);
    assert.notEqual(latestRepairedGrantReceipt.grantHash, tamperedGrantHash);
    assert.equal(
      latestRepairedGrantReceipt.grantHash,
      slackBridgeInstallGrantHash(latestRepairedGrantReceipt),
      "control-plane repair must persist the fresh provider observation hash",
    );

    await getDb().delete(externalAppInstallGrantReceipts)
      .where(eq(externalAppInstallGrantReceipts.installId, install.id));
    const providerProbe = createSlackBridgeProviderRuntime({
      credentialCipher: createSlackBridgeEnvCredentialCipher({
        key: Buffer.from(CREDENTIAL_KEY, "base64"),
      }),
      db: getDb(),
      fetch: providerFetch,
    });
    assert.ok(install.botUserId);
    try {
      const conversationAuthority = {
        installId: install.id,
        providerAppId: install.providerAppId,
        providerAuthorityId: install.providerAuthorityId,
        providerConversationId: binding.providerConversationId,
        connectionEpoch: install.connectionEpoch,
        credentialRevision: install.credentialRevision,
        bindingId: binding.id,
        bindingEpoch: binding.bindingEpoch,
      };
      const attachmentAdapter = createSlackInboundAttachmentAdapter(
        providerProbe.inboundAttachmentTransport,
      );
      const attachmentAuthority = {
        provider: "slack",
        appRegistrationId: registration.id,
        installId: install.id,
        workspaceId: install.providerAuthorityId,
        providerAuthorityId: install.providerAuthorityId,
        providerConversationId: binding.providerConversationId,
        connectionEpoch: install.connectionEpoch,
        bindingId: binding.id,
        bindingEpoch: binding.bindingEpoch,
      };
      const holdCredentialLease = () => getDb().update(externalAppCredentials).set({
        leaseOwner: "competing-attachment-worker",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }).where(and(
        eq(externalAppCredentials.installId, install.id),
        eq(externalAppCredentials.credentialRevision, install.credentialRevision),
      ));
      const releaseCredentialLease = () => getDb().update(externalAppCredentials).set({
        leaseOwner: null,
        leaseExpiresAt: null,
      }).where(and(
        eq(externalAppCredentials.installId, install.id),
        eq(externalAppCredentials.credentialRevision, install.credentialRevision),
      ));
      const withCredentialLeaseHeld = async (work: () => Promise<void>) => {
        await holdCredentialLease();
        try {
          await work();
        } finally {
          await releaseCredentialLease();
        }
      };
      const assertCredentialBusy = (error: unknown) => {
        const failure = attachmentAdapter.classifyFailure(error);
        return failure.class === "transient"
          && failure.reason === "provider_attachment_credential_busy"
          && failure.scope === "occurrence_local";
      };
      const assertAuthorityUnavailable = (error: unknown) => {
        const failure = attachmentAdapter.classifyFailure(error);
        return failure.class === "authority_revoked"
          && failure.reason === "provider_attachment_authority_unavailable"
          && failure.scope === "occurrence_local";
      };
      await withCredentialLeaseHeld(async () => {
        await assert.rejects(
          attachmentAdapter.inspectInboundAsset({
            authority: attachmentAuthority,
            providerFileId: "F_BUSY_INSPECT",
            signal: new AbortController().signal,
          }),
          assertCredentialBusy,
          "a competing Server replica lease must retry instead of revoking the attachment",
        );
      });
      await getDb().update(externalAppCredentials).set({
        expiresAt: new Date(Date.now() - 1),
      }).where(and(
        eq(externalAppCredentials.installId, install.id),
        eq(externalAppCredentials.credentialRevision, install.credentialRevision),
      ));
      try {
        await assert.rejects(
          attachmentAdapter.inspectInboundAsset({
            authority: attachmentAuthority,
            providerFileId: "F_EXPIRED_INSPECT",
            signal: new AbortController().signal,
          }),
          assertAuthorityUnavailable,
          "a truly expired credential must still fail closed",
        );
      } finally {
        await getDb().update(externalAppCredentials).set({
          expiresAt: null,
        }).where(and(
          eq(externalAppCredentials.installId, install.id),
          eq(externalAppCredentials.credentialRevision, install.credentialRevision),
        ));
      }
      const inspectedFile = await attachmentAdapter.inspectInboundAsset({
        authority: attachmentAuthority,
        providerFileId: "F_PRODUCTION",
        signal: new AbortController().signal,
      });
      await withCredentialLeaseHeld(async () => {
        await assert.rejects(async () => {
          for await (const _chunk of attachmentAdapter.downloadInboundAsset({
            authority: attachmentAuthority,
            handle: inspectedFile.downloadHandle,
            maximumBytes: 100,
            signal: new AbortController().signal,
          })) {
            // Drain the stream so generator failures surface inside rejects.
          }
        }, assertCredentialBusy, "download lease contention must remain retryable");
      });
      const downloadedChunks: Uint8Array[] = [];
      for await (const chunk of attachmentAdapter.downloadInboundAsset({
        authority: attachmentAuthority,
        handle: inspectedFile.downloadHandle,
        maximumBytes: 100,
        signal: new AbortController().signal,
      })) downloadedChunks.push(chunk);
      assert.equal(Buffer.concat(downloadedChunks).toString("utf8"), "abcdef");
      assert.deepEqual(providerQueryRequests.at(-1), {
        method: "files.info",
        httpMethod: "GET",
        body: undefined,
        authorization: "Bearer xoxb-production-composition",
        contentType: null,
        query: "file=F_PRODUCTION",
      });
      assert.deepEqual(providerFileDownloads.at(-1), {
        authorization: "Bearer xoxb-production-composition",
        redirect: "error",
      });
      const outboundCredential = await providerProbe.credentialResolver.resolve({
        authority: conversationAuthority,
        now: new Date(),
      });
      assert.ok(outboundCredential);
      try {
        const outboundTransport = await providerProbe.createOutboundAttachmentTransport(
          outboundCredential,
          conversationAuthority,
        );
        assert.ok(outboundTransport);
        const outboundAdapter = createSlackOutboundAttachmentAdapter(outboundTransport);
        const outboundBytes = Buffer.from("outbound-provider-file", "utf8");
        const outboundDigest = createHash("sha256").update(outboundBytes).digest("hex");
        const ticket = await outboundAdapter.createOutboundUpload({
          authority: attachmentAuthority,
          asset: {
            sourceAttachmentId: randomUUID(),
            filename: "outbound.txt",
            byteSize: outboundBytes.length,
            mimeType: "text/plain",
            contentDigest: outboundDigest,
          },
          signal: new AbortController().signal,
        });
        async function* uploadBytes() { yield outboundBytes; }
        assert.deepEqual(await outboundAdapter.uploadOutboundAsset({
          authority: attachmentAuthority,
          handle: ticket.uploadHandle,
          bytes: uploadBytes(),
          expectedByteSize: outboundBytes.length,
          expectedContentDigest: outboundDigest,
          signal: new AbortController().signal,
        }), { uploadedByteSize: outboundBytes.length, uploadedContentDigest: outboundDigest });
        const completion = {
          providerConversationId: binding.providerConversationId,
          providerRootThreadId: null,
          providerFileIds: [ticket.providerFileId],
          renderedText: "outbound attachment",
          reconciliationMarker: "m".repeat(43),
          author: {
            displayName: "Production Owner",
            avatarPublicUrl: null,
            fallbackKind: "human" as const,
          },
        };
        assert.deepEqual(await outboundAdapter.completeOutboundMessage({
          authority: attachmentAuthority,
          completion,
          signal: new AbortController().signal,
        }), { kind: "accepted_pending_correlation" });
        assert.deepEqual(await outboundAdapter.correlateOutboundMessage({
          authority: attachmentAuthority,
          correlation: completion,
          signal: new AbortController().signal,
        }), { kind: "matched", providerMessageId: "1788541200.000300" });
        assert.deepEqual(providerFileUploads, [outboundBytes]);
        assert.equal(providerCompletionCalls, 1);
        assert.deepEqual(providerCompletionBodies, [{
          files: [{ id: ticket.providerFileId }],
          channel_id: binding.providerConversationId,
          initial_comment: "outbound attachment",
        }]);
      } finally {
        await providerProbe.releaseCredential(outboundCredential);
      }
      const conversationCredential = await providerProbe.credentialResolver.resolve({
        authority: conversationAuthority,
        now: new Date(),
      });
      assert.ok(conversationCredential);
      try {
        const conversation = await lookupSlackProviderConversation({
          transport: providerProbe.transport,
          quarantineSink: providerProbe.quarantineSink,
          credentialHandle: conversationCredential,
          authority: conversationAuthority,
          providerConversationId: binding.providerConversationId,
          now: new Date(),
        });
        assert.equal(conversation.kind, "fact", "conversation lookup must return the requested fact");
        assert.deepEqual(providerQueryRequests.at(-1), {
          method: "conversations.info",
          httpMethod: "GET",
          body: undefined,
          authorization: "Bearer xoxb-production-composition",
          contentType: null,
          query: "channel=C_PRODUCTION_GENERAL",
        }, "conversation lookup must use Slack's GET-query shape");
      } finally {
        await providerProbe.releaseCredential(conversationCredential);
      }

      const callsBeforeWrongApp = providerAuthTestCalls;
      assert.deepEqual(await providerProbe.provisioningProvider.readInstallGrant({
        installId: install.id,
        providerAppId: "A_OTHER_WITH_SAME_TEAM_AND_BOT",
        providerAuthorityId: install.providerAuthorityId,
        botUserId: install.botUserId,
        connectionEpoch: install.connectionEpoch,
        credentialRevision: install.credentialRevision,
        now: new Date(),
      }), { kind: "unverified" });
      assert.equal(
        providerAuthTestCalls,
        callsBeforeWrongApp,
        "wrong durable app authority must fail before token release or provider I/O",
      );
      for (const mode of ["wrong-team", "wrong-user", "missing-bot"] as const) {
        grantIdentityMode = mode;
        assert.deepEqual(await providerProbe.provisioningProvider.readInstallGrant({
          installId: install.id,
          providerAppId: install.providerAppId,
          providerAuthorityId: install.providerAuthorityId,
          botUserId: install.botUserId,
          connectionEpoch: install.connectionEpoch,
          credentialRevision: install.credentialRevision,
          now: new Date(),
        }), { kind: "failed" }, `${mode} auth.test identity must fail closed`);
      }
      grantIdentityMode = "valid";
      for (const mode of ["missing", "empty"] as const) {
        grantHeaderMode = mode;
        assert.deepEqual(await providerProbe.provisioningProvider.readInstallGrant({
          installId: install.id,
          providerAppId: install.providerAppId,
          providerAuthorityId: install.providerAuthorityId,
          botUserId: install.botUserId,
          connectionEpoch: install.connectionEpoch,
          credentialRevision: install.credentialRevision,
          now: new Date(),
        }), { kind: "failed" }, `${mode} x-oauth-scopes must fail closed at the provider boundary`);
        const rejectedEnable = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
          method: "POST",
          headers,
        });
        assert.equal(rejectedEnable.status, 200, await rejectedEnable.clone().text());
        assert.equal(
          (await rejectedEnable.json() as { snapshot: { stage: string } }).snapshot.stage,
          "enable",
          `${mode} x-oauth-scopes must not fall back to OAuth cache`,
        );
        assert.equal(
          (await getDb().select().from(externalAppInstallGrantReceipts)
            .where(eq(externalAppInstallGrantReceipts.installId, install.id))).length,
          0,
          `${mode} x-oauth-scopes must not persist a grant receipt`,
        );
      }
    } finally {
      grantHeaderMode = "present";
      await providerProbe.stop();
    }
    const [latestAudienceBeforeLifecycle] = await getDb().select({
      audienceRevision: externalBindingAudienceSnapshots.audienceRevision,
    }).from(externalBindingAudienceSnapshots)
      .where(eq(externalBindingAudienceSnapshots.bindingId, binding.id))
      .orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1);
    assert.ok(latestAudienceBeforeLifecycle);
    await getDb().delete(externalAddressabilityProjections)
      .where(eq(externalAddressabilityProjections.bindingId, binding.id));
    await getDb().update(externalActorProjections).set({
      state: "tombstoned",
      deactivated: true,
    }).where(eq(externalActorProjections.id, actorsAfterPreflight[0]!.id));
    runtime?.start();
    const reconcile = await runtime?.requestLifecycleReconcile?.();
    assert.equal(
      (await waitForInstallGrantReceipt(install.id)).length,
      1,
      `the production lifecycle must repair active receiptless installs from a fresh provider observation: ${JSON.stringify(reconcile)}`,
    );
    const lifecycleActors = await getDb().select().from(externalActorProjections).where(and(
      eq(externalActorProjections.id, actorsAfterPreflight[0]!.id),
      eq(externalActorProjections.state, "active"),
      eq(externalActorProjections.deactivated, false),
    ));
    assert.equal(lifecycleActors.length, 1, "public lifecycle refresh must restore actor authority");
    const lifecycleAddresses = await getDb().select().from(externalAddressabilityProjections)
      .where(and(
        eq(externalAddressabilityProjections.projectionId, actorsAfterPreflight[0]!.id),
        eq(externalAddressabilityProjections.bindingId, binding.id),
        eq(externalAddressabilityProjections.state, "active"),
        gt(externalAddressabilityProjections.expiresAt, new Date()),
      ));
    assert.equal(
      lifecycleAddresses.length,
      1,
      "public lifecycle refresh must restore active, unexpired exact addressability",
    );
    const [latestAudienceAfterLifecycle] = await getDb().select({
      audienceRevision: externalBindingAudienceSnapshots.audienceRevision,
      status: externalBindingAudienceSnapshots.status,
    }).from(externalBindingAudienceSnapshots)
      .where(eq(externalBindingAudienceSnapshots.bindingId, binding.id))
      .orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1);
    assert.ok(latestAudienceAfterLifecycle);
    assert.equal(latestAudienceAfterLifecycle.status, "matched");
    assert.ok(
      latestAudienceAfterLifecycle.audienceRevision
        > latestAudienceBeforeLifecycle.audienceRevision,
      "public lifecycle refresh must append a newer authority snapshot",
    );
    const [avatarActor] = await getDb().select().from(externalActorProjections)
      .where(eq(externalActorProjections.externalActorId, "U_PRODUCTION_OWNER"));
    assert.ok(avatarActor?.avatarArtifactId);
    const [avatarArtifact] = await getDb().select().from(externalProjectionAvatarArtifacts)
      .where(eq(externalProjectionAvatarArtifacts.id, avatarActor.avatarArtifactId!));
    assert.equal(avatarArtifact.state, "active");
    assert.equal(avatarArtifact.mimeType, "image/webp");
    assert.equal(avatarArtifact.publicUrl.includes("avatars.slack-edge.com"), false);
    assert.ok(providerAvatarFetchCalls >= 1);

    const readPublicAuthorityRows = async () => ({
      actors: await getDb().select().from(externalActorProjections)
        .where(eq(externalActorProjections.installId, install.id))
        .orderBy(externalActorProjections.id),
      addresses: await getDb().select().from(externalAddressabilityProjections)
        .where(eq(externalAddressabilityProjections.bindingId, binding.id))
        .orderBy(externalAddressabilityProjections.id),
      snapshots: await getDb().select().from(externalBindingAudienceSnapshots)
        .where(eq(externalBindingAudienceSnapshots.bindingId, binding.id))
        .orderBy(externalBindingAudienceSnapshots.audienceRevision),
    });
    const assertLifecycleAuthorityRejected = async (label: string) => {
      const beforeRows = await readPublicAuthorityRows();
      const callsBefore = providerAudienceCalls;
      const observedAt = new Date();
      assert.deepEqual(
        await refreshSlackPublicConversationAuthority({
          db: getDb(),
          provider: providerProbe.provisioningProvider,
          bindingId: binding.id,
          now: observedAt,
        }),
        {
          bindingId: binding.id,
          audienceStatus: "unavailable",
          observedAtMs: observedAt.getTime(),
          reason: "authority_quarantined",
        },
        `${label} must return typed quarantined authority`,
      );
      assert.equal(
        typeof runtime?.requestLifecycleReconcile,
        "function",
        `${label} lifecycle reconcile must be wired`,
      );
      await runtime?.requestLifecycleReconcile?.();
      assert.equal(
        providerAudienceCalls,
        callsBefore,
        `${label} must make zero provider audience calls`,
      );
      assert.deepEqual(
        await readPublicAuthorityRows(),
        beforeRows,
        `${label} must append or update zero actor/address/snapshot authority`,
      );
    };

    await runNamedCase("public lifecycle cannot extend authority after the Server grant is revoked", async () => {
      await getDb().update(externalAppServerGrants).set({
        state: "revoked",
        revokedAt: new Date(),
        revokeReason: "production-composition-revoke-tooth",
      }).where(eq(externalAppServerGrants.id, grant.id));
      try {
        await assertLifecycleAuthorityRejected("revoked Server grant");
      } finally {
        await getDb().update(externalAppServerGrants).set({
          state: "active",
          revokedAt: null,
          revokeReason: null,
        }).where(eq(externalAppServerGrants.id, grant.id));
      }
    });

    await runNamedCase("public lifecycle cannot extend authority after the Server grant epoch advances", async () => {
      await getDb().update(externalAppServerGrants).set({
        grantEpoch: grant.grantEpoch + 1,
      }).where(eq(externalAppServerGrants.id, grant.id));
      try {
        await assertLifecycleAuthorityRejected("drifted Server grant epoch");
      } finally {
        await getDb().update(externalAppServerGrants).set({
          grantEpoch: grant.grantEpoch,
        }).where(eq(externalAppServerGrants.id, grant.id));
      }
    });

    const registrationDrifts = [
      {
        label: "manifest version",
        drift: { capabilityManifestVersion: registration.capabilityManifestVersion + 1 },
        restore: { capabilityManifestVersion: registration.capabilityManifestVersion },
      },
      {
        label: "manifest hash",
        drift: { capabilityManifestHash: `drifted-${registration.capabilityManifestHash}` },
        restore: { capabilityManifestHash: registration.capabilityManifestHash },
      },
      {
        label: "required capabilities",
        drift: {
          requiredCapabilities: [
            ...registration.requiredCapabilities,
            "slack.registration.drift.test",
          ],
        },
        restore: { requiredCapabilities: registration.requiredCapabilities },
      },
    ];
    await runNamedCase("public lifecycle cannot extend authority after current registration drift", async () => {
      for (const { label, drift, restore } of registrationDrifts) {
        await runNamedCase(label, async () => {
          await getDb().update(externalAppRegistrations).set(drift)
            .where(eq(externalAppRegistrations.id, registration.id));
          try {
            await assertLifecycleAuthorityRejected(`drifted registration ${label}`);
          } finally {
            await getDb().update(externalAppRegistrations).set(restore)
              .where(eq(externalAppRegistrations.id, registration.id));
          }
        });
      }
    });

    const repaired = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
    assert.equal(repaired.status, 200, await repaired.clone().text());
    assert.equal((await repaired.json() as { snapshot: { stage: string } }).snapshot.stage, "health");

    const createPrivate = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: `additive-private-${randomUUID().slice(0, 8)}`,
        description: "additive Slack Bridge binding acceptance",
        visibility: "private",
      }),
    });
    assert.equal(createPrivate.status, 200, await createPrivate.clone().text());
    const privateRaftChannel = await createPrivate.json() as { id: string; type: string };
    assert.equal(privateRaftChannel.type, "private");

    const publicBindingBeforeAdd = (await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, binding.id)))[0]!;
    const additivePairs = [{
      raftChannelId: raftChannel.id,
      slackChannelId: "C_PRODUCTION_GENERAL",
    }, {
      raftChannelId: privateRaftChannel.id,
      slackChannelId: "C_PRODUCTION_PRIVATE",
    }];
    const additive = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ pairs: additivePairs }),
    });
    assert.equal(
      additive.status,
      200,
      `an exact active pair must remain immutable while a new pair is added: ${await additive.clone().text()}`,
    );
    const bindingsAfterAdd = await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.serverId, server.id));
    const publicBindingAfterAdd = bindingsAfterAdd.find((row) => row.id === binding.id)!;
    assert.deepEqual(
      {
        id: publicBindingAfterAdd.id,
        state: publicBindingAfterAdd.state,
        bindingEpoch: publicBindingAfterAdd.bindingEpoch,
        channelId: publicBindingAfterAdd.channelId,
        providerConversationId: publicBindingAfterAdd.providerConversationId,
      },
      {
        id: publicBindingBeforeAdd.id,
        state: "active",
        bindingEpoch: publicBindingBeforeAdd.bindingEpoch,
        channelId: publicBindingBeforeAdd.channelId,
        providerConversationId: publicBindingBeforeAdd.providerConversationId,
      },
      "additive setup must preserve the exact active binding and epoch",
    );
    const privateBinding = bindingsAfterAdd.find((row) =>
      row.channelId === privateRaftChannel.id
      && row.providerConversationId === "C_PRODUCTION_PRIVATE");
    assert.ok(privateBinding);
    assert.equal(privateBinding.state, "paused");
    const additiveBody = await additive.json() as {
      snapshot: { rawHealth: { bindings: Array<{ id: string; bindingEpoch: number }> } };
    };
    assert.deepEqual(
      additiveBody.snapshot.rawHealth.bindings
        .map((row) => ({ id: row.id, bindingEpoch: row.bindingEpoch }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      [publicBindingAfterAdd, privateBinding]
        .map((row) => ({ id: row.id, bindingEpoch: row.bindingEpoch }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      "official provisioning readback must expose the exact epochs required by teardown CAS",
    );

    const additivePreflight = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/preflight`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(additivePreflight.status, 200, await additivePreflight.clone().text());
    const bindingsAfterAdditivePreflight = await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.serverId, server.id));
    const publicBeforeAdditiveEnable = bindingsAfterAdditivePreflight.find((row) =>
      row.id === publicBindingAfterAdd.id)!;
    const privateBeforeAdditiveEnable = bindingsAfterAdditivePreflight.find((row) =>
      row.id === privateBinding.id)!;
    assert.equal(privateBeforeAdditiveEnable.state, "paused");
    assert.equal(privateBeforeAdditiveEnable.stateReason, "provisioning_preflight_passed");

    const additiveEnable = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(
      additiveEnable.status,
      200,
      `mixed active + paused bindings must enable atomically: ${await additiveEnable.clone().text()}`,
    );
    const additiveEnableBody = await additiveEnable.json() as {
      snapshot: {
        stage: string;
        rawHealth: { bindings: Array<{ id: string; state: string; bindingEpoch: number }> };
      };
    };
    assert.equal(additiveEnableBody.snapshot.stage, "health");
    assert.deepEqual(
      additiveEnableBody.snapshot.rawHealth.bindings
        .map((row) => ({ id: row.id, state: row.state, bindingEpoch: row.bindingEpoch }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      [publicBeforeAdditiveEnable, privateBeforeAdditiveEnable]
        .map((row) => ({ id: row.id, state: "active", bindingEpoch: row.bindingEpoch }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      "official enable readback must project both preserved and newly activated bindings as active",
    );
    const bindingsAfterAdditiveEnable = await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.serverId, server.id));
    const publicAfterAdditiveEnable = bindingsAfterAdditiveEnable.find((row) =>
      row.id === publicBindingAfterAdd.id)!;
    const privateAfterAdditiveEnable = bindingsAfterAdditiveEnable.find((row) =>
      row.id === privateBinding.id)!;
    assert.deepEqual(
      publicAfterAdditiveEnable,
      publicBeforeAdditiveEnable,
      "enabling an additive paused pair must leave the existing active binding byte-equivalent",
    );
    assert.equal(privateAfterAdditiveEnable.state, "active");
    assert.equal(privateAfterAdditiveEnable.stateReason, null);
    assert.equal(privateAfterAdditiveEnable.bindingEpoch, privateBeforeAdditiveEnable.bindingEpoch);

    const visibleChannels = await fetch(`${app.baseUrl}/api/channels`, { headers });
    assert.equal(visibleChannels.status, 200, await visibleChannels.clone().text());
    const visibleChannelBody = await visibleChannels.json() as Array<{
      id: string;
      bridge?: {
        provider: string;
        providerConversationId: string;
        state: string;
      };
    }>;
    assert.deepEqual(
      visibleChannelBody.find((channel) => channel.id === raftChannel.id)?.bridge,
      {
        provider: "slack",
        providerConversationId: "C_PRODUCTION_GENERAL",
        state: "active",
      },
      "ordinary channel list readers must see that the Raft channel is Slack-linked",
    );
    assert.deepEqual(
      visibleChannelBody.find((channel) => channel.id === privateRaftChannel.id)?.bridge,
      {
        provider: "slack",
        providerConversationId: "C_PRODUCTION_PRIVATE",
        state: "active",
      },
      "private channel members must receive the same bridge identity projection",
    );

    const visiblePrivateMembers = await fetch(
      `${app.baseUrl}/api/channels/${privateRaftChannel.id}/members`,
      { headers },
    );
    assert.equal(visiblePrivateMembers.status, 200, await visiblePrivateMembers.clone().text());
    const visiblePrivateMemberBody = await visiblePrivateMembers.json() as {
      agents: unknown[];
      humans: unknown[];
      externalMembers: Array<{
        id: string;
        provider: string;
        displayName: string;
        handles: string[];
        actorKind: string;
        avatarUrl: string | null;
      }>;
    };
    assert.ok(visiblePrivateMemberBody.externalMembers.length > 0);
    assert.ok(visiblePrivateMemberBody.externalMembers.every((member) =>
      member.provider === "slack"
      && member.id.length > 0
      && member.displayName.length > 0
      && !Object.hasOwn(member, "externalActorId")
    ), "external Slack projections stay separate from Raft human/agent principals and hide provider actor IDs");

    const retirePrivateBeforeRepair = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          pairs: [{
            raftChannelId: privateRaftChannel.id,
            slackChannelId: "C_PRODUCTION_PRIVATE",
            expectedBindingEpoch: privateAfterAdditiveEnable.bindingEpoch,
          }],
        }),
      },
    );
    assert.equal(
      retirePrivateBeforeRepair.status,
      200,
      await retirePrivateBeforeRepair.clone().text(),
    );
    const retiredPrivate = (await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, privateBinding.id)))[0]!;
    assert.equal(retiredPrivate.state, "revoked");
    assert.equal(retiredPrivate.stateReason, "provisioning_pair_removed");

    const repairWithRetiredSibling = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/enable`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(
      repairWithRetiredSibling.status,
      200,
      `a retired sibling must not poison the current binding CAS: ${await repairWithRetiredSibling.clone().text()}`,
    );
    assert.equal(
      (await repairWithRetiredSibling.json() as { snapshot: { stage: string } }).snapshot.stage,
      "health",
      "the remaining active exact must repair to health while the retired sibling stays excluded",
    );
    assert.deepEqual(
      (await getDb().select().from(externalChannelBindings)
        .where(eq(externalChannelBindings.id, privateBinding.id)))[0],
      retiredPrivate,
      "explicit enable must leave the retired sibling byte-equivalent",
    );

    const restorePrivateAfterRepair = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`,
      { method: "PUT", headers, body: JSON.stringify({ pairs: additivePairs }) },
    );
    assert.equal(
      restorePrivateAfterRepair.status,
      200,
      await restorePrivateAfterRepair.clone().text(),
    );
    const restorePrivatePreflight = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/preflight`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(
      restorePrivatePreflight.status,
      200,
      await restorePrivatePreflight.clone().text(),
    );
    const restorePrivateEnable = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/enable`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(restorePrivateEnable.status, 200, await restorePrivateEnable.clone().text());
    assert.equal(
      (await restorePrivateEnable.json() as { snapshot: { stage: string } }).snapshot.stage,
      "health",
    );

    await getDb().update(externalChannelBindings).set({
      state: "quarantined",
      stateReason: "test_quarantined_binding",
    }).where(eq(externalChannelBindings.id, privateBinding.id));
    const quarantinedBeforeAdd = (await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, privateBinding.id)))[0]!;

    const createSecondPrivate = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: `additive-private-second-${randomUUID().slice(0, 8)}`,
        description: "second additive Slack Bridge binding acceptance",
        visibility: "private",
      }),
    });
    assert.equal(createSecondPrivate.status, 200, await createSecondPrivate.clone().text());
    const secondPrivateRaftChannel = await createSecondPrivate.json() as { id: string; type: string };
    assert.equal(secondPrivateRaftChannel.type, "private");

    const additiveWithQuarantined = [...additivePairs, {
      raftChannelId: secondPrivateRaftChannel.id,
      slackChannelId: "C_PRODUCTION_PRIVATE_2",
    }];
    const addBesideQuarantined = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ pairs: additiveWithQuarantined }),
      },
    );
    assert.equal(
      addBesideQuarantined.status,
      200,
      `an exact quarantined pair must remain immutable while a new pair is added: ${await addBesideQuarantined.clone().text()}`,
    );
    const bindingsAfterQuarantinedAdd = await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.serverId, server.id));
    const quarantinedAfterAdd = bindingsAfterQuarantinedAdd.find((row) =>
      row.id === quarantinedBeforeAdd.id)!;
    assert.deepEqual(
      {
        id: quarantinedAfterAdd.id,
        state: quarantinedAfterAdd.state,
        stateReason: quarantinedAfterAdd.stateReason,
        bindingEpoch: quarantinedAfterAdd.bindingEpoch,
        channelId: quarantinedAfterAdd.channelId,
        providerConversationId: quarantinedAfterAdd.providerConversationId,
      },
      {
        id: quarantinedBeforeAdd.id,
        state: "quarantined",
        stateReason: quarantinedBeforeAdd.stateReason,
        bindingEpoch: quarantinedBeforeAdd.bindingEpoch,
        channelId: quarantinedBeforeAdd.channelId,
        providerConversationId: quarantinedBeforeAdd.providerConversationId,
      },
      "additive setup must preserve the exact quarantined binding and epoch",
    );
    const secondPrivateBinding = bindingsAfterQuarantinedAdd.find((row) =>
      row.channelId === secondPrivateRaftChannel.id
      && row.providerConversationId === "C_PRODUCTION_PRIVATE_2");
    assert.ok(secondPrivateBinding);
    assert.equal(secondPrivateBinding.state, "paused");

    const createOtherPublic = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: `additive-public-other-${randomUUID().slice(0, 8)}`,
        description: "coordinate reuse Slack Bridge binding acceptance",
        visibility: "public",
      }),
    });
    assert.equal(createOtherPublic.status, 200, await createOtherPublic.clone().text());
    const otherPublicRaftChannel = await createOtherPublic.json() as { id: string; type: string };
    assert.equal(otherPublicRaftChannel.type, "channel");

    const bindingsBeforeRejectedReplacements = await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.serverId, server.id));
    const provisioning = runtime.provisioning;
    assert.ok(provisioning);
    const omittedActive = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ pairs: additiveWithQuarantined.slice(1) }),
    });
    assert.equal(omittedActive.status, 409, await omittedActive.clone().text());
    assert.equal(
      (await omittedActive.json() as { code: string }).code,
      "external_app_install_conflict",
    );
    assert.deepEqual(
      await getDb().select().from(externalChannelBindings)
        .where(eq(externalChannelBindings.serverId, server.id)),
      bindingsBeforeRejectedReplacements,
      "omitting an active exact must leave every binding byte-equivalent",
    );
    const replacementCases = [{
      label: "same Raft channel cannot be reused for a different Slack channel",
      pair: {
        raftChannelId: raftChannel.id,
        slackChannelId: "C_PRODUCTION_OTHER",
      },
    }, {
      label: "same Slack channel cannot be reused for a different Raft channel",
      pair: {
        raftChannelId: otherPublicRaftChannel.id,
        slackChannelId: "C_PRODUCTION_GENERAL",
      },
    }];
    for (const { label, pair } of replacementCases) {
      await runNamedCase(label, async () => {
        const requestedPairs = [...additiveWithQuarantined, pair];
        const rejected = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ pairs: requestedPairs }),
        });
        assert.equal(rejected.status, 400, `${label}: ${await rejected.clone().text()}`);
        assert.equal(
          (await rejected.json() as { code: string }).code,
          "slack_bridge_channel_pairs_invalid",
          `${label} must fail closed at the one-to-one product schema`,
        );
        await assert.rejects(
          provisioning.saveChannelPairs({
            serverId: server.id,
            requestingUserId: owner.id,
            now: new Date(),
            pairs: requestedPairs,
          }),
          (error: unknown) => error instanceof ExternalAppControlPlaneError
            && error.code === "external_app_install_conflict",
          `${label} must also fail closed at the transactional control plane boundary`,
        );
        assert.deepEqual(
          await getDb().select().from(externalChannelBindings)
            .where(eq(externalChannelBindings.serverId, server.id)),
          bindingsBeforeRejectedReplacements,
          `${label} must leave every binding byte-equivalent`,
        );
      });
    }

    const teardownPair = additiveWithQuarantined[2]!;
    const bindingsBeforeAtomicReject = await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.serverId, server.id));
    const staleAtomicRemoval = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          pairs: [{
            ...additivePairs[0],
            expectedBindingEpoch: publicBindingAfterAdd.bindingEpoch,
          }, {
            ...teardownPair,
            expectedBindingEpoch: secondPrivateBinding.bindingEpoch + 1,
          }],
        }),
      },
    );
    assert.equal(staleAtomicRemoval.status, 409, await staleAtomicRemoval.clone().text());
    assert.deepEqual(
      await getDb().select().from(externalChannelBindings)
        .where(eq(externalChannelBindings.serverId, server.id)),
      bindingsBeforeAtomicReject,
      "one stale epoch must reject the entire multi-pair removal",
    );

    const wrongCoordinateRemoval = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          pairs: [{
            raftChannelId: teardownPair.raftChannelId,
            slackChannelId: "C_PRODUCTION_GENERAL",
            expectedBindingEpoch: secondPrivateBinding.bindingEpoch,
          }],
        }),
      },
    );
    assert.equal(wrongCoordinateRemoval.status, 409, await wrongCoordinateRemoval.clone().text());
    assert.deepEqual(
      await getDb().select().from(externalChannelBindings)
        .where(eq(externalChannelBindings.serverId, server.id)),
      bindingsBeforeAtomicReject,
      "reused coordinates must not mutate any binding",
    );

    const providerCallsBeforePausedRemoval = providerQueryRequests.length;
    const pausedRemoval = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({
        pairs: [{ ...teardownPair, expectedBindingEpoch: secondPrivateBinding.bindingEpoch }],
      }),
    });
    assert.equal(pausedRemoval.status, 200, await pausedRemoval.clone().text());
    assert.equal(
      providerQueryRequests.length,
      providerCallsBeforePausedRemoval,
      "teardown must perform zero provider I/O",
    );
    assert.equal(
      (await pausedRemoval.json() as { snapshot: { channelPairs: unknown[] } }).snapshot.channelPairs
        .some((pair) => (pair as { slackChannelId?: string }).slackChannelId === teardownPair.slackChannelId),
      false,
      "removed pair must be absent from the official readback",
    );
    const privateRevoked = (await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, secondPrivateBinding.id)))[0]!;
    assert.equal(privateRevoked.state, "revoked");
    assert.equal(privateRevoked.stateReason, "provisioning_pair_removed");
    assert.equal(privateRevoked.bindingEpoch, secondPrivateBinding.bindingEpoch + 1);

    const repeatedRemoval = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({
        pairs: [{ ...teardownPair, expectedBindingEpoch: secondPrivateBinding.bindingEpoch }],
      }),
    });
    assert.equal(repeatedRemoval.status, 409, await repeatedRemoval.clone().text());
    assert.deepEqual(
      (await getDb().select().from(externalChannelBindings)
        .where(eq(externalChannelBindings.id, secondPrivateBinding.id)))[0],
      privateRevoked,
      "stale retry must leave the revoked row byte-equivalent",
    );

    const readdPrivate = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ pairs: additiveWithQuarantined }),
    });
    assert.equal(readdPrivate.status, 200, await readdPrivate.clone().text());
    const privateReadded = (await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, secondPrivateBinding.id)))[0]!;
    assert.equal(privateReadded.id, secondPrivateBinding.id);
    assert.equal(privateReadded.state, "paused");
    assert.equal(privateReadded.stateReason, "provisioning_preflight_pending");
    assert.equal(privateReadded.bindingEpoch, privateRevoked.bindingEpoch + 1);

    await getDb().update(externalChannelBindings).set({
      state: "quarantined",
      stateReason: "test_quarantined_before_remove",
    }).where(eq(externalChannelBindings.id, privateReadded.id));
    const providerCallsBeforeQuarantinedRemoval = providerQueryRequests.length;
    const quarantinedRemoval = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          pairs: [{ ...teardownPair, expectedBindingEpoch: privateReadded.bindingEpoch }],
        }),
      },
    );
    assert.equal(quarantinedRemoval.status, 200, await quarantinedRemoval.clone().text());
    assert.equal(providerQueryRequests.length, providerCallsBeforeQuarantinedRemoval);
    const quarantinedRevoked = (await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, secondPrivateBinding.id)))[0]!;
    assert.equal(quarantinedRevoked.state, "revoked");
    assert.equal(quarantinedRevoked.stateReason, "provisioning_pair_removed");
    assert.equal(quarantinedRevoked.bindingEpoch, privateReadded.bindingEpoch + 1);

    const providerCallsBeforeActiveRemoval = providerQueryRequests.length;
    const activeRemoval = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({
        pairs: [{ ...additivePairs[0], expectedBindingEpoch: publicBindingAfterAdd.bindingEpoch }],
      }),
    });
    assert.equal(activeRemoval.status, 200, await activeRemoval.clone().text());
    assert.equal(providerQueryRequests.length, providerCallsBeforeActiveRemoval);
    const publicRevoked = (await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, binding.id)))[0]!;
    assert.equal(publicRevoked.state, "revoked");
    assert.equal(publicRevoked.stateReason, "provisioning_pair_removed");
    assert.equal(publicRevoked.bindingEpoch, publicBindingAfterAdd.bindingEpoch + 1);

    const replacementPair = {
      raftChannelId: raftChannel.id,
      slackChannelId: "C_PRODUCTION_OTHER",
    };
    const replaceAfterOfficialRemoval = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ pairs: [additivePairs[1], replacementPair] }),
      },
    );
    assert.equal(
      replaceAfterOfficialRemoval.status,
      200,
      `an official removal must release both coordinates for a replacement pair: ${await replaceAfterOfficialRemoval.clone().text()}`,
    );
    const bindingsAfterReplacement = await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.serverId, server.id));
    const replacementBinding = bindingsAfterReplacement.find((row) =>
      row.channelId === replacementPair.raftChannelId
      && row.providerConversationId === replacementPair.slackChannelId);
    assert.ok(replacementBinding);
    assert.equal(replacementBinding.state, "paused");
    assert.equal(replacementBinding.stateReason, "provisioning_preflight_pending");
    assert.deepEqual(
      bindingsAfterReplacement.find((row) => row.id === publicRevoked.id),
      publicRevoked,
      "replacement must preserve the officially removed tombstone byte-equivalent",
    );
    assert.deepEqual(
      bindingsAfterReplacement.find((row) => row.id === quarantinedBeforeAdd.id),
      quarantinedBeforeAdd,
      "replacement must preserve an unrelated quarantined sibling byte-equivalent",
    );

    const removeReplacement = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          pairs: [{ ...replacementPair, expectedBindingEpoch: replacementBinding.bindingEpoch }],
        }),
      },
    );
    assert.equal(removeReplacement.status, 200, await removeReplacement.clone().text());

    const readdPublic = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ pairs: additivePairs }),
    });
    assert.equal(readdPublic.status, 200, await readdPublic.clone().text());
    const publicReadded = (await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, binding.id)))[0]!;
    assert.equal(publicReadded.id, binding.id);
    assert.equal(publicReadded.state, "paused");
    assert.equal(publicReadded.stateReason, "provisioning_preflight_pending");
    assert.equal(publicReadded.bindingEpoch, publicRevoked.bindingEpoch + 1);

    await getDb().update(externalChannelBindings).set({
      state: "revoked",
      stateReason: "test_security_revocation",
    }).where(eq(externalChannelBindings.id, publicReadded.id));
    const securityRevoked = (await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, publicReadded.id)))[0]!;
    const rejectedSecurityRevival = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ pairs: additivePairs }),
      },
    );
    assert.equal(
      rejectedSecurityRevival.status,
      409,
      await rejectedSecurityRevival.clone().text(),
    );
    assert.equal(
      (await rejectedSecurityRevival.json() as { code: string }).code,
      "external_app_install_conflict",
    );
    assert.deepEqual(
      (await getDb().select().from(externalChannelBindings)
        .where(eq(externalChannelBindings.id, publicReadded.id)))[0],
      securityRevoked,
      "teardown revival must not override a binding revoked for another reason",
    );

    await getDb().update(externalAppInstalls).set({
      state: "reauth_required",
      stateReason: "test_provider_reauthorization_required",
      updatedAt: new Date(),
    }).where(eq(externalAppInstalls.id, install.id));

    const readDisconnectAuthority = async () => ({
      grant: (await getDb().select().from(externalAppServerGrants)
        .where(eq(externalAppServerGrants.id, grant.id)))[0],
      install: (await getDb().select().from(externalAppInstalls)
        .where(eq(externalAppInstalls.id, install.id)))[0],
      credential: (await getDb().select().from(externalAppCredentials)
        .where(eq(externalAppCredentials.installId, install.id)))[0],
      bindings: await getDb().select().from(externalChannelBindings)
        .where(eq(externalChannelBindings.installId, install.id)),
      policies: await getDb().select().from(externalAuthorPolicies)
        .where(eq(externalAuthorPolicies.installId, install.id)),
      links: await getDb().select().from(externalHumanIdentityLinks)
        .where(eq(externalHumanIdentityLinks.installId, install.id)),
      clientInstall: (await getDb().select().from(oauthClientInstalls).where(and(
        eq(oauthClientInstalls.serverId, server.id),
        eq(oauthClientInstalls.clientId, client.id),
      )))[0],
    });

    const liveAuthorityBeforeWrongEpoch = await readDisconnectAuthority();
    const providerCallsBeforeDisconnect = providerQueryRequests.length;
    const wrongEpochDisconnect = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/disconnect`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedConnectionEpoch: install.connectionEpoch + 1 }),
    });
    assert.equal(wrongEpochDisconnect.status, 409, await wrongEpochDisconnect.clone().text());
    assert.equal(
      (await wrongEpochDisconnect.json() as { code: string }).code,
      "external_app_install_conflict",
    );
    assert.equal(
      providerQueryRequests.length,
      providerCallsBeforeDisconnect,
      "wrong-epoch disconnect must perform zero provider I/O",
    );
    assert.deepEqual(
      await readDisconnectAuthority(),
      liveAuthorityBeforeWrongEpoch,
      "wrong-epoch disconnect must leave every live authority row byte-equivalent",
    );

    const disconnected = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/disconnect`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedConnectionEpoch: install.connectionEpoch }),
    });
    assert.equal(disconnected.status, 200, await disconnected.clone().text());
    assert.equal(providerQueryRequests.length, providerCallsBeforeDisconnect, "disconnect must perform zero provider I/O");
    const disconnectedBody = (await disconnected.json() as {
      snapshot: {
        stage: string;
        workspaceName: string | null;
        slackChannels: unknown[];
        channelPairs: unknown[];
      };
      oauthAuthority: unknown;
    });
    assert.equal(disconnectedBody.snapshot.stage, "connect");
    assert.equal(disconnectedBody.snapshot.workspaceName, null);
    assert.deepEqual(disconnectedBody.snapshot.slackChannels, []);
    assert.deepEqual(disconnectedBody.snapshot.channelPairs, []);
    assert.equal(disconnectedBody.oauthAuthority, null);

    const [grantAfterDisconnect] = await getDb().select().from(externalAppServerGrants)
      .where(eq(externalAppServerGrants.id, grant.id));
    const [installAfterDisconnect] = await getDb().select().from(externalAppInstalls)
      .where(eq(externalAppInstalls.id, install.id));
    const [credentialAfterDisconnect] = await getDb().select().from(externalAppCredentials)
      .where(eq(externalAppCredentials.installId, install.id));
    const bindingsAfterDisconnect = await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.installId, install.id));
    const policiesAfterDisconnect = await getDb().select().from(externalAuthorPolicies)
      .where(eq(externalAuthorPolicies.installId, install.id));
    const linksAfterDisconnect = await getDb().select().from(externalHumanIdentityLinks)
      .where(eq(externalHumanIdentityLinks.installId, install.id));
    const [clientInstallAfterDisconnect] = await getDb().select().from(oauthClientInstalls)
      .where(and(
        eq(oauthClientInstalls.serverId, server.id),
        eq(oauthClientInstalls.clientId, client.id),
      ));
    assert.equal(grantAfterDisconnect.state, "revoked");
    assert.equal(grantAfterDisconnect.revokeReason, "manager_unbound_workspace");
    assert.equal(installAfterDisconnect.state, "revoked");
    assert.equal(installAfterDisconnect.stateReason, "manager_unbound_workspace");
    assert.equal(installAfterDisconnect.connectionEpoch, install.connectionEpoch + 1);
    assert.equal(credentialAfterDisconnect.state, "revoked");
    assert.ok(credentialAfterDisconnect.revokedAt);
    assert.equal(bindingsAfterDisconnect.some((row) => ["active", "paused", "quarantined"].includes(row.state)), false);
    assert.ok(bindingsAfterDisconnect.some((row) => row.stateReason === "manager_unbound_workspace"));
    assert.deepEqual(
      bindingsAfterDisconnect.find((row) => row.id === securityRevoked.id),
      securityRevoked,
      "disconnect must preserve a prior security revocation reason byte-equivalent",
    );
    assert.equal(policiesAfterDisconnect.some((row) => row.state === "granted"), false);
    assert.equal(linksAfterDisconnect.some((row) => row.state === "active"), false);
    assert.equal(clientInstallAfterDisconnect.status, "suspended");

    const disconnectState = {
      grant: grantAfterDisconnect,
      install: installAfterDisconnect,
      credential: credentialAfterDisconnect,
      bindings: bindingsAfterDisconnect,
      policies: policiesAfterDisconnect,
      links: linksAfterDisconnect,
      clientInstall: clientInstallAfterDisconnect,
    };
    const staleDisconnect = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/disconnect`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedConnectionEpoch: install.connectionEpoch }),
    });
    assert.equal(staleDisconnect.status, 409, await staleDisconnect.clone().text());
    assert.deepEqual(
      await readDisconnectAuthority(),
      disconnectState,
      "stale disconnect replay must leave every authority row byte-equivalent",
    );

    const reconnect = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/connect`, {
      method: "POST",
      headers,
    });
    assert.equal(reconnect.status, 200, await reconnect.clone().text());
    const reconnectBody = await reconnect.json() as {
      snapshot: { stage: string };
      oauthAuthority: { registrationId: string; serverGrantId: string; grantEpoch: number };
    };
    assert.equal(reconnectBody.snapshot.stage, "oauth");

    const reconnectOauthStart = await fetch(`${app.baseUrl}/api/slack-bridge/oauth/start`, {
      method: "POST",
      headers,
      body: JSON.stringify(reconnectBody.oauthAuthority),
    });
    assert.equal(reconnectOauthStart.status, 201, await reconnectOauthStart.clone().text());
    const reconnectAuthorizationUrl = new URL(
      (await reconnectOauthStart.json() as { authorizationUrl: string }).authorizationUrl,
    );
    const reconnectState = reconnectAuthorizationUrl.searchParams.get("state");
    assert.ok(reconnectState);
    const reconnectCallback = await fetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(reconnectState)}&code=production-composition-reconnect-code`,
      { redirect: "manual" },
    );
    assert.equal(reconnectCallback.status, 302, await reconnectCallback.clone().text());

    const reconnectedProvisioning = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning`,
      { headers },
    );
    assert.equal(reconnectedProvisioning.status, 200, await reconnectedProvisioning.clone().text());
    const reconnectedSnapshot = (await reconnectedProvisioning.json() as {
      snapshot: { stage: string; channelPairs: unknown[] };
    }).snapshot;
    assert.equal(
      reconnectedSnapshot.stage,
      "channels",
      "a fresh OAuth epoch must not inherit manager-unbound bindings from the prior connection",
    );
    assert.deepEqual(reconnectedSnapshot.channelPairs, []);

    const reconnectedPairs = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pairs: [{ raftChannelId: raftChannel.id, slackChannelId: "C_PRODUCTION_GENERAL" }],
      }),
    });
    assert.equal(reconnectedPairs.status, 200, await reconnectedPairs.clone().text());
    const bindingsAfterReconnect = await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.installId, install.id))
      .orderBy(externalChannelBindings.createdAt);
    assert.deepEqual(
      bindingsAfterReconnect.find((row) => row.id === binding.id),
      bindingsAfterDisconnect.find((row) => row.id === binding.id),
      "reconnect must preserve the manager-unbound binding as immutable history",
    );
    const currentReconnectBindings = bindingsAfterReconnect.filter((row) =>
      row.connectionEpoch === installAfterDisconnect.connectionEpoch + 1
      && row.state === "paused");
    assert.equal(currentReconnectBindings.length, 1);

    const reconnectPreflight = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/preflight`,
      { method: "POST", headers },
    );
    assert.equal(reconnectPreflight.status, 200, await reconnectPreflight.clone().text());
    assert.equal(
      (await reconnectPreflight.json() as { snapshot: { stage: string } }).snapshot.stage,
      "enable",
    );
    const reconnectEnable = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST",
      headers,
    });
    assert.equal(reconnectEnable.status, 200, await reconnectEnable.clone().text());
    assert.equal(
      (await reconnectEnable.json() as { snapshot: { stage: string } }).snapshot.stage,
      "health",
    );
  } finally {
    await app.close();
    await runtime?.stop();
  }
});

test("deleting the production provisioning injection makes all seven endpoints fail closed", async () => {
  let runtime: Awaited<ReturnType<typeof createSlackBridgeServerRuntimeFromEnv>>;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, async slackBridgeFactory() {
      runtime = await createSlackBridgeServerRuntimeFromEnv(PRODUCTION_ENV, { db: getDb() });
      assert.ok(runtime);
      return { ...runtime, provisioning: undefined };
    } });
  try {
    const { owner, server } = await seedOwner();
    const headers = requestHeaders(owner.id, server.id);
    assert.deepEqual(await observeProvisioningEndpoints(app.baseUrl, headers), [
      {
        method: "GET",
        path: "/api/slack-bridge/provisioning",
        status: 503,
        code: "slack_bridge_provider_unavailable",
      },
      {
        method: "POST",
        path: "/api/slack-bridge/provisioning/connect",
        status: 503,
        code: "slack_bridge_provider_unavailable",
      },
      {
        method: "PUT",
        path: "/api/slack-bridge/provisioning/channel-pairs",
        status: 503,
        code: "slack_bridge_provider_unavailable",
      },
      {
        method: "DELETE",
        path: "/api/slack-bridge/provisioning/channel-pairs",
        status: 503,
        code: "slack_bridge_provider_unavailable",
      },
      {
        method: "POST",
        path: "/api/slack-bridge/provisioning/disconnect",
        status: 503,
        code: "slack_bridge_provider_unavailable",
      },
      {
        method: "POST",
        path: "/api/slack-bridge/provisioning/preflight",
        status: 503,
        code: "slack_bridge_provider_unavailable",
      },
      {
        method: "POST",
        path: "/api/slack-bridge/provisioning/enable",
        status: 503,
        code: "slack_bridge_provider_unavailable",
      },
    ]);
  } finally {
    await app.close();
    await runtime?.stop();
  }
});
