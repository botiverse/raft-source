import { newSlackMentionAuthorizationId } from "./slackMentionReconcileState";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import sharp from "sharp";
import { Agent } from "undici";
import { runNamedCase } from "../test/runNamedCase";

import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppInstallGrantReceipts,
  externalAppInstallServerGrants,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppServerGrants,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  externalDeliveryPartitions,
  externalInboundEvents,
  externalHumanIdentityLinks,
  slackUsergroupIdentities,
  externalMessageLinks,
  externalOutboundDeliveries,
  externalProjectionAvatarArtifacts,
  messageMentions,
  messages,
  oauthAccessRequests,
  oauthClients,
  oauthClientInstalls,
  users,
} from "../db/schema";
import { accessTokenForTest } from "../test/integration/credentials";
import { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "../routes/slackBridge";
import { openTestApp } from "../test/integration/app";
import { createServer } from "./serverService";
import { createAgent } from "./agentService";
import { createFeatureFlagRule } from "./featureFlagService";
import { createSlackBridgeEnvCredentialCipher } from "./slackBridgeEnvSecrets";
import { SLACK_BRIDGE_CORE_BOT_SCOPES } from "./slackBridgeProductionAppContract";
import { processExternalInboundEventOnce } from "./externalInboundWorkerService";
import { slackBridgeInstallGrantHash } from "./slackBridgeInstallGrantService";
import {
  createSlackBridgeProviderRuntime,
  slackUsergroupNamingConflict,
} from "./slackBridgeProviderRuntime";
import { slackHumanHandleCandidates } from "./slackMentionTokens";
import { createSlackInboundAttachmentAdapter } from "./slackInboundAttachmentAdapter";
import { createSlackOutboundAttachmentAdapter } from "./slackOutboundAttachmentAdapter";
import { lookupSlackProviderConversation } from "./slackProviderAdapter";
import {
  listSlackBridgeAgentMentionCandidates,
  listSlackBridgeMentionCandidates,
  reconcileSlackBridgeOAuthIdentityAppType,
  refreshSlackConversationAuthority,
  slackBridgeProvisioningManifestHash,
  SLACK_BRIDGE_PROVISIONING_CAPABILITIES,
} from "./slackBridgeProvisioningControlPlane";
import { createSlackBridgeServerRuntimeFromEnv } from "./slackBridgeServerRuntime";
import {
  ExternalAppControlPlaneError,
  resolveExternalBindingAuthority,
} from "./externalAppControlPlaneService";
import { revealAllChannelForTest } from "../test/allChannelFixture";

// Every request to the test app opens its own connection. This test runs long
// stretches of in-process work between requests, and on the CI shard a request
// reusing an idle keep-alive connection was reset (ECONNRESET, staging since
// 10-25, task #87). A failure also names the request, which the bare
// "fetch failed" did not.
const appDispatcher = new Agent({ pipelining: 0 });
async function appFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await globalThis.fetch(input, { ...init, dispatcher: appDispatcher } as RequestInit);
  } catch (error) {
    throw new Error(`${init?.method ?? "GET"} ${new URL(input).pathname} failed`, { cause: error });
  }
}

/**
 * The Cookie header a browser sends back to the OAuth callback: the start response binds the
 * install to the starting browser (oauthBrowserBinding.ts), and only that browser may finish it.
 */
function oauthBindingCookie(start: Response): string {
  const binding = start.headers.getSetCookie().find((cookie) => cookie.startsWith("raft_slack_oauth_"));
  assert.ok(binding, "the OAuth start response must bind the install to this browser");
  return binding.split(";")[0]!;
}

// Built at runtime so secret scanners don't flag this test sample.
const SLACK_XOXB = "xo" + "xb-";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

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

