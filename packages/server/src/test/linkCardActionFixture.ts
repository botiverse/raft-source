import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { LINK_CARD_OPERATION_CHANGED_EVENT } from "@botiverse/raft-shared/src/appLinkPreview";
import type { Database } from "../db/index";
import {
  channels, featureFlagRules, linkCardOperations, oauthAppLinkPreviews, oauthClientInstalls, oauthUserConsents, officialAppRegistry, servers, users,
} from "../db/schema";
import { canonicalJsonSha256 } from "../lib/canonicalJson";
import { __setPreviewHttpForTests } from "../services/appLinkPreviewService";
import type { PreviewHttpOptions } from "../services/appLinkPreviewHttp";
import {
  linkCardActionEndpointSha256, linkCardMessageContentSha256, linkCardUrlSha256, newLinkCardViewNonce, signLinkCardHandle, type LinkCardHandleClaims,
} from "../services/linkCardTokens";
import { createOAuthClient } from "../services/oauthService";
import { tokenForHuman } from "./integration/credentials";
import type { createSeed } from "./integration/seed";

// Shared setup for the interactive link card action tests (prepare, execute,
// sweeps): a viewer, a message with one preview link, an approved official App
// with a consented installation and an approved action endpoint, the flag on,
// and a substitute App behind the preview transport.

type Seed = ReturnType<typeof createSeed>;
export const ALL_CAPABILITIES = ["button.v1", "card.v2", "confirm.v1", "undo.v1"];

export type CardFixture = {
  origin: string; url: string; content: string;
  owner: typeof users.$inferSelect; server: typeof servers.$inferSelect; channel: typeof channels.$inferSelect; message: { id: string };
  client: { id: string; clientId: string };
  /** The App's client secret, for its client-credentials routes (card-updates). */
  clientSecret: string;
  install: typeof oauthClientInstalls.$inferSelect; registration: typeof oauthAppLinkPreviews.$inferSelect;
  actionEndpoint: string; headers: Record<string, string>;
};

export async function cardFixture(db: Database, seed: Seed, options: { content?: (url: string) => string } = {}): Promise<CardFixture> {
  const suffix = randomUUID().slice(0, 8);
  const origin = `https://cards-${suffix}.example.test`;
  const url = `${origin}/pr/1`;
  const content = options.content?.(url) ?? `please approve ${url}`;
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const message = await seed.message({ channel, author: owner, content });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: `cards-${suffix}`, name: `Cards ${suffix}` });
  const [install] = await db.insert(oauthClientInstalls).values({ clientId: client.id, serverId: server.id, installedByUserId: owner.id }).returning();
  await db.insert(oauthUserConsents).values({ serverId: server.id, userId: owner.id, clientId: client.id, scopes: ["openid", "profile"] });
  const actionEndpoint = `${origin}/card-actions`;
  const [registration] = await db.insert(oauthAppLinkPreviews).values({
    clientId: client.id, origin, endpoint: `${origin}/callback`, paths: ["/pr"], actionEndpoint, previewVersions: [1, 2, 3],
  }).returning();
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = server.id;
  await db.insert(officialAppRegistry).values({ oauthClientId: client.id, clientKey: client.clientId, publisherServerId: server.id, purpose: "Link cards", status: "approved" });
  const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id, "Content-Type": "application/json", "Accept-Language": "zh-CN" };
  return { origin, url, content, owner, server, channel, message, client, clientSecret, install: install!, registration: registration!, actionEndpoint, headers };
}

/** A handle exactly as the read would sign it for this fixture's link; `overrides` bends any claim. */
export function handleFor(fx: CardFixture, overrides: Omit<Partial<LinkCardHandleClaims>, "binding"> & { binding?: Partial<LinkCardHandleClaims["binding"]> } = {}) {
  const iat = Math.floor(Date.now() / 1000);
  const { binding, ...rest } = overrides;
  const claims: LinkCardHandleClaims = {
    viewInstanceId: randomUUID(), viewNonce: newLinkCardViewNonce(), epoch: 1, iat, exp: iat + 600,
    actionId: "approve", cardRevision: "cr-1", businessRevision: "br-1", requiresPrepare: false,
    descriptorSha256: canonicalJsonSha256({ label: "Approve", variant: "default", action: { kind: "execute", action_id: "approve", undoWindowMs: 5000 } }),
    messageContentSha256: linkCardMessageContentSha256(fx.content),
    ...rest,
    binding: {
      viewerId: fx.owner.id, serverId: fx.server.id, providerKind: "app", providerKey: fx.client.clientId, installationKey: fx.install.id,
      messageId: fx.message.id, urlSha256: linkCardUrlSha256(fx.url), registrationRevision: fx.registration.revision, capabilities: ALL_CAPABILITIES,
      ...binding,
    },
  };
  return { handle: signLinkCardHandle(claims), claims, handleSha256: createHash("sha256").update(signLinkCardHandle(claims), "utf8").digest("hex") };
}

export type ActionCall = {
  url: string; raw: string; body: Record<string, unknown>; assertion: string;
  header: Record<string, unknown>; claims: Record<string, unknown>; options: PreviewHttpOptions | undefined;
};
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;

