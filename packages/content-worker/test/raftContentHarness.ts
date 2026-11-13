/**
 * The content Worker for Raft's workspace Artifacts (src/raftContent.ts) in
 * Miniflare, with a stub of Raft's internal routes (manifests of the versions
 * a test publishes and an authorize answer the test sets) and a stub of R2's
 * S3 API holding their bytes by key, which checks each request's Signature
 * Version 4 as R2 does. Needs `pnpm run build` first (dist/).
 */
import { createServer } from "node:http";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { Miniflare } from "miniflare";

export const RAFT_TOKEN = "raft-to-worker-token-0123456789abcdef-test";
/** The token RAFT_TOKEN replaces while rotating: the Worker still takes tickets signed with it. */
export const PREVIOUS_RAFT_TOKEN = "raft-to-worker-token-previous-0123456789-test";
export const WORKER_TOKEN = "worker-to-raft-token-0123456789abcdef-test";
export const PORTHOLE_SECRET = "test-only-porthole-secret-0123456789abcdef";
export const SERVER_ID = "22222222-2222-4222-8222-222222222222";
export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const FAMILY_ID = "44444444-4444-4444-8444-444444444444";
/** Artifacts' prefix in Raft's platform bucket, spelled out here: the Worker's own constant is what is tested. */
export const ARTIFACTS_PREFIX = "apps/artifacts/";
/** The bucket and the read-only token the Worker is given (R2_BUCKET, R2_READ_*). */
export const R2_BUCKET = "raft-test-app-objects";
export const R2_READ_ACCESS_KEY_ID = "0123456789abcdef0123456789abcdef";
export const R2_READ_SECRET_ACCESS_KEY = "test-only-r2-read-secret-0123456789abcdef0123456789abcdef";

type Authorize = { status: number; body: unknown } | "timeout" | "error";

export type StubRaft = {
  url: string;
  /** What Raft's authorize answers next (default: allow). */
  authorize: Authorize;
  /** Every authorize body Raft got, with whether its token was the Worker's. */
  authorizeCalls: { body: any; token: boolean; userAgent: string | undefined }[];
  manifestCalls: string[];
  /**
   * Raft's answer that an Artifact embeds (`GET /internal/artifacts-content/embeds/:artifact`), by
   * Artifact: the body answered with 200; any other Artifact is a 404 (`embedPublic` sets one).
   */
  embeddable: Map<string, unknown>;
  /** Every embed question Raft got: the Artifact asked about. */
  embedCalls: string[];
  /** Answer embed questions with this status instead (e.g. 500); 0: as `embeddable` says. */
  embedStatus: number;
  /** Answer manifests with this status instead (e.g. 500); 0: as published. */
  manifestStatus: number;
  /** Changes a manifest before it is answered (a Raft that answers for another version). */
  manifestRewrite: ((manifest: any) => unknown) | null;
  /** The app origin's own routes (for browser checks): path (or a prefix ending in `*`) → an answer. */
  routes: Map<string, (request: { method: string; url: URL; body: string }) => Promise<{ status?: number; type: string; body: string | Uint8Array; headers?: Record<string, string> }>>;
  close: () => Promise<void>;
};

type Manifest = {
  artifact: string;
  version: string;
  number: number;
  kind: string;
  entry: string;
  spa: boolean;
  title: string;
  files: { path: string; size: number; sha256: string; key: string }[];
};