async function requestHeaders(userId: string, serverId: string): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await accessTokenForTest(userId)}`,
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
    const response = await appFetch(`${baseUrl}${path}`, {
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
  let providerAuthorizerMember = true;
  let beforeAudienceResponse: (() => Promise<void>) | null = null;
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
  let providerGrantedScopes = [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES];
  let providerUsergroupListCalls = 0;
  let providerUsergroupsFail = false;
  let providerUsergroupCreateError: string | null = null;
  let beforeUsergroupCreateRefusal: (() => Promise<void>) | null = null;
  let providerDisableFail = false;
  let providerEnableFail = false;
  let rateLimitNextGroupCreate = false;
  let providerUsergroupDisableCalls = 0;
  const providerUsergroupCreateAttempts: string[] = [];
  const providerUsergroupUpdateAttempts: string[] = [];
  let loseNextUsergroupCreateResponse = false;
  const mentionReconcileClaims: string[] = [];
  let denyMentionReconcileClaim = false;
  const providerUsergroupCreateRefusals = new Map<string, string>();
  const providerUsergroups: Array<{
    id: string;
    name: string;
    handle: string;
    description: string;
    date_delete: number;
  }> = [];
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
                : `  ${providerGrantedScopes.slice().reverse().join(" , ")} , ${providerGrantedScopes[0]} `,
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
          access_token: `${SLACK_XOXB}production-composition`,
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
            ...(providerAuthorizerMember ? ["U_PRODUCTION_OWNER"] : []),
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
        const responseHook = beforeAudienceResponse;
        beforeAudienceResponse = null;
        if (responseHook) await responseHook();
        return new Response(JSON.stringify({
          ok: true,
          user: {
            id: "U_PRODUCTION_OWNER",
            team_id: "T_PRODUCTION_COMPOSITION",
            deleted: false,
            name: "production-owner",
            is_admin: true,
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
      if (method === "usergroups.list") {
        providerUsergroupListCalls += 1;
        if (providerUsergroupsFail) {
          return new Response(JSON.stringify({ ok: false, error: "paid_teams_only" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true, usergroups: providerUsergroups }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "usergroups.create") {
        const request = JSON.parse(String(init?.body)) as {
          name: string;
          handle: string;
          description: string;
        };
        providerUsergroupCreateAttempts.push(request.handle);
        if (providerUsergroupCreateError) {
          const hook = beforeUsergroupCreateRefusal;
          beforeUsergroupCreateRefusal = null;
          if (hook) await hook();
          return new Response(JSON.stringify({ ok: false, error: providerUsergroupCreateError }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        if (rateLimitNextGroupCreate) {
          rateLimitNextGroupCreate = false;
          return new Response("rate limited", { status: 429, headers: { "Retry-After": "120" } });
        }
        const refusal = providerUsergroupCreateRefusals.get(request.handle);
        if (refusal) {
          return new Response(JSON.stringify({ ok: false, error: refusal }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        const group = {
          id: `SPRODUCTION${providerUsergroups.length + 1}`,
          ...request,
          date_delete: 0,
        };
        providerUsergroups.push(group);
        if (loseNextUsergroupCreateResponse) {
          loseNextUsergroupCreateResponse = false;
          return Response.json({ ok: false }, { status: 503 });
        }
        return new Response(JSON.stringify({ ok: true, usergroup: group }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "usergroups.update") {
        const request = JSON.parse(String(init?.body)) as {
          usergroup: string;
          name: string;
          handle: string;
          description: string;
        };
        providerUsergroupUpdateAttempts.push(request.handle);
        const group = providerUsergroups.find((candidate) => candidate.id === request.usergroup);
        if (!group) return new Response(JSON.stringify({ ok: false, error: "usergroup_not_found" }));
        const refusal = request.handle === group.handle
          ? undefined
          : providerUsergroupCreateRefusals.get(request.handle);
        if (refusal) {
          return new Response(JSON.stringify({ ok: false, error: refusal }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        Object.assign(group, {
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.handle === undefined ? {} : { handle: request.handle }),
          ...(request.description === undefined ? {} : { description: request.description }),
        });
        return new Response(JSON.stringify({ ok: true, usergroup: group }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "usergroups.enable" || method === "usergroups.disable") {
        if (method === "usergroups.enable" && providerEnableFail) return Response.json({ ok: false, error: "permission_denied" });
        if (method === "usergroups.disable") providerUsergroupDisableCalls += 1;
        if (method === "usergroups.disable" && providerDisableFail) return new Response(JSON.stringify({ ok: false, error: "permission_denied" }));
        const request = JSON.parse(String(init?.body)) as { usergroup: string };
        const group = providerUsergroups.find((candidate) => candidate.id === request.usergroup);
        if (!group) return new Response(JSON.stringify({ ok: false, error: "usergroup_not_found" }));
        group.date_delete = method === "usergroups.disable" ? 1 : 0;
        return new Response(JSON.stringify({ ok: true, usergroup: group }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, async slackBridgeFactory() {
      runtime = await createSlackBridgeServerRuntimeFromEnv(PRODUCTION_ENV, {
        db: getDb(),
        fetch: providerFetch,
        async claimAgentMentionReconcile(serverId, installId) {
          mentionReconcileClaims.push(`${serverId}:${installId}`);
          return denyMentionReconcileClaim ? null : { held: async () => true, end: () => {} };
        },
      });
      assert.ok(runtime, "production runtime must start from complete environment authority");
      return runtime;
    } });
  try {
    const probe = await seedOwner();
    const observations = await observeProvisioningEndpoints(
      app.baseUrl,
      await requestHeaders(probe.owner.id, probe.server.id),
    );
    assert.deepEqual(
      observations.filter(({ status }) => status === 503),
      [],
      "the real production composition must keep every provisioning endpoint out of fail-closed 503",
    );

    const { owner, server } = await seedOwner();
    // #all live as on an established server; the private onboarding-owner
    // channel a new server is born with stays, as in production.
    await revealAllChannelForTest(server.id);
    const headers = await requestHeaders(owner.id, server.id);
    const load = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
    assert.equal(load.status, 200, await load.clone().text());
    assert.equal((await load.json() as { snapshot: { stage: string } }).snapshot.stage, "connect");

    const connect = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/connect`, {
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

    // A scope-shipping deploy moves the code-side manifest hash forward while
    // persisted rows keep the hash they were written under. Provisioning load
    // must reconcile registration + active grants to the current hash instead
    // of failing every existing install with install_conflict.
    await runNamedCase("manifest hash drift reconciles registration and active grants on load", async () => {
      const staleHash = `stale-${registration.capabilityManifestHash.slice(6)}`;
      await getDb().update(externalAppRegistrations)
        .set({ capabilityManifestHash: staleHash })
        .where(eq(externalAppRegistrations.id, registration.id));
      await getDb().update(externalAppServerGrants)
        .set({ grantedManifestHash: staleHash })
        .where(and(
          eq(externalAppServerGrants.registrationId, registration.id),
          eq(externalAppServerGrants.state, "active"),
        ));
      try {
        const drifted = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
        assert.equal(drifted.status, 200, await drifted.clone().text());
        const [repairedRegistration] = await getDb().select()
          .from(externalAppRegistrations)
          .where(eq(externalAppRegistrations.id, registration.id));
        assert.equal(repairedRegistration?.capabilityManifestHash, registration.capabilityManifestHash);
        const repairedGrants = await getDb().select({
          grantedManifestHash: externalAppServerGrants.grantedManifestHash,
        }).from(externalAppServerGrants).where(and(
          eq(externalAppServerGrants.registrationId, registration.id),
          eq(externalAppServerGrants.state, "active"),
        ));
        for (const repairedGrant of repairedGrants) {
          assert.equal(repairedGrant.grantedManifestHash, registration.capabilityManifestHash);
        }
      } finally {
        await getDb().update(externalAppRegistrations)
          .set({ capabilityManifestHash: registration.capabilityManifestHash })
          .where(eq(externalAppRegistrations.id, registration.id));
        await getDb().update(externalAppServerGrants)
          .set({ grantedManifestHash: registration.capabilityManifestHash })
          .where(eq(externalAppServerGrants.registrationId, registration.id));
      }
    });

    // A grant carrying a hash outside {previous, current} cannot be
    // reconciled — the request must conflict AND leave the registration row
    // untouched (the drift check runs before any write, inside one
    // transaction, so there is no half-repaired state).
    await runNamedCase("unrepairable grant manifest hash conflicts without partial repair", async () => {
      const staleHash = `stale-${registration.capabilityManifestHash.slice(6)}`;
      const foreignHash = `other-${registration.capabilityManifestHash.slice(6)}`;
      await getDb().update(externalAppRegistrations)
        .set({ capabilityManifestHash: staleHash })
        .where(eq(externalAppRegistrations.id, registration.id));
      await getDb().update(externalAppServerGrants)
        .set({ grantedManifestHash: foreignHash })
        .where(and(
          eq(externalAppServerGrants.registrationId, registration.id),
          eq(externalAppServerGrants.state, "active"),
        ));
      try {
        const conflicted = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
        assert.equal(conflicted.status, 409);
        assert.equal((await conflicted.json() as { code?: string }).code, "external_app_install_conflict");
        const [untouched] = await getDb().select()
          .from(externalAppRegistrations)
          .where(eq(externalAppRegistrations.id, registration.id));
        assert.equal(untouched?.capabilityManifestHash, staleHash);
      } finally {
        await getDb().update(externalAppRegistrations)
          .set({ capabilityManifestHash: registration.capabilityManifestHash })
          .where(eq(externalAppRegistrations.id, registration.id));
        await getDb().update(externalAppServerGrants)
          .set({ grantedManifestHash: registration.capabilityManifestHash })
          .where(eq(externalAppServerGrants.registrationId, registration.id));
      }
    });

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

    const oauthStart = await appFetch(`${app.baseUrl}/api/slack-bridge/oauth/start`, {
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
    const oauthCallback = await appFetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(state)}&code=production-composition-code`,
      { redirect: "manual", headers: { Cookie: oauthBindingCookie(oauthStart) } },
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

    const postOauth = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
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
    assert.deepEqual(providerQueryRequests.filter(call => call.method === "conversations.list").at(-1), {
      method: "conversations.list",
      httpMethod: "GET",
      body: undefined,
      authorization: `Bearer ${SLACK_XOXB}production-composition`,
      contentType: null,
      query: "exclude_archived=true&limit=200&types=public_channel%2Cprivate_channel",
    }, "private inventory must use Slack's complete GET-query shape");
    assert.ok(providerQueryRequests.some(call => call.method === "conversations.members"
      && call.httpMethod === "GET" && call.query.includes("channel=C_PRODUCTION_PRIVATE")),
    "private channel visibility requires live authorizer membership");
    // The pairs below use public Slack channels, and a pair must match privacy:
    // pick a public Raft channel, not whichever row comes first.
    const [raftChannel] = await getDb().select().from(channels)
      .where(and(eq(channels.serverId, server.id), eq(channels.type, "channel"))).limit(1);
    assert.ok(raftChannel);
    providerAuthorizerMember = false;
    const notMemberView = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
    assert.equal(notMemberView.status, 200);
    const notMemberSnapshot = (await notMemberView.json() as { snapshot: { slackChannels: Array<{ id: string }> } }).snapshot;
    assert.equal(notMemberSnapshot.slackChannels.some(channel => channel.id === "C_PRODUCTION_PRIVATE"), false);
    const forgedPrivatePair = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
      method: "PUT", headers, body: JSON.stringify({ pairs: [{ raftChannelId: raftChannel.id,
        slackChannelId: "C_PRODUCTION_PRIVATE" }] }),
    });
    assert.notEqual(forgedPrivatePair.status, 200, "a guessed private channel cannot bypass the list check");
    assert.equal((await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.serverId, server.id))).length, 0);
    providerAuthorizerMember = true;
    const [mentionAgent] = await getDb().insert(agents).values({
      serverId: server.id,
      name: "production-agent",
      displayName: "Production Agent",
      runtime: "codex",
    }).returning();
    await getDb().insert(channelAgents).values({
      channelId: raftChannel.id,
      agentId: mentionAgent.id,
    });

    const nonMemberPair = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
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
      reason: "not_member",
    }, "a Slack channel outside the app audience must fail before binding persistence");
    providerOtherChannelMember = true;

    const pairs = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pairs: [{ raftChannelId: raftChannel.id, slackChannelId: "C_PRODUCTION_GENERAL" }],
      }),
    });
    assert.equal(pairs.status, 200, await pairs.clone().text());

    providerBotInConversation = false;
    const missingBotPreflight = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/preflight`, {
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
    const preflight = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/preflight`, {
      method: "POST",
      headers,
    });
    assert.equal(preflight.status, 200, await preflight.clone().text());
    assert.equal((await preflight.json() as { snapshot: { stage: string } }).snapshot.stage, "enable");
    assert.deepEqual(providerQueryRequests.filter(call => !(call.method === "conversations.members"
      && call.query.includes("channel=C_PRODUCTION_PRIVATE"))).slice(-3), [{
      method: "conversations.list",
      httpMethod: "GET",
      body: undefined,
      authorization: `Bearer ${SLACK_XOXB}production-composition`,
      contentType: null,
      query: "exclude_archived=true&limit=200&types=public_channel%2Cprivate_channel",
    }, {
      method: "conversations.members",
      httpMethod: "GET",
      body: undefined,
      authorization: `Bearer ${SLACK_XOXB}production-composition`,
      contentType: null,
      query: "channel=C_PRODUCTION_GENERAL&limit=200",
    }, {
      method: "users.info",
      httpMethod: "GET",
      body: undefined,
      authorization: `Bearer ${SLACK_XOXB}production-composition`,
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
    const driftedEnable = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
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
    const recoveredPreflight = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/preflight`, {
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
    const failedEnable = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
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


    const enable = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST",
      headers,
    });
    assert.equal(enable.status, 200, await enable.clone().text());
    assert.equal((await enable.json() as { snapshot: { stage: string } }).snapshot.stage, "health");
    assert.deepEqual(providerUsergroups.map((group) => ({
      id: group.id,
      handle: group.handle,
      description: group.description,
    })), [{
      id: "SPRODUCTION1",
      handle: "production-agent",
      description: "Raft agent",
    }, {
      id: "SPRODUCTION2",
      handle: owner.name,
      description: "Raft member",
    }]);
    const [baselineGrantReceipt] = await getDb().select()
      .from(externalAppInstallGrantReceipts)
      .where(eq(externalAppInstallGrantReceipts.installId, install.id));
    assert.ok(baselineGrantReceipt);
    const mentionCallsBeforeLegacyRepair = providerUsergroupListCalls;
    providerGrantedScopes = [...SLACK_BRIDGE_CORE_BOT_SCOPES];
    await getDb().update(externalAppInstalls).set({
      installedScopes: [...SLACK_BRIDGE_CORE_BOT_SCOPES],
      scopeRevision: install.scopeRevision + 1,
    }).where(eq(externalAppInstalls.id, install.id));
    const legacyRepair = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST",
      headers,
    });
    assert.equal(legacyRepair.status, 200, await legacyRepair.clone().text());
    assert.equal(
      providerUsergroupListCalls,
      mentionCallsBeforeLegacyRepair,
      "legacy core-scope repair must not call the unavailable usergroup API",
    );
    await getDb().update(externalAppInstalls).set({
      installedScopes: [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES],
      scopeRevision: install.scopeRevision,
    }).where(eq(externalAppInstalls.id, install.id));
    providerGrantedScopes = [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES];

    // Usergroup sync failure (free plan / admin-only policy / handle
    // collision) must degrade, not block binding: enable still succeeds and
    // the binding stays active.
    providerUsergroupsFail = true;
    const degradedEnable = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST",
      headers,
    });
    assert.equal(degradedEnable.status, 200, await degradedEnable.clone().text());
    const [degradedBinding] = await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, binding.id));
    assert.equal(degradedBinding?.state, "active", "usergroup sync failure must not pause binding");
    const [degradedInstall] = await getDb().select().from(externalAppInstallServerGrants)
      .where(and(eq(externalAppInstallServerGrants.installId, install.id), eq(externalAppInstallServerGrants.serverId, server.id)));
    assert.deepEqual(degradedInstall?.agentMentionSync && {
      state: degradedInstall.agentMentionSync.state,
      slackError: degradedInstall.agentMentionSync.slackError,
    }, {
      state: "degraded",
      slackError: "paid_teams_only",
    }, "deterministic usergroup failure must persist Slack's error for the settings hint");
    providerUsergroupsFail = false;
    const cachedFreeEnableCalls = providerUsergroupListCalls;
    const cachedFreeEnable = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST", headers,
    });
    assert.equal(cachedFreeEnable.status, 200);
    assert.equal(providerUsergroupListCalls, cachedFreeEnableCalls,
      "a known free workspace keeps binding usable without repeating usergroup reads");
    // End this simulated free-plan scenario before independent paid scenarios.
    await getDb().update(externalAppInstalls).set({ slackMentionCapability: null })
      .where(eq(externalAppInstalls.id, install.id));

    await getDb().delete(externalAppInstallGrantReceipts)
      .where(eq(externalAppInstallGrantReceipts.installId, install.id));
    await getDb().insert(externalAppInstallGrantReceipts).values(baselineGrantReceipt);
    const resolvedAgentHandle = await runtime!.inboundWorkerDependencies
      .resolveProviderAgentMentionHandles!({
        eventId: "event-agent-handle-resolution",
        frozenAuthority: {
          runtimeRevision: "runtime-agent-handle-resolution",
          provider: "slack",
          environment: "test",
          appRegistrationId: registration.id,
          installId: install.id,
          workspaceId: install.providerAuthorityId,
          providerAuthorityId: install.providerAuthorityId,
          providerConversationId: binding.providerConversationId,
          bindingId: binding.id,
          bindingEpoch: binding.bindingEpoch,
          connectionEpoch: install.connectionEpoch,
          raftChannelId: binding.channelId,
          privacyClass: binding.privacyClass,
        },
        providerUsergroupIds: ["SPRODUCTION1"],
      });
    assert.deepEqual(resolvedAgentHandle, [{
      agentId: mentionAgent.id,
      providerUsergroupId: "SPRODUCTION1",
      handle: "production-agent",
    }]);
    // A legacy install without `usergroups:read` treats a usergroup mention as
    // "no agent mentions" — the message still commits instead of blocking
    // forever on `provider_agent_mention_unavailable` / missing_scope.
    await getDb().update(externalAppInstalls).set({
      installedScopes: [...SLACK_BRIDGE_CORE_BOT_SCOPES],
      scopeRevision: install.scopeRevision + 2,
    }).where(eq(externalAppInstalls.id, install.id));
    const legacyResolved = await runtime!.inboundWorkerDependencies
      .resolveProviderAgentMentionHandles!({
        eventId: "event-agent-handle-legacy",
        frozenAuthority: {
          runtimeRevision: "runtime-agent-handle-legacy",
          provider: "slack",
          environment: "test",
          appRegistrationId: registration.id,
          installId: install.id,
          workspaceId: install.providerAuthorityId,
          providerAuthorityId: install.providerAuthorityId,
          providerConversationId: binding.providerConversationId,
          bindingId: binding.id,
          bindingEpoch: binding.bindingEpoch,
          connectionEpoch: install.connectionEpoch,
          raftChannelId: binding.channelId,
          privacyClass: binding.privacyClass,
        },
        providerUsergroupIds: ["SPRODUCTION1"],
      });
    assert.deepEqual(legacyResolved, [], "legacy-scope install resolves to no agent mentions");
    await getDb().update(externalAppInstalls).set({
      installedScopes: [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES],
      scopeRevision: install.scopeRevision,
    }).where(eq(externalAppInstalls.id, install.id));
    let mentionNow = new Date();
    const mentionProbe = createSlackBridgeProviderRuntime({
      credentialCipher: createSlackBridgeEnvCredentialCipher({
        key: Buffer.from(CREDENTIAL_KEY, "base64"),
      }),
      db: getDb(),
      fetch: providerFetch,
      now: () => mentionNow,
    });
    const mentionAuthority = {
      installId: install.id,
      providerAppId: install.providerAppId,
      providerAuthorityId: install.providerAuthorityId,
      botUserId: install.botUserId!,
      connectionEpoch: install.connectionEpoch,
      credentialRevision: install.credentialRevision,
      now: mentionNow,
    };
    // Independent historical scenarios run after retry windows. The explicit
    // frozen-clock cases below exercise requests inside those windows.
    const reconcileMentions: NonNullable<typeof mentionProbe.provisioningProvider.reconcileAgentMentionHandles> = async (authority, request) => {
      mentionNow = new Date(mentionNow.getTime() + 61 * 60_000);
      authority.now = mentionNow;
      return mentionProbe.provisioningProvider.reconcileAgentMentionHandles!(authority, request);
    };
    // Existing Slack groups are adopted by the exact legacy marker, then the
    // UUID-bearing description is cleared without replacing their identity.
    const originalGroup = providerUsergroups[0]!;
    originalGroup.description = `raft-agent:${server.id}:${mentionAgent.id}`;
    const ownerGroupBefore = structuredClone(providerUsergroups.find(group => group.handle === owner.name));
    const ownerMappingQuery = () => getDb().select({ id: slackUsergroupIdentities.id,
      providerUsergroupId: slackUsergroupIdentities.providerUsergroupId,
    }).from(slackUsergroupIdentities).where(and(
      eq(slackUsergroupIdentities.installId, install.id),
      eq(slackUsergroupIdentities.principalKind, "user"),
      eq(slackUsergroupIdentities.principalId, owner.id),
    ));
    const ownerMappingBefore = await ownerMappingQuery();
    assert.equal(ownerMappingBefore.length, 1);
    await getDb().delete(slackUsergroupIdentities).where(and(
      eq(slackUsergroupIdentities.installId, install.id),
      eq(slackUsergroupIdentities.principalKind, "agent"),
      eq(slackUsergroupIdentities.principalId, mentionAgent.id),
    ));
    const currentBindings = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.id, binding.id));
    const originalCandidates = await listSlackBridgeAgentMentionCandidates(getDb(), server.id, currentBindings);
    const reconcileOriginal = () => reconcileMentions(
      mentionAuthority, { serverId: server.id, candidates: originalCandidates },
    );
    await runNamedCase("free workspace stops on first create refusal and reprobes after authorization changes", async () => {
      const freeCandidates = [0, 1, 2].map((index) => ({
        ...originalCandidates[0]!, agentId: randomUUID(), name: `free-agent-${index}`, displayName: `Free Agent ${index}`,
      }));
      const freeRequest = { serverId: server.id, candidates: freeCandidates };
      const beforeCreates = providerUsergroupCreateAttempts.length;
      providerUsergroupCreateError = "paid_teams_only";
      const refused = await reconcileMentions(mentionAuthority, freeRequest);
      assert.deepEqual(refused, { kind: "failed", slackError: "paid_teams_only" });
      assert.equal(providerUsergroupCreateAttempts.length, beforeCreates + 1,
        "the first plan refusal must stop later principals in the same pass");
      const [cachedInstall] = await getDb().select().from(externalAppInstalls)
        .where(eq(externalAppInstalls.id, install.id));
      assert.equal(cachedInstall?.slackMentionCapability?.result, "paid_teams_only");
      assert.equal(cachedInstall?.slackMentionCapability?.credentialRevision, mentionAuthority.credentialRevision);
      const restart = createSlackBridgeProviderRuntime({
        credentialCipher: createSlackBridgeEnvCredentialCipher({ key: Buffer.from(CREDENTIAL_KEY, "base64") }),
        db: getDb(), fetch: providerFetch, now: () => mentionNow,
      });
      try {
        const listCalls = providerUsergroupListCalls;
        mentionNow = new Date(mentionNow.getTime() + 24 * 60 * 60_000);
        mentionAuthority.now = mentionNow;
        const anotherServer = randomUUID();
        const cached = await restart.provisioningProvider.reconcileAgentMentionHandles!(mentionAuthority, {
          serverId: anotherServer, candidates: freeCandidates.map((candidate) => ({ ...candidate, serverId: anotherServer })),
        });
        assert.deepEqual(cached, refused);
        assert.equal(providerUsergroupListCalls, listCalls,
          "another runtime/server must reuse the persisted capability without any Slack call");
        assert.equal(providerUsergroupCreateAttempts.length, beforeCreates + 1);
      } finally { await restart.stop(); }
      // A second server's fresh OAuth consent can reuse the same token.
      await getDb().update(externalAppInstalls).set({ slackMentionCapability: {
        authorizationId: newSlackMentionAuthorizationId(), result: "unverified",
        connectionEpoch: mentionAuthority.connectionEpoch, credentialRevision: mentionAuthority.credentialRevision,
      } }).where(eq(externalAppInstalls.id, install.id));
      providerUsergroupCreateError = null;
      const resumed = await reconcileMentions(mentionAuthority, freeRequest);
      assert.equal(resumed.kind, "fact");
      assert.equal(providerUsergroupCreateAttempts.length, beforeCreates + 4,
        "fresh consent must allow all three candidates without rotating the token");
      await getDb().update(externalAppInstalls).set({ slackMentionCapability: null })
        .where(eq(externalAppInstalls.id, install.id));
      // A delayed old-token refusal cannot disable an authorization installed
      // while the provider request was in flight.
      providerUsergroupCreateError = "paid_teams_only";
      beforeUsergroupCreateRefusal = async () => {
        await getDb().update(externalAppInstalls).set({ slackMentionCapability: {
          authorizationId: newSlackMentionAuthorizationId(), result: "unverified",
          connectionEpoch: mentionAuthority.connectionEpoch, credentialRevision: mentionAuthority.credentialRevision,
        } }).where(eq(externalAppInstalls.id, install.id));
      };
      try {
        const delayed = await reconcileMentions(mentionAuthority, {
          serverId: server.id, candidates: [{ ...freeCandidates[0]!, agentId: randomUUID(), name: "delayed-free-agent" }],
        });
        assert.equal(delayed.kind, "unverified");
        const [after] = await getDb().select().from(externalAppInstalls).where(eq(externalAppInstalls.id, install.id));
        assert.equal(after?.slackMentionCapability?.result, "unverified", "old refusal must not poison the new authorization even when token versions stay the same");
      } finally {
        providerUsergroupCreateError = null;
        beforeUsergroupCreateRefusal = null;
        await getDb().update(externalAppInstalls).set({ credentialRevision: mentionAuthority.credentialRevision, slackMentionCapability: null })
          .where(eq(externalAppInstalls.id, install.id));
      }
      assert.equal((await reconcileOriginal()).kind, "fact");
      for (const candidate of freeCandidates) {
        const index = providerUsergroups.findIndex((group) => group.handle === candidate.name);
        if (index >= 0) providerUsergroups.splice(index, 1);
      }
      await getDb().delete(slackUsergroupIdentities).where(and(
        eq(slackUsergroupIdentities.installId, install.id),
        inArray(slackUsergroupIdentities.principalId, freeCandidates.map((candidate) => candidate.agentId)),
      ));
    });
    assert.equal((await reconcileOriginal()).kind, "fact");
    assert.equal(providerUsergroups[0]?.id, "SPRODUCTION1");
    assert.equal(providerUsergroups[0]?.handle, "production-agent");
    assert.equal(providerUsergroups[0]?.description, "Raft agent");
    const known = await mentionProbe.resolveAgentMentionHandles(mentionAuthority, {
      serverId: server.id, providerUsergroupIds: ["SPRODUCTION1"],
    });
    assert.ok(known.kind === "fact" && known.fact.handles.some((h) => h.agentId === mentionAgent.id));
    const foreign = await mentionProbe.resolveAgentMentionHandles(mentionAuthority, {
      serverId: randomUUID(), providerUsergroupIds: ["SPRODUCTION1"],
    });
    assert.ok(foreign.kind === "fact" && foreign.fact.handles.length === 0);

    // Use a separate synthetic candidate for uncertain-create recovery; do
    // not delete other principals' mappings or the original Slack group.
    const recoveryCandidate = { ...originalCandidates[0]!, agentId: randomUUID(),
      name: "recovery-agent", displayName: "Recovery Agent" };
    const reconcileRecovery = () => reconcileMentions(
      mentionAuthority, { serverId: server.id, candidates: [...originalCandidates, recoveryCandidate] },
    );
    loseNextUsergroupCreateResponse = true;
    const uncertain = await reconcileRecovery();
    assert.ok(uncertain.kind === "fact" && uncertain.fact.failures.length === 1);
    const recoveryGroup = providerUsergroups.find(group => group.handle === recoveryCandidate.name)!;
    assert.ok(recoveryGroup);
    assert.match(recoveryGroup.description, /^Raft identity pending [0-9a-f]{48}$/);
    assert.ok(!recoveryGroup.description.includes(server.id));
    assert.ok(!recoveryGroup.description.includes(recoveryCandidate.agentId));
    const attempts = providerUsergroupCreateAttempts.length;
    assert.equal((await reconcileRecovery()).kind, "fact");
    assert.equal(providerUsergroupCreateAttempts.length, attempts, "lost create response must not create a duplicate");
    assert.equal(recoveryGroup.description, "Raft agent");
    providerUsergroupUpdateAttempts.length = 0;
    assert.equal((await reconcileRecovery()).kind, "fact");
    assert.deepEqual(providerUsergroupUpdateAttempts, [], "clean descriptions converge without repeat writes");
    assert.deepEqual(providerUsergroups.find(group => group.handle === owner.name), ownerGroupBefore,
      "an Agent-only recovery must not replace or retire the owner's group");
    assert.deepEqual(await ownerMappingQuery(), ownerMappingBefore,
      "Agent recovery must preserve the existing human identity mapping");
    assert.equal((await reconcileOriginal()).kind, "fact");
    assert.equal(recoveryGroup.date_delete, 1);
    providerUsergroups.splice(providerUsergroups.indexOf(recoveryGroup), 1);
    await getDb().delete(slackUsergroupIdentities).where(and(
      eq(slackUsergroupIdentities.installId, install.id),
      eq(slackUsergroupIdentities.principalId, recoveryCandidate.agentId),
    ));
    let exhaustedHumanId: string | null = null;
    try {
      await getDb().update(agents).set({
        name: "production-agent-renamed",
        displayName: "Production Agent Renamed",
      }).where(eq(agents.id, mentionAgent.id));
      const activeBindings = await getDb().select().from(externalChannelBindings).where(and(
        eq(externalChannelBindings.serverId, server.id),
        eq(externalChannelBindings.installId, install.id),
        eq(externalChannelBindings.state, "active"),
      ));
      const renamedCandidates = await listSlackBridgeAgentMentionCandidates(
        getDb(),
        server.id,
        activeBindings,
      );
      // A holder whose cross-replica claim lapsed sends no further Slack
      // write and reports `unverified` (the persisted state stays as is).
      providerUsergroupCreateAttempts.length = 0;
      providerUsergroupUpdateAttempts.length = 0;
      assert.equal((await reconcileMentions(
        mentionAuthority,
        { serverId: server.id, candidates: renamedCandidates, isClaimHeld: async () => false },
      )).kind, "unverified");
      assert.deepEqual([...providerUsergroupCreateAttempts, ...providerUsergroupUpdateAttempts], []);
      assert.equal(providerUsergroups[0]?.handle, "production-agent", "a lapsed holder renamed nothing");
      assert.equal((await reconcileMentions(
        mentionAuthority,
        { serverId: server.id, candidates: renamedCandidates },
      )).kind, "fact");
      assert.equal(providerUsergroups[0]?.handle, "production-agent-renamed");
      // Slack autocomplete shows the usergroup *name* workspace-wide; it must
      // carry the Raft server name so agents from other servers sharing the
      // workspace stay distinguishable. The handle stays the bare agent name.
      assert.equal(providerUsergroups[0]?.name, "Production Agent Renamed (agent) · Slack Production Composition");

      await getDb().delete(channelAgents).where(and(
        eq(channelAgents.channelId, raftChannel.id),
        eq(channelAgents.agentId, mentionAgent.id),
      ));
      const removedCandidates = await listSlackBridgeAgentMentionCandidates(
        getDb(),
        server.id,
        activeBindings,
      );
      assert.deepEqual(removedCandidates, []);
      assert.equal((await reconcileMentions(
        mentionAuthority,
        { serverId: server.id, candidates: removedCandidates },
      )).kind, "fact");
      assert.equal(providerUsergroups[0]?.date_delete, 1);

      await getDb().insert(channelAgents).values({
        channelId: raftChannel.id,
        agentId: mentionAgent.id,
      });
      await getDb().update(agents).set({
        name: "production-agent",
        displayName: "Production Agent",
      }).where(eq(agents.id, mentionAgent.id));
      const restoredCandidates = await listSlackBridgeAgentMentionCandidates(
        getDb(),
        server.id,
        activeBindings,
      );
      const restoredReconcile = await reconcileMentions(
          mentionAuthority,
          { serverId: server.id, candidates: restoredCandidates },
        );
      assert.equal(restoredReconcile.kind, "fact");
      if (restoredReconcile.kind === "fact") {
        assert.equal(restoredReconcile.fact.handles.length, restoredCandidates.length);
        assert.deepEqual(restoredReconcile.fact.failures, []);
      }
      assert.equal(providerUsergroups[0]?.date_delete, 0);
      assert.equal(providerUsergroups[0]?.handle, "production-agent");

      // An Agent group still carrying the pre-label name is renamed to the
      // "(agent)" form on the next reconcile; the handle stays bare.
      providerUsergroups[0]!.name = "Production Agent · Slack Production Composition";
      // Raft humans in the paired channel get `raft-user:` groups alongside
      // Agents; plain Slack groups are never touched.
      providerUsergroups.push({
        id: "SFOREIGNGROUP",
        name: "Design Team",
        handle: "design-team",
        description: "ordinary Slack group",
        date_delete: 0,
      });
      const [mentionHuman] = await getDb().insert(users).values({
        email: `slack-composition-human-${randomUUID()}@raft.test`,
        name: `production-human-${randomUUID().slice(0, 8)}`,
        displayName: "Production Human",
        passwordHash: "not-used",
        emailVerified: true,
      }).returning();
      const [retiredHuman] = await getDb().insert(users).values({
        email: `slack-composition-retired-${randomUUID()}@raft.test`,
        name: `production-retired-${randomUUID().slice(0, 8)}`,
        passwordHash: "not-used",
        emailVerified: true,
        retiredAt: new Date(),
      }).returning();
      await getDb().insert(channelHumans).values([
        { channelId: raftChannel.id, userId: mentionHuman!.id },
        { channelId: raftChannel.id, userId: retiredHuman!.id },
      ]);

      const withHuman = await listSlackBridgeMentionCandidates(getDb(), server.id, activeBindings);
      assert.deepEqual(withHuman.candidates.map((candidate) => candidate.agentId), [mentionAgent.id]);
      assert.ok(withHuman.humanCandidates.some((candidate) => candidate.userId === mentionHuman!.id));
      assert.ok(
        withHuman.humanCandidates.every((candidate) => candidate.userId !== retiredHuman!.id),
        "retired users are never mention candidates",
      );
      const humanReconcile = await reconcileMentions(
        mentionAuthority,
        { serverId: server.id, ...withHuman },
      );
      assert.equal(humanReconcile.kind, "fact");
      const humanGroup = providerUsergroups.find((group) => group.handle === mentionHuman!.name);
      assert.ok(humanGroup, "a paired-channel human gets a managed usergroup");
      assert.equal(humanGroup.handle, mentionHuman!.name);
      assert.equal(humanGroup.name, "Production Human · Raft");
      assert.equal(humanGroup.date_delete, 0);
      const existingHumanGroupId = humanGroup.id;
      humanGroup.name = `Production Human · ${mentionHuman!.id.slice(0, 8)}`;
      await reconcileMentions(mentionAuthority, { serverId: server.id, ...withHuman });
      const renamedHumanGroup = providerUsergroups.find((group) => group.id === existingHumanGroupId)!;
      assert.equal(renamedHumanGroup.name, "Production Human · Raft",
        "an old ID-suffixed group is renamed in place to its source server");
      assert.equal(renamedHumanGroup.handle, mentionHuman!.name, "renaming preserves the mention handle");
      const groupsBeforeSharedHuman = providerUsergroups.length;
      const otherMentionServer = await createServer("Other Raft Server", `other-mention-${randomUUID()}`, owner.id);
      const otherServerId = otherMentionServer.id;
      const sharedHuman = await reconcileMentions(mentionAuthority, {
        serverId: otherServerId, candidates: [],
        humanCandidates: withHuman.humanCandidates.map((human) => ({ ...human, serverId: otherServerId })),
      });
      assert.equal(sharedHuman.kind, "fact");
      assert.equal(providerUsergroups.length, groupsBeforeSharedHuman, "another Raft server reuses the same human usergroup");
      assert.ok(sharedHuman.kind === "fact" && sharedHuman.fact.humanHandles?.some((handle) =>
        handle.userId === mentionHuman!.id && handle.providerUsergroupId === existingHumanGroupId));
      const sharedResolved = await mentionProbe.resolveAgentMentionHandles(mentionAuthority, {
        serverId: otherServerId, providerUsergroupIds: [existingHumanGroupId],
      });
      assert.ok(sharedResolved.kind === "fact" && sharedResolved.fact.humanHandles?.some((handle) => handle.userId === mentionHuman!.id),
        "workspace identity resolution is independent of the reservation's original server");
      humanGroup.name = "Production Human · outdated";
      let releaseBeforeWrite!: () => void;
      let enteredBeforeWrite!: () => void;
      const writeGate = new Promise<void>((resolve) => { releaseBeforeWrite = resolve; });
      const entered = new Promise<void>((resolve) => { enteredBeforeWrite = resolve; });
      const firstWorkspacePass = reconcileMentions(mentionAuthority, {
        serverId: server.id, ...withHuman,
        isClaimHeld: async () => { enteredBeforeWrite(); await writeGate; return true; },
      });
      await entered;
      try {
        const listedBeforeContender = providerUsergroupListCalls;
        const contendingPass = await reconcileMentions(mentionAuthority, {
          serverId: otherServerId, candidates: [], humanCandidates: withHuman.humanCandidates.map((human) => ({ ...human, serverId: otherServerId })),
        });
        assert.equal(contendingPass.kind, "unverified", "another server cannot interleave a reconcile after list but before write");
        assert.equal(providerUsergroupListCalls, listedBeforeContender, "the workspace guard covers the entire provider sequence");
      } finally {
        releaseBeforeWrite();
        await firstWorkspacePass;
      }
      await getDb().execute(sql`INSERT INTO slack_usergroup_identities
        (id, install_id, server_id, principal_kind, principal_id, recovery_ref, provider_usergroup_id)
        VALUES ('ffffffff-ffff-ffff-ffff-ffffffffffff', ${install.id}, ${otherServerId}, 'user', ${mentionHuman!.id}, 'legacy-human-alias', 'SLEGACYHUMAN')`);
      providerUsergroups.push({ id: "SLEGACYHUMAN", name: "Production Human · old-id", handle: "production-human-legacy", description: "Raft member", date_delete: 0 });
      providerDisableFail = true;
      const cleanupDenied = await reconcileMentions(mentionAuthority, { serverId: server.id, ...withHuman });
      assert.ok(cleanupDenied.kind === "fact");
      assert.ok(cleanupDenied.fact.humanHandles?.some((handle) => handle.userId === mentionHuman!.id && handle.providerUsergroupId === existingHumanGroupId));
      assert.deepEqual(cleanupDenied.fact.failures, [], "cleanup refusal does not remove current handles");
      assert.deepEqual(cleanupDenied.fact.cleanupFailures, [{ slackError: "permission_denied" }]);
      providerDisableFail = false;
      await reconcileMentions(mentionAuthority, { serverId: otherServerId, candidates: [], humanCandidates: withHuman.humanCandidates.map((human) => ({ ...human, serverId: otherServerId })) });
      assert.equal(providerUsergroups.find((group) => group.id === "SLEGACYHUMAN")?.date_delete, 1);
      assert.equal(providerUsergroups.find((group) => group.id === existingHumanGroupId)?.date_delete, 0, "shared winner remains enabled");
      const retiredAlias = await mentionProbe.resolveAgentMentionHandles(mentionAuthority, { serverId: otherServerId, providerUsergroupIds: ["SLEGACYHUMAN"] });
      assert.ok(retiredAlias.kind === "fact" && retiredAlias.fact.humanHandles?.some((handle) => handle.userId === mentionHuman!.id),
        "queued old human tokens retain identity after duplicate cleanup; membership is checked at commit");

      const legacyAliasGroup = providerUsergroups.find((group) => group.id === "SLEGACYHUMAN")!;
      humanGroup.date_delete = 1;
      legacyAliasGroup.date_delete = 0;
      const activeAlias = await reconcileMentions(mentionAuthority, { serverId: server.id, ...withHuman });
      assert.ok(activeAlias.kind === "fact" && activeAlias.fact.humanHandles?.some((handle) => handle.userId === mentionHuman!.id && handle.providerUsergroupId === "SLEGACYHUMAN"),
        "an already active alias is preferred over re-enabling a disabled canonical row");
      const canonicalRows = await getDb().select().from(slackUsergroupIdentities).where(and(
        eq(slackUsergroupIdentities.installId, install.id), eq(slackUsergroupIdentities.principalId, mentionHuman!.id),
        eq(slackUsergroupIdentities.humanCanonical, true),
      ));
      assert.deepEqual(canonicalRows.map((row) => row.providerUsergroupId), ["SLEGACYHUMAN"],
        "switching to an active alias atomically replaces the durable outbound destination");
      humanGroup.date_delete = 0;
      legacyAliasGroup.date_delete = 1;

      providerUsergroups.splice(providerUsergroups.findIndex((group) => group.id === "SLEGACYHUMAN"), 1);

      // Permanent per-user naming conflicts must not starve a later healthy user.
      const blockedHumans = Array.from({ length: 68 }, (_, index) => ({
        ...withHuman.humanCandidates[0]!, userId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        name: `budget-conflict-${index}`, displayName: `Budget Conflict ${index}`,
      }));
      for (const human of blockedHumans) for (const handle of slackHumanHandleCandidates(human)) providerUsergroupCreateRefusals.set(handle, "name_taken");
      const healthyAfterFailures = { ...withHuman.humanCandidates[0]!, userId: "ffffffff-ffff-4fff-8fff-fffffffffff0", name: "healthy-after-conflicts", displayName: "Healthy after conflicts" };
      for (let pass = 0; pass < 3; pass++) {
        const result = await reconcileMentions(mentionAuthority, {
          serverId: server.id, candidates: withHuman.candidates,
          humanCandidates: [...withHuman.humanCandidates, ...blockedHumans, healthyAfterFailures],
        });
        assert.equal(result.kind, "fact");
        if (pass === 2) assert.ok(result.kind === "fact" && result.fact.humanHandles?.some((handle) => handle.userId === healthyAfterFailures.userId),
          "permanent failures at the front must not consume each reconciliation and starve a healthy member");
      }

      const probeHumanIds = [...blockedHumans.map((human) => human.userId), healthyAfterFailures.userId];
      await getDb().delete(slackUsergroupIdentities).where(and(eq(slackUsergroupIdentities.installId, install.id), inArray(slackUsergroupIdentities.principalId, probeHumanIds)));
      providerUsergroups.splice(0, providerUsergroups.length, ...providerUsergroups.filter((group) => group.handle !== healthyAfterFailures.name));

      // Failure memory and workspace deduplication survive a new runtime and
      // a different Raft server. No cache or cooldown is kept only in process.
      const memoBlocked = { ...withHuman.humanCandidates[0]!, userId: randomUUID(), name: "memo-blocked", displayName: "Memo Blocked" };
      const memoPermission = { ...memoBlocked, userId: randomUUID(), name: "memo-permission", displayName: "Memo Permission" };
      const memoHealthy = { ...memoBlocked, userId: randomUUID(), name: "memo-healthy", displayName: "Memo Healthy" };
      for (const handle of slackHumanHandleCandidates(memoBlocked)) providerUsergroupCreateRefusals.set(handle, "name_taken");
      providerUsergroupCreateRefusals.set(memoPermission.name, "permission_denied");
      const memoHumans = [...withHuman.humanCandidates, memoBlocked, memoPermission, memoHealthy];
      const frozenReconcile = mentionProbe.provisioningProvider.reconcileAgentMentionHandles!;
      const replica = createSlackBridgeProviderRuntime({
        credentialCipher: createSlackBridgeEnvCredentialCipher({ key: Buffer.from(CREDENTIAL_KEY, "base64") }),
        db: getDb(), fetch: providerFetch, now: () => mentionNow,
      });
      const replicaReconcile = replica.provisioningProvider.reconcileAgentMentionHandles!;
      const attemptsFor = (names: readonly string[]) => providerUsergroupCreateAttempts.filter((handle) => names.includes(handle)).length;
      const blockedNames = [...slackHumanHandleCandidates(memoBlocked), memoPermission.name];
      const frozenRequest = { serverId: server.id, candidates: withHuman.candidates, humanCandidates: memoHumans };
      try {
        const memoStartedAt = mentionNow.getTime();
        const firstMemo = await frozenReconcile(mentionAuthority, frozenRequest);
        assert.ok(firstMemo.kind === "fact" && firstMemo.fact.humanHandles?.some((h) => h.userId === memoHealthy.userId));
        let refusedAttempts = attemptsFor(blockedNames);
        assert.ok(refusedAttempts >= 4, "initial naming and permission failures reach Slack");
        const healthyGroup = providerUsergroups.find((group) => group.handle === memoHealthy.name)!;
        healthyGroup.name = "Externally changed between workspace passes";
        const updatesBeforeReplica = providerUsergroupUpdateAttempts.length;
        await replicaReconcile(mentionAuthority, {
          serverId: otherServerId, candidates: [], humanCandidates: memoHumans.map((h) => ({ ...h, serverId: otherServerId, serverSlug: "other-raft-server", serverName: "Other Raft Server" })),
        });
        assert.equal(providerUsergroupUpdateAttempts.length, updatesBeforeReplica,
          "the other server reuses this workspace candidate version instead of running the human pass again");
        // Fresh consent invalidates both completed human results and negative
        // write memory even when a shared install keeps the same token.
        await getDb().update(externalAppInstalls).set({ slackMentionCapability: {
          authorizationId: newSlackMentionAuthorizationId(), result: "unverified",
          connectionEpoch: mentionAuthority.connectionEpoch, credentialRevision: mentionAuthority.credentialRevision,
        } }).where(eq(externalAppInstalls.id, install.id));
        await replicaReconcile(mentionAuthority, frozenRequest);
        assert.equal(healthyGroup.name, "Memo Healthy · Raft",
          "fresh consent must bypass the unchanged human snapshot immediately");
        assert.ok(attemptsFor(blockedNames) > refusedAttempts,
          "fresh consent must re-probe unchanged rejected writes before the one-hour deadline");
        refusedAttempts = attemptsFor(blockedNames);
        mentionNow = new Date(memoStartedAt + 6 * 60_000); mentionAuthority.now = mentionNow;
        await replicaReconcile(mentionAuthority, frozenRequest);
        assert.equal(healthyGroup.name, "Memo Healthy · Raft", "after the shared interval another replica can refresh the workspace");
        assert.equal(attemptsFor(blockedNames), refusedAttempts,
          "expired workspace snapshot does not forget rejected candidates or permission failures before one hour");
        mentionNow = new Date(memoStartedAt + 60 * 60_000 + 1); mentionAuthority.now = mentionNow;
        await replicaReconcile(mentionAuthority, frozenRequest);
        assert.ok(attemptsFor(blockedNames) > refusedAttempts, "one-hour expiry permits recovery attempts");
        const renamedBlocked = { ...memoBlocked, name: "memo-name-change", displayName: "Memo Name Change" };
        const changedHumans = memoHumans.map((h) => h.userId === memoBlocked.userId ? renamedBlocked : h);
        const changedMemo = await replicaReconcile(mentionAuthority, { ...frozenRequest, humanCandidates: changedHumans });
        assert.ok(changedMemo.kind === "fact" && changedMemo.fact.humanHandles?.some((h) => h.userId === memoBlocked.userId),
          "changed candidates invalidate both deduplication and the old rejected write fingerprint immediately");

        healthyGroup.date_delete = 1;
        providerEnableFail = true;
        mentionNow = new Date(mentionNow.getTime() + 6 * 60_000); mentionAuthority.now = mentionNow;
        await replicaReconcile(mentionAuthority, { ...frozenRequest, humanCandidates: changedHumans });
        const [disabledIdentity] = await getDb().select().from(slackUsergroupIdentities).where(and(
          eq(slackUsergroupIdentities.installId, install.id), eq(slackUsergroupIdentities.principalId, memoHealthy.userId),
        ));
        assert.equal(disabledIdentity?.humanCanonical, false,
          "a disabled group cannot remain a new outbound destination while enable permission is refused/backed off");
        providerEnableFail = false;
        mentionNow = new Date(mentionNow.getTime() + 61 * 60_000); mentionAuthority.now = mentionNow;
        await replicaReconcile(mentionAuthority, { ...frozenRequest, humanCandidates: changedHumans });

        // 429 stops agents, humans and cleanup, and fences every replica until
        // Retry-After expires, even if a different server requests a pass.
        const rateAgent = { ...withHuman.candidates[0]!, agentId: "00000000-0000-4000-8000-000000000999", name: "rate-limit-first", displayName: "Rate Limit First" };
        const afterRateHuman = { ...memoHealthy, userId: randomUUID(), name: "not-sent-after429", displayName: "After Rate Limit" };
        const rateRequest = { serverId: server.id, candidates: [rateAgent, ...withHuman.candidates], humanCandidates: [...changedHumans, afterRateHuman] };
        const createsBefore429 = providerUsergroupCreateAttempts.length;
        const updatesBefore429 = providerUsergroupUpdateAttempts.length;
        const disablesBefore429 = providerUsergroupDisableCalls;
        const limitedAt = mentionNow.getTime();
        rateLimitNextGroupCreate = true;
        assert.equal((await frozenReconcile(mentionAuthority, rateRequest)).kind, "unverified");
        assert.equal(providerUsergroupCreateAttempts.length, createsBefore429 + 1, "no later principal is attempted after 429");
        assert.equal(providerUsergroupUpdateAttempts.length, updatesBefore429);
        assert.equal(providerUsergroupDisableCalls, disablesBefore429, "cleanup also stops on 429");
        const listsAfter429 = providerUsergroupListCalls;
        assert.equal((await replicaReconcile(mentionAuthority, { serverId: otherServerId, candidates: [] })).kind, "unverified");
        mentionNow = new Date(limitedAt + 119_999); mentionAuthority.now = mentionNow;
        assert.equal((await replicaReconcile(mentionAuthority, rateRequest)).kind, "unverified");
        assert.equal(providerUsergroupListCalls, listsAfter429, "no sync API call occurs before Retry-After, including from a new replica");
        mentionNow = new Date(limitedAt + 120_001); mentionAuthority.now = mentionNow;
        const resumed = await replicaReconcile(mentionAuthority, rateRequest);
        assert.ok(resumed.kind === "fact" && resumed.fact.humanHandles?.some((h) => h.userId === afterRateHuman.userId),
          "the pass resumes after Retry-After and reaches later healthy humans");
        const probeIds = [memoBlocked.userId, memoPermission.userId, memoHealthy.userId, afterRateHuman.userId, rateAgent.agentId];
        const probeRows = await getDb().delete(slackUsergroupIdentities)
          .where(and(eq(slackUsergroupIdentities.installId, install.id), inArray(slackUsergroupIdentities.principalId, probeIds))).returning();
        const probeGroupIds = new Set(probeRows.map((row) => row.providerUsergroupId));
        providerUsergroups.splice(0, providerUsergroups.length, ...providerUsergroups.filter((group) => !probeGroupIds.has(group.id)));
      } finally {
        await replica.stop();
        // This probe advanced only its injected clock. Restore the shared
        // fixture before the HTTP app continues on its real clock below.
        await getDb().update(externalAppInstalls).set({ slackMentionRateLimitedUntil: null })
          .where(eq(externalAppInstalls.id, install.id));
      }

      const batchHumans = Array.from({ length: 202 }, (_, index) => ({
        ...withHuman.humanCandidates[0]!, userId: randomUUID(), name: `batch-human-${index}`, displayName: `Batch Human ${index}`,
      }));
      const fullWorkspaceHumans = [...withHuman.humanCandidates, ...batchHumans];
      const batchResult = await reconcileMentions(mentionAuthority, {
        serverId: server.id, candidates: withHuman.candidates, humanCandidates: fullWorkspaceHumans,
      });
      assert.ok(batchResult.kind === "fact");
      assert.ok(providerUsergroups.filter((group) => group.handle.startsWith("batch-human-")).every((group) => group.date_delete === 0),
        "complete workspace membership protects all still-needed groups from retirement");
      assert.equal(batchResult.fact.humanHandles?.length, fullWorkspaceHumans.length,
        "workspace membership larger than 200 is reconciled without truncation");
      const batchIds = batchHumans.map((human) => human.userId);
      await getDb().delete(slackUsergroupIdentities).where(and(eq(slackUsergroupIdentities.installId, install.id), inArray(slackUsergroupIdentities.principalId, batchIds)));
      providerUsergroups.splice(0, providerUsergroups.length, ...providerUsergroups.filter((group) => !group.handle.startsWith("batch-human-")));


      assert.ok(humanReconcile.kind === "fact" && humanReconcile.fact.humanHandles?.some((handle) => (
        handle.userId === mentionHuman!.id && handle.providerUsergroupId === humanGroup.id
      )));
      assert.equal(providerUsergroups[0]?.name, "Production Agent (agent) · Slack Production Composition");
      assert.equal(providerUsergroups[0]?.handle, "production-agent");
      assert.equal(providerUsergroups[0]?.date_delete, 0);

      const resolvedHumanHandles = await runtime!.inboundWorkerDependencies
        .resolveProviderAgentMentionHandles!({
          eventId: "event-human-handle-resolution",
          frozenAuthority: {
            runtimeRevision: "runtime-human-handle-resolution",
            provider: "slack",
            environment: "test",
            appRegistrationId: registration.id,
            installId: install.id,
            workspaceId: install.providerAuthorityId,
            providerAuthorityId: install.providerAuthorityId,
            providerConversationId: binding.providerConversationId,
            bindingId: binding.id,
            bindingEpoch: binding.bindingEpoch,
            connectionEpoch: install.connectionEpoch,
            raftChannelId: binding.channelId,
            privacyClass: binding.privacyClass,
          },
          providerUsergroupIds: ["SPRODUCTION1", humanGroup.id, "SFOREIGNGROUP"],
        });
      assert.deepEqual(resolvedHumanHandles, [
        { agentId: mentionAgent.id, providerUsergroupId: "SPRODUCTION1", handle: "production-agent" },
        { userId: mentionHuman!.id, providerUsergroupId: humanGroup.id, handle: mentionHuman!.name },
      ]);

      // An Agent-only reconcile never disables human groups.
      assert.equal((await reconcileMentions(
        mentionAuthority,
        { serverId: server.id, candidates: withHuman.candidates },
      )).kind, "fact");
      assert.equal(humanGroup.date_delete, 0);

      // The human leaving every paired channel disables only their group.
      await getDb().delete(channelHumans).where(and(
        eq(channelHumans.channelId, raftChannel.id),
        eq(channelHumans.userId, mentionHuman!.id),
      ));
      const withoutHuman = await listSlackBridgeMentionCandidates(getDb(), server.id, activeBindings);
      assert.ok(withoutHuman.humanCandidates.every((candidate) => candidate.userId !== mentionHuman!.id));
      assert.equal((await reconcileMentions(
        mentionAuthority,
        { serverId: server.id, ...withoutHuman },
      )).kind, "fact");
      assert.equal(humanGroup.date_delete, 1);
      assert.equal(providerUsergroups[0]?.date_delete, 0, "the Agent group stays enabled");
      const foreignGroup = providerUsergroups.find((group) => group.id === "SFOREIGNGROUP");
      assert.deepEqual(foreignGroup, {
        id: "SFOREIGNGROUP",
        name: "Design Team",
        handle: "design-team",
        description: "ordinary Slack group",
        date_delete: 0,
      });

      // Two replicas racing a create can leave a second group with the same
      // exact marker. The reconcile keeps one deterministically (enabled,
      // then lowest id) and disables the duplicate instead of failing every
      // pass; a group that merely shares the name, without our marker, is
      // never touched.
      const agentGroup = providerUsergroups[0]!;
      providerUsergroups.push({
        id: "SZDUPLICATE",
        name: "Production Agent duplicate",
        handle: "production-agent-duplicate",
        description: `raft-agent:${server.id}:${mentionAgent.id}`,
        date_delete: 0,
      }, {
        id: "SFOREIGNSAMENAME",
        name: agentGroup.name,
        handle: "someone-elses-group",
        description: "Raft agent",
        date_delete: 0,
      });
      const healed = await reconcileMentions(
        mentionAuthority,
        { serverId: server.id, ...withoutHuman },
      );
      assert.ok(healed.kind === "fact", `duplicate markers heal instead of failing: ${JSON.stringify(healed)}`);
      assert.ok(healed.fact.handles.some((handle) => handle.providerUsergroupId === agentGroup.id));
      assert.equal(agentGroup.date_delete, 0);
      assert.equal(providerUsergroups.find((group) => group.id === "SZDUPLICATE")?.date_delete, 1);
      assert.equal(providerUsergroups.find((group) => group.id === "SFOREIGNSAMENAME")?.date_delete, 0);
      providerUsergroupUpdateAttempts.length = 0;
      const healedAgain = await reconcileMentions(
        mentionAuthority,
        { serverId: server.id, ...withoutHuman },
      );
      assert.ok(healedAgain.kind === "fact");
      assert.deepEqual(healedAgain.fact.failures, []);
      assert.deepEqual(providerUsergroupUpdateAttempts, [], "a healed duplicate needs no further write");
      providerUsergroups.splice(providerUsergroups.findIndex((group) => group.id === "SZDUPLICATE"), 1);
      providerUsergroups.splice(providerUsergroups.findIndex((group) => group.id === "SFOREIGNSAMENAME"), 1);

      // Slack refusing a handle as taken (e.g. it equals a Slack username)
      // moves that principal to its next handle candidate; a non-naming
      // failure does not cycle candidates; exhausting every candidate is
      // reported as a naming gap, not a failure.
      assert.equal(slackUsergroupNamingConflict("name_already_exists"), "name");
      assert.equal(slackUsergroupNamingConflict("handle_already_exists"), "handle");
      assert.equal(slackUsergroupNamingConflict("invalid_name_specials"), "name");
      assert.equal(slackUsergroupNamingConflict("ratelimited"), null);
      assert.equal(slackUsergroupNamingConflict("missing_scope"), null);
      const seedChannelHuman = async (prefix: string) => {
        const [user] = await getDb().insert(users).values({
          email: `slack-composition-${prefix}-${randomUUID()}@raft.test`,
          name: `${prefix}-${randomUUID().slice(0, 8)}`,
          passwordHash: "not-used",
          emailVerified: true,
        }).returning();
        await getDb().insert(channelHumans).values({ channelId: raftChannel.id, userId: user!.id });
        return user!;
      };
      const refusedHuman = await seedChannelHuman("production-refused");
      const permissionHuman = await seedChannelHuman("production-permission");
      const exhaustedHuman = await seedChannelHuman("production-exhausted");
      const handleCandidatesOf = (user: { id: string; name: string }) => slackHumanHandleCandidates({
        name: user.name,
        userId: user.id,
      });
      const refusedCandidates = handleCandidatesOf(refusedHuman);
      const permissionCandidates = handleCandidatesOf(permissionHuman);
      const exhaustedCandidates = handleCandidatesOf(exhaustedHuman);
      providerUsergroupCreateRefusals.set(refusedCandidates[0]!, "name_already_exists");
      providerUsergroupCreateRefusals.set(permissionCandidates[0]!, "missing_scope");
      for (const handle of exhaustedCandidates) {
        providerUsergroupCreateRefusals.set(handle, "handle_already_exists");
      }
      providerUsergroupCreateAttempts.length = 0;
      const withRefusals = await listSlackBridgeMentionCandidates(getDb(), server.id, activeBindings);
      const refusalReconcile = await reconcileMentions(
        mentionAuthority,
        { serverId: server.id, ...withRefusals },
      );
      assert.equal(refusalReconcile.kind, "fact");
      assert.ok(refusalReconcile.kind === "fact");
      const refusedGroup = providerUsergroups.find((group) => (
        refusalReconcile.fact.humanHandles?.some((handle) => handle.userId === refusedHuman.id && handle.providerUsergroupId === group.id)
      ));
      assert.equal(refusedGroup?.handle, refusedCandidates[1], "refused bare handle falls back to the server-suffixed one");
      assert.ok(refusalReconcile.fact.humanHandles?.some((handle) => handle.userId === refusedHuman.id));
      assert.deepEqual(
        providerUsergroupCreateAttempts.filter((handle) => permissionCandidates.includes(handle)),
        [permissionCandidates[0]],
        "a non-naming failure never cycles handle candidates",
      );
      assert.ok(providerUsergroups.every((group) => (
        !permissionCandidates.includes(group.handle)
      )));
      assert.deepEqual(
        providerUsergroupCreateAttempts.filter((handle) => exhaustedCandidates.includes(handle)),
        exhaustedCandidates,
      );
      // Failures cover both principal kinds: exhausting every candidate is
      // reported as `name_taken` (the settings banner's collision hint).
      assert.deepEqual(
        [...refusalReconcile.fact.failures].sort((left, right) => (
          String(left.userId).localeCompare(String(right.userId))
        )),
        [
          { userId: exhaustedHuman.id, slackError: "name_taken", transient: false },
          { userId: permissionHuman.id, slackError: "missing_scope", transient: false },
        ].sort((left, right) => left.userId.localeCompare(right.userId)),
      );
      // Convergence: with Slack still refusing the bare handle (a Slack
      // username, invisible to usergroups.list), the next pass keeps the
      // fallback the refused human already holds — no write, no failure —
      // instead of re-sending the refused write on every tick.
      providerUsergroupCreateAttempts.length = 0;
      providerUsergroupUpdateAttempts.length = 0;
      const settledReconcile = await reconcileMentions(
        mentionAuthority,
        { serverId: server.id, ...withRefusals },
      );
      assert.ok(settledReconcile.kind === "fact");
      assert.equal(refusedGroup?.handle, refusedCandidates[1]);
      assert.ok(settledReconcile.fact.humanHandles?.some((handle) => (
        handle.userId === refusedHuman.id && handle.handle === refusedCandidates[1]
      )));
      assert.deepEqual(
        [...providerUsergroupCreateAttempts, ...providerUsergroupUpdateAttempts]
          .filter((handle) => refusedCandidates.includes(handle)),
        [],
        "a settled fallback handle sends no further write",
      );
      assert.ok(settledReconcile.fact.failures.every((failure) => failure.userId !== refusedHuman.id));
      // Only the exhausted human stays (with its refusals) for the lifecycle
      // persistence check below.
      for (const handle of [...providerUsergroupCreateRefusals.keys()]) {
        if (!exhaustedCandidates.includes(handle)) providerUsergroupCreateRefusals.delete(handle);
      }
      await getDb().delete(channelHumans).where(and(
        eq(channelHumans.channelId, raftChannel.id),
        inArray(channelHumans.userId, [refusedHuman.id, permissionHuman.id]),
      ));
      exhaustedHumanId = exhaustedHuman.id;
    } finally {
      await mentionProbe.stop();
    }
    await getDb().update(agents).set({ displayName: "Production Agent Lifecycle" })
      .where(eq(agents.id, mentionAgent.id));
    const receipts = await getDb().select().from(externalAppInstallGrantReceipts)
      .where(eq(externalAppInstallGrantReceipts.installId, install.id));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.providerBotId, "B_PRODUCTION_BOT");
    assert.deepEqual(receipts[0]?.grantedScopes, [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES].sort());
    assert.equal(receipts[0]?.observationSource, "token_introspection");

    const [readyPartition] = await getDb().select().from(externalDeliveryPartitions).where(and(
      eq(externalDeliveryPartitions.bindingId, binding.id),
      eq(externalDeliveryPartitions.bindingEpoch, binding.bindingEpoch),
    ));
    assert.ok(readyPartition, "binding activation must atomically establish delivery readiness");
    assert.equal(readyPartition.lastEnqueuedPosition, 0);
    assert.equal(readyPartition.cursorPosition, 0);

    const seededDelivery = await getDb().transaction(async (tx) => {
      const [source] = await tx.insert(messages).values({
        channelId: raftChannel.id,
        senderType: "user",
        senderId: owner.id,
        messageType: "chat",
        content: "completed delivery retained across repeated enable",
      }).returning();
      await tx.update(externalDeliveryPartitions).set({
        lastEnqueuedPosition: 1,
        cursorPosition: 1,
      }).where(eq(externalDeliveryPartitions.id, readyPartition.id));
      const [delivery] = await tx.insert(externalOutboundDeliveries).values({
        sourceMessageId: source.id,
        bindingId: binding.id,
        bindingEpoch: binding.bindingEpoch,
        partitionPosition: 1,
        enqueueRuntimeRevision: "test-runtime-revision",
        state: "accepted",
        renderSnapshotSchema: "slack-bridge-render-snapshot.v3",
        renderSnapshot: { testOnly: true },
        renderSnapshotDigest: "a".repeat(64),
        reconciliationMarker: "A".repeat(43),
        providerAttempts: 1,
        ambiguityBudgetProviderAttempts: 1,
        firstDispatchedAt: new Date(),
        providerMessageId: "1788541200.000001",
        acceptedAt: new Date(),
        stateReason: "provider_accepted",
      }).returning();
      await tx.insert(externalMessageLinks).values({
        deliveryId: delivery.id,
        provider: "slack",
        installId: install.id,
        providerAuthorityId: install.providerAuthorityId,
        providerConversationId: binding.providerConversationId,
        providerMessageId: delivery.providerMessageId,
        providerThreadId: null,
        bindingId: binding.id,
        bindingEpoch: binding.bindingEpoch,
        connectionEpoch: binding.connectionEpoch,
        raftMessageId: source.id,
        raftCanonicalRootMessageId: null,
        firstDirection: "raft_outbound",
        payloadFingerprint: delivery.renderSnapshotDigest,
        outcomeState: "accepted",
        authorityState: "active",
        stateReason: "provider_accepted",
      });
      return delivery;
    });

    const repeatEnable = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
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
    const [preservedPartition] = await getDb().select().from(externalDeliveryPartitions).where(
      eq(externalDeliveryPartitions.id, readyPartition.id),
    );
    assert.equal(preservedPartition?.lastEnqueuedPosition, 1);
    assert.equal(preservedPartition?.cursorPosition, 1);
    assert.equal(
      (await getDb().select().from(externalOutboundDeliveries)
        .where(eq(externalOutboundDeliveries.id, seededDelivery.id))).length,
      1,
      "repeated enable must not replace or reset an existing nonzero delivery partition",
    );

    await getDb().delete(externalAddressabilityProjections).where(eq(
      externalAddressabilityProjections.id,
      addressesAfterPreflight[0]!.id,
    ));
    const addresslessLoad = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
    assert.equal(addresslessLoad.status, 200, await addresslessLoad.clone().text());
    assert.equal(
      (await addresslessLoad.json() as { snapshot: { stage: string } }).snapshot.stage,
      "enable",
      "active setup must not report health after exact addressability disappears",
    );
    const repairAddress = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
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
    const actorlessLoad = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
    assert.equal(actorlessLoad.status, 200, await actorlessLoad.clone().text());
    assert.equal(
      (await actorlessLoad.json() as { snapshot: { stage: string } }).snapshot.stage,
      "enable",
      "active setup must not report health after exact actor authority disappears",
    );
    const repairActor = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
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
        text: "production composition <!subteam^SPRODUCTION1|@production-agent>",
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
    const firstInbound = await appFetch(`${app.baseUrl}/api/slack-bridge/events`, {
      method: "POST",
      headers: eventHeaders,
      body: eventBody,
    });
    assert.equal(firstInbound.status, 200, await firstInbound.clone().text());
    const retryInbound = await appFetch(`${app.baseUrl}/api/slack-bridge/events`, {
      method: "POST",
      headers: {
        ...eventHeaders,
        "X-Slack-Retry-Num": "1",
        "X-Slack-Retry-Reason": "http_timeout",
      },
      body: eventBody,
    });
    assert.equal(retryInbound.status, 200, await retryInbound.clone().text());
    const mentionReconcileDeadline = Date.now() + 2_000;
    while (
      String(providerUsergroups[0]?.name) !== "Production Agent Lifecycle (agent) · Slack Production Composition"
      && Date.now() < mentionReconcileDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      String(providerUsergroups[0]?.name),
      "Production Agent Lifecycle (agent) · Slack Production Composition",
      "an admitted provider event must trigger current Agent handle reconciliation",
    );
    // Mention sync (preflight/enable and the lifecycle tick share
    // slackBridgeMentionSyncState) persists a degraded state for a
    // paired-channel human whose every handle candidate Slack refused:
    // `name_taken`, with Agents and humans counted together.
    const exhaustedSyncDeadline = Date.now() + 2_000;
    let exhaustedSync: typeof externalAppInstallServerGrants.$inferSelect["agentMentionSync"] = null;
    while (Date.now() < exhaustedSyncDeadline) {
      [{ agentMentionSync: exhaustedSync }] = await getDb()
        .select({ agentMentionSync: externalAppInstallServerGrants.agentMentionSync })
        .from(externalAppInstallServerGrants)
        .where(and(eq(externalAppInstallServerGrants.installId, install.id), eq(externalAppInstallServerGrants.serverId, server.id)));
      if (exhaustedSync?.slackError === "name_taken") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(exhaustedHumanId);
    assert.equal(exhaustedSync?.state, "degraded");
    assert.equal(exhaustedSync?.slackError, "name_taken");
    assert.equal(exhaustedSync!.actual, exhaustedSync!.expected - 1);
    assert.ok(exhaustedSync!.expected >= 2, "expected counts the Agent and the human");
    providerUsergroupCreateRefusals.clear();
    await getDb().delete(channelHumans).where(and(
      eq(channelHumans.channelId, raftChannel.id),
      eq(channelHumans.userId, exhaustedHumanId),
    ));
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
    const [agentMention] = await getDb().select().from(messageMentions).where(and(
      eq(messageMentions.messageId, inboundResult.messageId),
      eq(messageMentions.targetType, "agent"),
      eq(messageMentions.targetId, mentionAgent.id),
    ));
    assert.equal(agentMention?.notifiableAtSend, true);
    const [mentionedMessage] = await getDb().select().from(messages)
      .where(eq(messages.id, inboundResult.messageId));
    assert.equal(mentionedMessage?.content, `production composition @${mentionAgent.name}`);

    const tamperedGrantHash = "0".repeat(64);
    await getDb().update(externalAppInstallGrantReceipts).set({
      grantHash: tamperedGrantHash,
    }).where(eq(externalAppInstallGrantReceipts.installId, install.id));
    const repairEnable = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
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
        authorization: `Bearer ${SLACK_XOXB}production-composition`,
        contentType: null,
        query: "file=F_PRODUCTION",
      });
      assert.deepEqual(providerFileDownloads.at(-1), {
        authorization: `Bearer ${SLACK_XOXB}production-composition`,
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
            avatarPublicUrl: "https://cdn.example.test/production-owner.webp",
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
          username: "Production Owner from Raft",
          icon_url: "https://cdn.example.test/production-owner.webp",
        }]);
        for (const [caseName, fallbackKind, displayName, username] of [
          ["human", "human", "Fallback Author", "Fallback Author from Raft"],
          ["agent", "agent", "Fallback Author", "Fallback Author from Raft"],
          ["invalid-name", "human", "Invalid\nName", null],
        ] as const) {
          await outboundAdapter.completeOutboundMessage({
            authority: attachmentAuthority,
            completion: { ...completion, providerFileIds: [`F_AUTHOR_${caseName}`],
              providerRootThreadId: "1788541200.000100",
              author: { displayName, avatarPublicUrl: null, fallbackKind } },
            signal: new AbortController().signal,
          });
          assert.deepEqual(providerCompletionBodies.at(-1), {
            files: [{ id: `F_AUTHOR_${caseName}` }], channel_id: binding.providerConversationId,
            thread_ts: "1788541200.000100", initial_comment: "outbound attachment",
            ...(username ? { username } : {}),
            icon_emoji: fallbackKind === "agent" ? ":robot_face:" : ":bust_in_silhouette:",
          });
        }
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
          authorization: `Bearer ${SLACK_XOXB}production-composition`,
          contentType: null,
          query: "channel=C_PRODUCTION_GENERAL",
        }, "conversation lookup must use Slack's GET-query shape");
      } finally {
        await providerProbe.releaseCredential(conversationCredential);
      }

      const [installServerAssociation] = await getDb().select()
        .from(externalAppInstallServerGrants)
        .where(and(
          eq(externalAppInstallServerGrants.installId, install.id),
          eq(externalAppInstallServerGrants.serverId, binding.serverId),
          eq(externalAppInstallServerGrants.registrationId, binding.registrationId),
        ));
      assert.ok(installServerAssociation);
      await getDb().delete(externalAppInstallServerGrants)
        .where(eq(externalAppInstallServerGrants.id, installServerAssociation.id));
      assert.equal(await providerProbe.credentialResolver.resolve({
        authority: conversationAuthority,
        now: new Date(),
      }), null, "the shared credential resolver must reject a missing install-server association");
      const grantCallsBeforeMissingAssociation = providerAuthTestCalls;
      assert.deepEqual(await providerProbe.provisioningProvider.readInstallGrant({
        installId: install.id,
        providerAppId: install.providerAppId,
        providerAuthorityId: install.providerAuthorityId,
        botUserId: install.botUserId!,
        connectionEpoch: install.connectionEpoch,
        credentialRevision: install.credentialRevision,
        now: new Date(),
      }), { kind: "unverified" });
      assert.equal(
        providerAuthTestCalls,
        grantCallsBeforeMissingAssociation,
        "a workspace-level credential caller must also reject missing install-server authority before Slack I/O",
      );
      await getDb().insert(externalAppInstallServerGrants).values(installServerAssociation);

      await getDb().update(externalAppServerGrants).set({ grantEpoch: grant.grantEpoch + 1 })
        .where(eq(externalAppServerGrants.id, grant.id));
      assert.equal(await providerProbe.credentialResolver.resolve({
        authority: conversationAuthority,
        now: new Date(),
      }), null, "the shared credential resolver must reject a stale install-server association epoch");
      await getDb().update(externalAppServerGrants).set({ grantEpoch: grant.grantEpoch })
        .where(eq(externalAppServerGrants.id, grant.id));

      await getDb().update(externalChannelBindings).set({ grantEpoch: binding.grantEpoch + 1 })
        .where(eq(externalChannelBindings.id, binding.id));
      assert.equal(await providerProbe.credentialResolver.resolve({
        authority: conversationAuthority,
        now: new Date(),
      }), null, "the shared credential resolver must reject a stale binding grant epoch");
      await getDb().update(externalChannelBindings).set({ grantEpoch: binding.grantEpoch })
        .where(eq(externalChannelBindings.id, binding.id));

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
        const rejectedEnable = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
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
    // Every replica runs this lifecycle; only the one holding the install's
    // claim talks to Slack, so replicas do not repeat the same usergroup
    // writes at the same moment.
    assert.ok(mentionReconcileClaims.includes(`${server.id}:${install.id}`));
    const claimsBeforeDenied = mentionReconcileClaims.length;
    const usergroupListsBeforeDenied = providerUsergroupListCalls;
    denyMentionReconcileClaim = true;
    await runtime?.requestLifecycleReconcile?.();
    denyMentionReconcileClaim = false;
    assert.ok(mentionReconcileClaims.length > claimsBeforeDenied, "the reconcile asked for the claim");
    assert.equal(
      providerUsergroupListCalls,
      usergroupListsBeforeDenied,
      "a replica without the install claim sends no Slack usergroup call",
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
        await refreshSlackConversationAuthority({
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

    await runNamedCase("public refresh discards a provider observation when the Server grant drifts in flight", async () => {
      const beforeRows = await readPublicAuthorityRows();
      const callsBefore = providerAudienceCalls;
      const raceProvider = createSlackBridgeProviderRuntime({
        credentialCipher: createSlackBridgeEnvCredentialCipher({
          key: Buffer.from(CREDENTIAL_KEY, "base64"),
        }),
        db: getDb(),
        fetch: providerFetch,
      });
      let responseHookCalled = false;
      beforeAudienceResponse = async () => {
        responseHookCalled = true;
        await getDb().update(externalAppServerGrants).set({
          grantEpoch: grant.grantEpoch + 1,
        }).where(eq(externalAppServerGrants.id, grant.id));
      };
      const observedAt = new Date();
      try {
        const refreshResult = await refreshSlackConversationAuthority({
          db: getDb(),
          provider: raceProvider.provisioningProvider,
          bindingId: binding.id,
          now: observedAt,
        });
        assert.equal(responseHookCalled, true);
        const [driftedGrant] = await getDb().select().from(externalAppServerGrants)
          .where(eq(externalAppServerGrants.id, grant.id));
        assert.equal(driftedGrant.grantEpoch, grant.grantEpoch + 1);
        assert.deepEqual(refreshResult, {
          bindingId: binding.id,
          audienceStatus: "unavailable",
          observedAtMs: observedAt.getTime(),
          reason: "authority_quarantined",
        });
        assert.equal(providerAudienceCalls, callsBefore + 1, "the race must occur after provider I/O");
        assert.deepEqual(
          await readPublicAuthorityRows(),
          beforeRows,
          "an in-flight grant drift must write no actor, address, or audience snapshot authority",
        );
      } finally {
        beforeAudienceResponse = null;
        await raceProvider.stop();
        await getDb().update(externalAppServerGrants).set({
          grantEpoch: grant.grantEpoch,
        }).where(eq(externalAppServerGrants.id, grant.id));
      }
    });

    await runNamedCase("public lifecycle cannot extend authority after the binding grant epoch drifts", async () => {
      await getDb().update(externalChannelBindings).set({
        grantEpoch: binding.grantEpoch + 1,
      }).where(eq(externalChannelBindings.id, binding.id));
      try {
        await assertLifecycleAuthorityRejected("drifted binding grant epoch");
      } finally {
        await getDb().update(externalChannelBindings).set({
          grantEpoch: binding.grantEpoch,
        }).where(eq(externalChannelBindings.id, binding.id));
      }
    });

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

    const repaired = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
    assert.equal(repaired.status, 200, await repaired.clone().text());
    assert.equal((await repaired.json() as { snapshot: { stage: string } }).snapshot.stage, "health");

    const createPrivate = await appFetch(`${app.baseUrl}/api/channels`, {
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
    const additive = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
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

    const additivePreflight = await appFetch(
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

    const additiveEnable = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
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
    const {
      privacyFreshUntil: publicPrivacyFreshBeforeEnable,
      updatedAt: publicUpdatedAtBeforeEnable,
      ...publicStableBeforeEnable
    } = publicBeforeAdditiveEnable;
    const {
      privacyFreshUntil: publicPrivacyFreshAfterEnable,
      updatedAt: publicUpdatedAtAfterEnable,
      ...publicStableAfterEnable
    } = publicAfterAdditiveEnable;
    assert.deepEqual(
      publicStableAfterEnable,
      publicStableBeforeEnable,
      "enabling an additive paused pair must preserve the existing active binding authority",
    );
    assert.ok(
      publicPrivacyFreshAfterEnable >= publicPrivacyFreshBeforeEnable,
      "the background lifecycle may independently extend the verified privacy deadline",
    );
    assert.ok(publicUpdatedAtAfterEnable >= publicUpdatedAtBeforeEnable);
    assert.equal(privateAfterAdditiveEnable.state, "active");
    assert.equal(privateAfterAdditiveEnable.stateReason, null);
    assert.equal(privateAfterAdditiveEnable.bindingEpoch, privateBeforeAdditiveEnable.bindingEpoch);

    await getDb().update(externalChannelBindings).set({
      state: "paused",
      stateReason: "privacy_changed_reconfirmation_required",
    }).where(eq(externalChannelBindings.id, publicAfterAdditiveEnable.id));
    const migrationBlockedHealth = await appFetch(
      `${app.baseUrl}/api/slack-bridge/provisioning`,
      { headers },
    );
    assert.equal(migrationBlockedHealth.status, 200, await migrationBlockedHealth.clone().text());
    const migrationBlockedBody = await migrationBlockedHealth.json() as {
      snapshot: {
        rawHealth: {
          bindings: Array<{
            id: string;
            state: string;
            bindingEpoch: number;
            stateReason: string | null;
            recoveryAction: string;
          }>;
        };
      };
    };
    assert.deepEqual(
      migrationBlockedBody.snapshot.rawHealth.bindings.find(({ id }) =>
        id === publicAfterAdditiveEnable.id),
      {
        id: publicAfterAdditiveEnable.id,
        state: "paused",
        bindingEpoch: publicAfterAdditiveEnable.bindingEpoch,
        stateReason: "privacy_changed_reconfirmation_required",
        recoveryAction: "review_and_resume_binding",
      },
      "owner provisioning health must expose the actionable privacy reconfirmation block",
    );
    await getDb().update(externalChannelBindings).set({
      state: "active",
      stateReason: null,
    }).where(eq(externalChannelBindings.id, publicAfterAdditiveEnable.id));

    const visibleChannels = await appFetch(`${app.baseUrl}/api/channels`, { headers });
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
    // An installation waiting for reauthorization stops every pair it carries,
    // even pairs whose own binding is still active.
    const [installBeforeChannelReauth] = await getDb().select().from(externalAppInstalls)
      .where(eq(externalAppInstalls.id, install.id));
    await getDb().update(externalAppInstalls).set({ state: "reauth_required", stateReason: "provider_credential_revoked" })
      .where(eq(externalAppInstalls.id, install.id));
    const reauthChannels = await appFetch(`${app.baseUrl}/api/channels`, { headers });
    assert.equal(reauthChannels.status, 200, await reauthChannels.clone().text());
    assert.deepEqual(
      (await reauthChannels.json() as typeof visibleChannelBody).find((channel) => channel.id === raftChannel.id)?.bridge,
      {
        provider: "slack",
        providerConversationId: "C_PRODUCTION_GENERAL",
        state: "active",
        installState: "reauth_required",
      },
      "channel readers must see that the installation stopped the pair",
    );
    await getDb().update(externalAppInstalls).set({
      state: installBeforeChannelReauth!.state, stateReason: installBeforeChannelReauth!.stateReason,
    })
      .where(eq(externalAppInstalls.id, install.id));

    const visiblePrivateMembers = await appFetch(
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

    const retirePrivateBeforeRepair = await appFetch(
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

    const repairWithRetiredSibling = await appFetch(
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

    const restorePrivateAfterRepair = await appFetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`,
      { method: "PUT", headers, body: JSON.stringify({ pairs: additivePairs }) },
    );
    assert.equal(
      restorePrivateAfterRepair.status,
      200,
      await restorePrivateAfterRepair.clone().text(),
    );
    const restorePrivatePreflight = await appFetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/preflight`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(
      restorePrivatePreflight.status,
      200,
      await restorePrivatePreflight.clone().text(),
    );
    const restorePrivateEnable = await appFetch(
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

    const createSecondPrivate = await appFetch(`${app.baseUrl}/api/channels`, {
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
    const addBesideQuarantined = await appFetch(
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

    const createOtherPublic = await appFetch(`${app.baseUrl}/api/channels`, {
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
    const omittedActive = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
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
        const rejected = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
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
    const staleAtomicRemoval = await appFetch(
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

    const wrongCoordinateRemoval = await appFetch(
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
    const pausedRemoval = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
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

    const repeatedRemoval = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
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

    const readdPrivate = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
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
    const quarantinedRemoval = await appFetch(
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
    const activeRemoval = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
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
    const replaceAfterOfficialRemoval = await appFetch(
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

    const removeReplacement = await appFetch(
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

    const readdPublic = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
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
    const rejectedSecurityRevival = await appFetch(
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

    const [partitionOwner] = await getDb().insert(users).values({
      email: `slack-partition-${randomUUID()}@raft.test`,
      name: `slack-partition-${randomUUID().slice(0, 8)}`,
      passwordHash: "test-only",
      emailVerified: true,
    }).returning();
    const partitionServer = await createServer(
      "Slack Partition B",
      `slack-partition-${randomUUID()}`,
      partitionOwner.id,
    );
    await getDb().insert(oauthClientInstalls).values({
      serverId: partitionServer.id,
      clientId: client.id,
      installedByUserId: partitionOwner.id,
    });
    const [partitionGrant] = await getDb().insert(externalAppServerGrants).values({
      serverId: partitionServer.id,
      registrationId: registration.id,
      state: "active",
      grantEpoch: 1,
      grantedManifestVersion: registration.capabilityManifestVersion,
      grantedManifestHash: registration.capabilityManifestHash,
      grantedCapabilities: registration.requiredCapabilities,
      grantedByType: "human",
      grantedById: partitionOwner.id,
    }).returning();
    const [partitionAssociation] = await getDb().insert(externalAppInstallServerGrants).values({
      installId: install.id,
      serverId: partitionServer.id,
      registrationId: registration.id,
      serverGrantId: partitionGrant.id,
      grantEpoch: partitionGrant.grantEpoch,
      state: "active",
      authorizedByType: "human",
      authorizedById: partitionOwner.id,
    }).returning();
    const [partitionChannel] = await getDb().insert(channels).values({
      serverId: partitionServer.id,
      name: `slack-partition-${randomUUID().slice(0, 8)}`,
      type: "channel",
    }).returning();
    const [partitionBinding] = await getDb().insert(externalChannelBindings).values({
      serverId: partitionServer.id,
      registrationId: registration.id,
      installId: install.id,
      channelId: partitionChannel.id,
      providerConversationId: "C_PRODUCTION_PARTITION_B",
      providerConversationKind: "public_channel",
      privacyClass: "public",
      privacyFreshUntil: new Date(Date.now() + 60 * 60_000),
      state: "active",
      grantEpoch: partitionGrant.grantEpoch,
      connectionEpoch: install.connectionEpoch,
      bindingEpoch: 1,
      consentedByType: "human",
      consentedById: partitionOwner.id,
      consentedAt: new Date(),
    }).returning();

    const readDisconnectAuthority = async () => ({
      grant: (await getDb().select().from(externalAppServerGrants)
        .where(eq(externalAppServerGrants.id, grant.id)))[0],
      install: (await getDb().select().from(externalAppInstalls)
        .where(eq(externalAppInstalls.id, install.id)))[0],
      credential: (await getDb().select().from(externalAppCredentials)
        .where(eq(externalAppCredentials.installId, install.id)))[0],
      installServerGrants: await getDb().select().from(externalAppInstallServerGrants)
        .where(eq(externalAppInstallServerGrants.installId, install.id))
        .orderBy(externalAppInstallServerGrants.serverId),
      bindings: await getDb().select().from(externalChannelBindings)
        .where(eq(externalChannelBindings.installId, install.id)),
      links: await getDb().select().from(externalHumanIdentityLinks)
        .where(eq(externalHumanIdentityLinks.installId, install.id)),
      clientInstall: (await getDb().select().from(oauthClientInstalls).where(and(
        eq(oauthClientInstalls.serverId, server.id),
        eq(oauthClientInstalls.clientId, client.id),
      )))[0],
    });

    const liveAuthorityBeforeWrongEpoch = await readDisconnectAuthority();
    const providerCallsBeforeDisconnect = providerQueryRequests.length;
    const wrongEpochDisconnect = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/disconnect`, {
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

    const disconnected = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/disconnect`, {
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
    const associationsAfterDisconnect = await getDb().select().from(externalAppInstallServerGrants)
      .where(eq(externalAppInstallServerGrants.installId, install.id))
      .orderBy(externalAppInstallServerGrants.serverId);
    const bindingsAfterDisconnect = await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.installId, install.id));
    const linksAfterDisconnect = await getDb().select().from(externalHumanIdentityLinks)
      .where(eq(externalHumanIdentityLinks.installId, install.id));
    const [clientInstallAfterDisconnect] = await getDb().select().from(oauthClientInstalls)
      .where(and(
        eq(oauthClientInstalls.serverId, server.id),
        eq(oauthClientInstalls.clientId, client.id),
      ));
    assert.equal(grantAfterDisconnect.state, "revoked");
    assert.equal(grantAfterDisconnect.revokeReason, "manager_unbound_workspace");
    assert.equal(installAfterDisconnect.state, "active");
    assert.equal(installAfterDisconnect.stateReason, null);
    assert.equal(installAfterDisconnect.connectionEpoch, install.connectionEpoch);
    assert.equal(credentialAfterDisconnect.state, "active");
    assert.equal(credentialAfterDisconnect.revokedAt, null);
    assert.equal(
      associationsAfterDisconnect.find((row) => row.serverId === server.id)?.state,
      "revoked",
    );
    assert.equal(
      associationsAfterDisconnect.find((row) => row.id === partitionAssociation.id)?.state,
      "active",
    );
    assert.equal(bindingsAfterDisconnect.some((row) =>
      row.serverId === server.id && ["active", "paused", "quarantined"].includes(row.state)), false);
    assert.ok(bindingsAfterDisconnect.some((row) =>
      row.serverId === server.id && row.stateReason === "manager_unbound_workspace"));
    assert.equal(
      bindingsAfterDisconnect.find((row) => row.id === partitionBinding.id)?.state,
      "active",
      "disconnecting one server must preserve another server's partition",
    );
    assert.deepEqual(
      bindingsAfterDisconnect.find((row) => row.id === securityRevoked.id),
      securityRevoked,
      "disconnect must preserve a prior security revocation reason byte-equivalent",
    );
    assert.equal(linksAfterDisconnect.some((row) => row.state === "active"), false);
    assert.equal(clientInstallAfterDisconnect.status, "suspended");
    assert.equal((await resolveExternalBindingAuthority({
      serverId: partitionServer.id,
      bindingId: partitionBinding.id,
      expectedConnectionEpoch: partitionBinding.connectionEpoch,
      expectedBindingEpoch: partitionBinding.bindingEpoch,
      now: new Date(),
    })).active, true, "the surviving server partition must remain authorized");

    const disconnectState = {
      grant: grantAfterDisconnect,
      install: installAfterDisconnect,
      credential: credentialAfterDisconnect,
      installServerGrants: associationsAfterDisconnect,
      bindings: bindingsAfterDisconnect,
      links: linksAfterDisconnect,
      clientInstall: clientInstallAfterDisconnect,
    };
    const staleDisconnect = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/disconnect`, {
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

    const reconnect = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/connect`, {
      method: "POST",
      headers,
    });
    assert.equal(reconnect.status, 200, await reconnect.clone().text());
    const reconnectBody = await reconnect.json() as {
      snapshot: { stage: string };
      oauthAuthority: { registrationId: string; serverGrantId: string; grantEpoch: number };
    };
    assert.equal(reconnectBody.snapshot.stage, "oauth");

    const reconnectOauthStart = await appFetch(`${app.baseUrl}/api/slack-bridge/oauth/start`, {
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
    const reconnectCallback = await appFetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(reconnectState)}&code=production-composition-reconnect-code`,
      { redirect: "manual", headers: { Cookie: oauthBindingCookie(reconnectOauthStart) } },
    );
    assert.equal(reconnectCallback.status, 302, await reconnectCallback.clone().text());

    const reconnectedProvisioning = await appFetch(
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

    const reconnectedPairs = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
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
      row.serverId === server.id
      && row.connectionEpoch === installAfterDisconnect.connectionEpoch + 1
      && row.state === "paused");
    assert.equal(currentReconnectBindings.length, 1);
    const partitionAfterReconnect = bindingsAfterReconnect.find((row) => row.id === partitionBinding.id);
    assert.ok(partitionAfterReconnect);
    assert.equal(partitionAfterReconnect.state, "paused");
    assert.equal(partitionAfterReconnect.stateReason, "provider_reauthorized_review_required");
    assert.equal(partitionAfterReconnect.connectionEpoch, installAfterDisconnect.connectionEpoch + 1);
    assert.deepEqual(await resolveExternalBindingAuthority({
      serverId: partitionServer.id,
      bindingId: partitionBinding.id,
      expectedConnectionEpoch: partitionAfterReconnect.connectionEpoch,
      expectedBindingEpoch: partitionAfterReconnect.bindingEpoch,
      now: new Date(),
    }), { active: false, reason: "binding_inactive" },
    "workspace reconnect must freeze every server partition at the new epoch");

    const reconnectPreflight = await appFetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/preflight`,
      { method: "POST", headers },
    );
    assert.equal(reconnectPreflight.status, 200, await reconnectPreflight.clone().text());
    assert.equal(
      (await reconnectPreflight.json() as { snapshot: { stage: string } }).snapshot.stage,
      "enable",
    );
    const reconnectEnable = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning/enable`, {
      method: "POST",
      headers,
    });
    assert.equal(reconnectEnable.status, 200, await reconnectEnable.clone().text());
    assert.equal(
      (await reconnectEnable.json() as { snapshot: { stage: string } }).snapshot.stage,
      "health",
    );

    // Re-authorizing the connected workspace (task #225: pick up new scopes
    // without disconnecting) must keep this server's channel pairs live: the
    // OAuth callback resumes the bindings the exchange paused.
    const [installBeforeReauth] = await getDb().select().from(externalAppInstalls)
      .where(eq(externalAppInstalls.id, install.id));
    const healthyBindingsBeforeReauth = (await getDb().select().from(externalChannelBindings)
      .where(and(
        eq(externalChannelBindings.serverId, server.id),
        eq(externalChannelBindings.installId, install.id),
        eq(externalChannelBindings.connectionEpoch, installBeforeReauth.connectionEpoch),
        eq(externalChannelBindings.state, "active"),
      ))).map((row) => row.id).sort();
    assert.ok(healthyBindingsBeforeReauth.length > 0);
    const healthyLoad = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
    assert.equal(healthyLoad.status, 200, await healthyLoad.clone().text());
    const healthyBody = await healthyLoad.json() as {
      snapshot: { stage: string };
      oauthAuthority: { registrationId: string; serverGrantId: string; grantEpoch: number } | null;
    };
    assert.equal(healthyBody.snapshot.stage, "health");
    assert.ok(healthyBody.oauthAuthority, "a connected workspace must expose re-authorization authority");
    const reauthStart = await appFetch(`${app.baseUrl}/api/slack-bridge/oauth/start`, {
      method: "POST",
      headers,
      body: JSON.stringify(healthyBody.oauthAuthority),
    });
    assert.equal(reauthStart.status, 201, await reauthStart.clone().text());
    const reauthState = new URL(
      (await reauthStart.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state");
    assert.ok(reauthState);
    const reauthCallback = await appFetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(reauthState)}&code=production-composition-reauthorize-code`,
      { redirect: "manual", headers: { Cookie: oauthBindingCookie(reauthStart) } },
    );
    assert.equal(reauthCallback.status, 302, await reauthCallback.clone().text());
    const [installAfterReauth] = await getDb().select().from(externalAppInstalls)
      .where(eq(externalAppInstalls.id, install.id));
    assert.equal(installAfterReauth.state, "active");
    assert.equal(installAfterReauth.connectionEpoch, installBeforeReauth.connectionEpoch + 1);
    assert.equal(installAfterReauth.scopeRevision, installBeforeReauth.scopeRevision + 1);
    const bindingsAfterReauth = await getDb().select().from(externalChannelBindings)
      .where(and(
        eq(externalChannelBindings.serverId, server.id),
        eq(externalChannelBindings.installId, install.id),
        eq(externalChannelBindings.connectionEpoch, installAfterReauth.connectionEpoch),
      ));
    assert.deepEqual(
      bindingsAfterReauth.filter((row) => row.state === "active").map((row) => row.id).sort(),
      healthyBindingsBeforeReauth,
      "re-authorization must resume the same bindings, not recreate or drop them",
    );
    assert.equal(bindingsAfterReauth.some((row) => row.state === "paused"), false);
    const afterReauthLoad = await appFetch(`${app.baseUrl}/api/slack-bridge/provisioning`, { headers });
    assert.equal(
      (await afterReauthLoad.json() as { snapshot: { stage: string } }).snapshot.stage,
      "health",
    );
  } finally {
    await app.close();
    await runtime?.stop();
  }
});

test("deleting the production provisioning injection makes all seven endpoints fail closed", async () => {
  let runtime: Awaited<ReturnType<typeof createSlackBridgeServerRuntimeFromEnv>>;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, async slackBridgeFactory() {
      runtime = await createSlackBridgeServerRuntimeFromEnv(PRODUCTION_ENV, { db: getDb() });
      assert.ok(runtime);
      return { ...runtime, provisioning: undefined };
    } });
  try {
    const { owner, server } = await seedOwner();
    const headers = await requestHeaders(owner.id, server.id);
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