/** Substitutes the App's action endpoint (and preview callback): records each call and answers with `answer`. */
export function stubApp(answer: (call: ActionCall) => unknown | Promise<unknown>) {
  const calls: ActionCall[] = [];
  __setPreviewHttpForTests(async (url, body, assertion, options) => {
    if (body === undefined) return { client_id: "someone-else" };
    const [h, p] = assertion!.split(".");
    const call: ActionCall = { url, raw: body, body: JSON.parse(body) as Record<string, unknown>, assertion: assertion!, header: decode(h!), claims: decode(p!), options };
    calls.push(call);
    return answer(call);
  });
  return calls;
}
export const appAnswer = (value: Record<string, unknown>) => JSON.stringify(value);

export async function post(baseUrl: string, path: "prepare" | "execute", fx: { headers: Record<string, string> }, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/api/link-cards/${path}`, {
    method: "POST", headers: { ...fx.headers, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  return { status: response.status, body: json, headers: response.headers };
}

export const clientRequestId = () => `crid-${randomUUID()}`;

/** `count` open operations for this viewer (or another installation), inserted directly, in `state`. */
export async function insertOperations(db: Database, fx: CardFixture, count: number, input: { state?: string; viewerId?: string; installationKey?: string } = {}) {
  if (count <= 0) return;
  await db.execute(sql`INSERT INTO ${linkCardOperations} (operation_id, viewer_id, server_id, provider_kind, provider_key, installation_key,
      registration_revision, view_nonce, message_id, url_sha256, action_endpoint_sha256, action_origin, action_id, request_sha256, state,
      created_at, first_send_deadline)
    SELECT gen_random_uuid(), ${input.viewerId ?? fx.owner.id}::uuid, ${fx.server.id}::uuid, 'app', ${fx.client.clientId}, ${input.installationKey ?? fx.install.id},
      ${fx.registration.revision}, 'seeded-' || n, ${fx.message.id}::uuid, ${linkCardUrlSha256(fx.url)}, ${linkCardActionEndpointSha256(fx.actionEndpoint)},
      ${fx.origin}, 'approve', ${"0".repeat(64)}, ${input.state ?? "sent"}, date_trunc('second', now()), date_trunc('second', now()) + interval '10 minutes'
    FROM generate_series(1, ${count}) AS n`);
}

/** Resolves when `count` callers have arrived; each waits for the rest. */
export function barrier(count: number) {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived >= count) release();
    await open;
  };
}

/** One emit through `io.to(room)`, recorded. */
export type RecordedEmit = { room: string; event: string; payload: unknown };

/** Records every `io.to(room).emit(...)` of this app's Socket.IO server, and still emits it. */
export function recordEmits(io: SocketServer): RecordedEmit[] {
  const seen: RecordedEmit[] = [];
  const to = io.to.bind(io);
  io.to = ((room: string) => {
    const target = to(room);
    return new Proxy(target, {
      get(object, property, receiver) {
        if (property !== "emit") return Reflect.get(object, property, receiver);
        return (event: string, payload: unknown) => {
          seen.push({ room, event, payload });
          return object.emit(event, payload);
        };
      },
    });
  }) as SocketServer["to"];
  return seen;
}

/** The receipt hints among recorded emits. */
export const receiptHints = (emits: RecordedEmit[]) => emits.filter((emit) => emit.event === LINK_CARD_OPERATION_CHANGED_EVENT);

async function answer(response: Response) {
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  return { status: response.status, body: json, headers: response.headers };
}

/** `POST /api/link-cards/status`. */
export async function statusOf(baseUrl: string, fx: { headers: Record<string, string> }, body: unknown, headers: Record<string, string> = {}) {
  return answer(await fetch(`${baseUrl}/api/link-cards/status`, {
    method: "POST", headers: { ...fx.headers, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

/** `GET /api/link-cards/operations?<query>`. */
export async function lookupOperations(baseUrl: string, fx: { headers: Record<string, string> }, query: string | Record<string, string>) {
  const search = typeof query === "string" ? query : new URLSearchParams(query).toString();
  return answer(await fetch(`${baseUrl}/api/link-cards/operations?${search}`, { headers: fx.headers }));
}

/** `POST /api/oauth/link-preview/card-updates` with Basic client credentials (or none). */
export async function sendCardUpdate(baseUrl: string, auth: { clientId: string; secret: string } | null, body: unknown, headers: Record<string, string> = {}) {
  const basic: Record<string, string> = auth ? { Authorization: `Basic ${Buffer.from(`${auth.clientId}:${auth.secret}`).toString("base64")}` } : {};
  return answer(await fetch(`${baseUrl}/api/oauth/link-preview/card-updates`, {
    method: "POST", headers: { "Content-Type": "application/json", ...basic, ...headers },
    body: typeof body === "string" ? body : body instanceof Uint8Array ? Buffer.from(body) : JSON.stringify(body),
  }));
}

/** The App's own credentials for this fixture. */
export const appAuth = (fx: CardFixture) => ({ clientId: fx.client.clientId, secret: fx.clientSecret });

/**
 * One operation through the real execute, the App answering `executeAnswer`
 * (default `unknown`): its id, the update token the App received, and how it was made.
 */
export async function executedOperation(baseUrl: string, fx: CardFixture, executeAnswer: Record<string, unknown> = { status: "unknown" }) {
  const calls = stubApp(() => appAnswer(executeAnswer));
  const requestId = clientRequestId();
  const made = handleFor(fx);
  const res = await post(baseUrl, "execute", fx, { client_request_id: requestId, handle: made.handle });
  const call = calls.find((item) => item.body.phase === "execute");
  if (res.status !== 200 || !call) throw new Error(`execute failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { operationId: res.body.operation_id as string, state: res.body.state as string, updateToken: call.body.update_token as string, clientRequestId: requestId, executeClaims: call.claims, ...made };
}