async function startStubRaft(manifests: Map<string, Manifest>): Promise<StubRaft> {
  let stub: StubRaft;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const token = req.headers.authorization === `Bearer ${WORKER_TOKEN}`;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const route =
      stub.routes.get(url.pathname) ??
      [...stub.routes].find(([path]) => path.endsWith("*") && url.pathname.startsWith(path.slice(0, -1)))?.[1];
    if (route) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () =>
        route({ method: req.method ?? "GET", url, body }).then(
          (answer) => {
            res.writeHead(answer.status ?? 200, { "content-type": answer.type, "cache-control": "no-store", ...answer.headers });
            res.end(answer.body);
          },
          (error) => {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end(String(error));
          },
        ),
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/internal/artifacts-content/authorize") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        stub.authorizeCalls.push({ body: JSON.parse(body || "null"), token, userAgent: req.headers["user-agent"] });
        const answer = stub.authorize;
        if (!token) return json(401, { error: "bad token" });
        if (answer === "timeout") return; // never answers
        if (answer === "error") return req.socket.destroy();
        json(answer.status, answer.body);
      });
      return;
    }
    const embed = /^\/internal\/artifacts-content\/embeds\/([^/]+)$/.exec(url.pathname)?.[1];
    if (req.method === "GET" && embed !== undefined) {
      const artifact = decodeURIComponent(embed);
      stub.embedCalls.push(artifact);
      if (!token) return json(401, { error: "bad token" });
      if (stub.embedStatus) return json(stub.embedStatus, { error: "set by the test" });
      return stub.embeddable.has(artifact) ? json(200, stub.embeddable.get(artifact)) : json(404, { error: "not found" });
    }
    const version = /^\/internal\/artifacts-content\/versions\/([^/]+)$/.exec(url.pathname)?.[1];
    if (req.method === "GET" && version !== undefined) {
      stub.manifestCalls.push(decodeURIComponent(version));
      if (!token) return json(401, { error: "bad token" });
      if (stub.manifestStatus) return json(stub.manifestStatus, { error: "set by the test" });
      const manifest = manifests.get(decodeURIComponent(version));
      if (!manifest || manifest.artifact !== url.searchParams.get("artifact")) return json(404, { error: "not found" });
      return json(200, stub.manifestRewrite ? stub.manifestRewrite(structuredClone(manifest)) : manifest);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  stub = {
    url: `http://127.0.0.1:${port}`,
    authorize: { status: 200, body: { allow: true } },
    authorizeCalls: [],
    manifestCalls: [],
    embeddable: new Map(),
    embedCalls: [],
    embedStatus: 0,
    manifestStatus: 0,
    manifestRewrite: null,
    routes: new Map(),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return stub;
}

export type StubR2Request = {
  method: string;
  /** The path as sent, still encoded: `/<bucket>/<key>`. */
  path: string;
  headers: Record<string, string | undefined>;
  /** What the stub answered: 200, or the S3 error code. */
  answer: string;
};

export type StubR2 = {
  /** R2_ENDPOINT: the stub's origin. */
  url: string;
  /** The bucket's objects by full key (`apps/artifacts/servers/…`). */
  objects: Map<string, Uint8Array>;
  requests: StubR2Request[];
  /** Answer every request with this instead, once its signature is checked (R2 failing or refusing). */
  fail: { status: number; code: string } | null;
  close: () => Promise<void>;
};

const s3Error = (code: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>stub detail ${code} that must never reach a visitor</Message></Error>`;
const hmac = (key: string | Buffer, text: string) => createHmac("sha256", key).update(text).digest();

/**
 * Why a request isn't signed as R2 wants, or null: Signature Version 4 recomputed here
 * (node:crypto, independent of the Worker's WebCrypto signer) from what arrived, for this
 * stub's one key, region `auto`, service `s3`, within 15 minutes of now.
 */
function signatureProblem(method: string, path: string, headers: Record<string, string | undefined>): string | null {
  const said = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(headers.authorization ?? "");
  if (!said) return "AccessDenied";
  const [, keyId, day, region, service, signedList, signature] = said as unknown as string[];
  if (keyId !== R2_READ_ACCESS_KEY_ID) return "InvalidAccessKeyId";
  const date = headers["x-amz-date"] ?? "";
  const at = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  if (!at || date.slice(0, 8) !== day) return "AccessDenied";
  const when = Date.UTC(+at[1]!, +at[2]! - 1, +at[3]!, +at[4]!, +at[5]!, +at[6]!);
  if (Math.abs(Date.now() - when) > 15 * 60_000) return "RequestTimeTooSkewed";
  if (region !== "auto" || service !== "s3") return "AuthorizationHeaderMalformed";
  const signed = signedList!.split(";");
  if (!["host", "x-amz-content-sha256", "x-amz-date"].every((name) => signed.includes(name))) return "AccessDenied";
  const canonical = [method, path, "", ...signed.map((name) => `${name}:${(headers[name] ?? "").trim()}`), "", signedList, headers["x-amz-content-sha256"] ?? ""].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  let key = hmac(`AWS4${R2_READ_SECRET_ACCESS_KEY}`, day!);
  for (const part of [region!, service!, "aws4_request"]) key = hmac(key, part);
  return hmac(key, toSign).toString("hex") === signature ? null : "SignatureDoesNotMatch";
}

/** R2's S3 API for one bucket and one read-only token: GetObject only, every request's signature checked. */
async function startStubR2(): Promise<StubR2> {
  let stub: StubR2;
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    const headers = Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(",") : value]));
    const answer = (status: number, code: string, body: string | Uint8Array = s3Error(code)) => {
      stub.requests.push({ method: req.method ?? "", path, headers, answer: code });
      res.writeHead(status, { "content-type": status === 200 ? "application/x-from-r2" : "application/xml" });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const problem = signatureProblem(req.method ?? "", path, headers);
    if (problem !== null) return answer(403, problem);
    // The token can read and nothing else.
    if (req.method !== "GET") return answer(403, "AccessDenied");
    if (stub.fail) return answer(stub.fail.status, stub.fail.code);
    if (!path.startsWith(`/${R2_BUCKET}/`)) return answer(404, "NoSuchBucket");
    const key = path.slice(R2_BUCKET.length + 2).split("/").map(decodeURIComponent).join("/");
    const object = stub.objects.get(key);
    if (!object) return answer(404, "NoSuchKey");
    answer(200, "200", object);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  stub = {
    url: `http://127.0.0.1:${port}`,
    objects: new Map(),
    requests: [],
    fail: null,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return stub;
}

const base64url = (bytes: Buffer | Uint8Array) => Buffer.from(bytes).toString("base64url");

/** What a content ticket says (shared artifactContentTicket.ts ArtifactContentTicketClaims). */
export type TicketClaims = {
  artifact: string;
  version: string;
  viewer: string;
  subject: string;
  origin: string;
  expires: number;
  nonce: string;
  /** A door ticket's (Porthole P125, P126): opens `<origin>/__porthole/door/_raft` alone. */
  door?: true;
  /** A page ticket's: the page of the version the frame opens at, instead of the entry. */
  page?: string;
};

/**
 * A content ticket as Raft's server signs it, made here with node:crypto from the format alone
 * (`rct1.<kid>.<claims>.<mac>`; key and kid each HMAC-SHA-256 of the secret under their label),
 * independent of the shared WebCrypto code the Worker verifies with.
 */
export function signTicket(claims: Record<string, unknown>, secret = RAFT_TOKEN): string {
  const key = hmac(secret, "raft/artifact-content-ticket/key/v1");
  const kid = base64url(hmac(secret, "raft/artifact-content-ticket/kid/v1").subarray(0, 9));
  const signed = `rct1.${kid}.${base64url(Buffer.from(JSON.stringify(claims)))}`;
  return `${signed}.${base64url(hmac(key, signed))}`;
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export type Published = { artifact: string; version: string; number: number };

export type RaftContentApp = {
  /** The Worker's own host (the issue route), as Raft calls it. */
  workerUrl: string;
  /** CONTENT_DOMAIN as bound: `raftcontent.localhost:<port>`. */
  contentDomain: string;
  /** The Raft app's origin (APP_ORIGIN): the stub's. */
  appOrigin: string;
  raft: StubRaft;
  /** R2's S3 API, as the Worker reads it (R2_ENDPOINT). */
  r2: StubR2;
  mf: Miniflare;
  /** What the Worker logged (console.*), one entry each. */
  logs: string[];
  /** A version Raft has: its files' bytes in R2 (the stub) by key, its manifest listing `servable` ones (default all). */
  publish: (
    files: Record<string, string | Uint8Array>,
    options?: { kind?: string; entry?: string; title?: string; artifact?: string; servable?: string[]; missing?: string[] },
  ) => Promise<Published>;
  /** The issue route, as Raft asks it. */
  issue: (body: unknown, token?: string | null) => Promise<Response>;
  /** A valid issue body for a version. */
  bodyFor: (published: Published) => { artifact: string; version: string; viewer: string; subject: string };
  /** A valid anonymous issue body for a version (a signed-out visitor of a public Artifact, as Raft asks). */
  anonymousBodyFor: (published: Published) => { artifact: string; version: string; viewer: string; subject: string };
  /** A version's content origin, `http://w-<uuid>.<CONTENT_DOMAIN>`. */
  originOf: (published: Published) => string;
  /** The claims Raft's server signs for a reader of a version (good for 60 s), with `overrides`. */
  claimsFor: (published: Published, overrides?: Partial<TicketClaims>) => TicketClaims;
  /** Where a signed ticket opens: `<origin>/_raft/open?ticket=…` on the version's origin (or `origin`). */
  openUrl: (published: Published, ticket: string, origin?: string) => string;
  /** Where a signed door ticket opens: `<origin>/__porthole/door/_raft?ticket=…` on the version's origin (or `origin`). */
  doorUrl: (published: Published, ticket: string, origin?: string) => string;
  /** A request to a content origin, dispatched to the Worker (Node can't reach *.localhost). */
  contentFetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** EMBED_DOMAIN as bound (`raftembed.localhost:<port>`), with `embeds`; else null. */
  embedDomain: string | null;
  /** The embed host's outer page for an Artifact: `http://<EMBED_DOMAIN>/<artifact>`. */
  embedUrl: (artifact: string) => string;
  /** Where an embed session opens on a version's content origin: `<origin>/_raft/embed`. */
  embedOpenUrl: (published: Published) => string;
  /** Raft says the version's Artifact embeds now (public, current), with this kind and title. */
  embedPublic: (published: Published, options?: { kind?: string; title?: string }) => void;
  close: () => Promise<void>;
};

export async function startRaftContent(options: { bindings?: Record<string, string>; embeds?: boolean } = {}): Promise<RaftContentApp> {
  const manifests = new Map<string, Manifest>();
  const raft = await startStubRaft(manifests);
  const r2 = await startStubR2();
  // The bundle, then the modules wrangler emitted beside it by the config's rules (pdf.js's text and data).
  const typeOf = (name: string) =>
    name.endsWith(".js") ? ("ESModule" as const) : /\.min\.mjs$|LICENSE/.test(name) ? ("Text" as const) : ("Data" as const);
  const modules = await Promise.all(
    (await readdir("dist"))
      .filter((name) => !name.endsWith(".map") && name !== "README.md")
      .sort((a, b) => (a === "raftContent.js" ? -1 : b === "raftContent.js" ? 1 : a.localeCompare(b)))
      .map(async (name) => ({ type: typeOf(name), path: `dist/${name}`, contents: await readFile(`dist/${name}`) })),
  );
  let mf: Miniflare | null = null;
  let port = 0;
  const logs: string[] = [];
  for (let attempt = 0; mf === null; attempt += 1) {
    port = await freePort();
    const candidate = new Miniflare({
      modules,
      compatibilityDate: "2026-07-24",
      host: "127.0.0.1",
      port,
      d1Databases: { TICKETS: `raft-content-tickets-${port}` },
      d1Persist: false,
      handleStructuredLogs: ({ message }: { message: string }) => {
        logs.push(message);
      },
      bindings: {
        CONTENT_DOMAIN: `raftcontent.localhost:${port}`,
        APP_ORIGIN: raft.url,
        RAFT_API_URL: raft.url,
        RAFT_API_TOKEN: WORKER_TOKEN,
        RAFT_TOKENS: `short, ${RAFT_TOKEN}`,
        PORTHOLE_SECRET,
        R2_ENDPOINT: r2.url,
        R2_BUCKET,
        R2_READ_ACCESS_KEY_ID,
        R2_READ_SECRET_ACCESS_KEY,
        ...(options.embeds ? { EMBEDS: "1", EMBED_DOMAIN: `raftembed.localhost:${port}` } : {}),
        ...(options.bindings ?? {}),
      },
    });
    try {
      await candidate.ready;
      mf = candidate;
    } catch (error) {
      await candidate.dispose().catch(() => {});
      if ((error as { code?: string }).code !== "ERR_ADDRESS_IN_USE" || attempt >= 4) throw error;
    }
  }
  const tickets = await mf.getD1Database("TICKETS");
  for (const file of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = await readFile(`migrations/${file}`, "utf8");
    for (const statement of sql.split(/;\s*(?:\n|$)/).map((s) => s.replace(/--[^\n]*/g, "").trim()).filter(Boolean))
      await tickets.prepare(statement).run();
  }
  const workerUrl = `http://127.0.0.1:${port}`;
  const numbers = new Map<string, number>();
  const app: RaftContentApp = {
    workerUrl,
    contentDomain: options.bindings?.CONTENT_DOMAIN ?? `raftcontent.localhost:${port}`,
    appOrigin: raft.url,
    raft,
    r2,
    mf,
    logs,
    async publish(files, opts = {}) {
      const artifact = opts.artifact ?? `pt_${randomUUID()}`;
      const version = `v_${randomUUID()}`;
      const number = (numbers.get(artifact) ?? 0) + 1;
      numbers.set(artifact, number);
      const listed: Manifest["files"] = [];
      for (const [path, content] of Object.entries(files)) {
        const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        // Raft's R2 key (r2KeyOf in packages/server/src/apps/artifacts/blobStore.ts):
        // servers/<server>/blobs/<sha256>/<blob id>, relative to Artifacts' prefix in the platform
        // bucket. The manifest lists the relative key; the object sits under the prefix.
        const key = `servers/${SERVER_ID}/blobs/${sha256}/b_${crypto.randomUUID()}`;
        if (!opts.missing?.includes(path)) r2.objects.set(`${ARTIFACTS_PREFIX}${key}`, bytes);
        if (!opts.servable || opts.servable.includes(path)) listed.push({ path, size: bytes.byteLength, sha256, key });
      }
      const entry = opts.entry ?? Object.keys(files)[0]!;
      manifests.set(version, { artifact, version, number, kind: opts.kind ?? "html", entry, spa: false, title: opts.title ?? "A page", files: listed });
      return { artifact, version, number };
    },
    issue: (body, token = RAFT_TOKEN) =>
      fetch(`${workerUrl}/_raft/frames`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    bodyFor: ({ artifact, version }) => ({ artifact, version, viewer: `user:${USER_ID}`, subject: `v1:${SERVER_ID}:${USER_ID}:${FAMILY_ID}` }),
    anonymousBodyFor: ({ artifact, version }) => ({ artifact, version, viewer: "anonymous", subject: `v1:anon:${artifact}:${version}` }),
    originOf: ({ artifact }) => `http://w-${artifact.slice("pt_".length)}.${app.contentDomain}`,
    claimsFor: (published, overrides = {}) => ({
      ...app.bodyFor(published),
      origin: app.originOf(published),
      expires: Math.floor(Date.now() / 1000) + 60,
      nonce: base64url(randomBytes(16)),
      ...overrides,
    }),
    openUrl: (published, ticket, origin = app.originOf(published)) => `${origin}/_raft/open?ticket=${ticket}`,
    doorUrl: (published, ticket, origin = app.originOf(published)) => `${origin}/__porthole/door/_raft?ticket=${ticket}`,
    contentFetch: async (url, init = {}) => (await mf!.dispatchFetch(url, { redirect: "manual", ...init } as any)) as unknown as Response,
    embedDomain: options.bindings?.EMBED_DOMAIN ?? (options.embeds ? `raftembed.localhost:${port}` : null),
    embedUrl: (artifact) => `http://${app.embedDomain ?? `raftembed.localhost:${port}`}/${artifact}`,
    embedOpenUrl: (published) => `${app.originOf(published)}/_raft/embed`,
    embedPublic: (published, opts = {}) => {
      const manifest = manifests.get(published.version);
      raft.embeddable.set(published.artifact, {
        artifact: published.artifact,
        version: published.version,
        kind: opts.kind ?? manifest?.kind ?? "html",
        title: opts.title ?? manifest?.title ?? "A page",
      });
    },
    close: async () => {
      await mf!.dispose();
      await raft.close();
      await r2.close();
    },
  };
  return app;
}
