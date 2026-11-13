// RFC 079 phase 3a, PR 0: today's server-mode Login with Raft answers, frozen.
//
// Phase 3a adds account-mode logins, and every existing app stays in server
// mode, answered byte for byte as before (design §0, §5 "Regression guard").
// This file runs every LOGINS and REFUSALS row of the human login matrix end to
// end, with the matrix's own seed (./oauthLoginAllowedMatrix.fixtures.ts), and
// records each answer: status, the headers in RECORDED_HEADERS and the body
// text. For a login that is the authorize redirect, the setup page's lookup,
// its continue, the code exchange with the ID token's header and payload as
// signed, the identity endpoints (userinfo, serverinfo, agents, servers,
// membership) on the root mount, on both of S's Server-scoped mounts and on
// another Server's, and the token endpoint's refusals (a replayed code, a
// malformed code, a refresh grant, a code exchanged at another Server's
// issuer). One more record holds discovery and JWKS, root and scoped.
//
// Every record runs twice: alone, and with account-mode bystander apps
// (login_mode = 'account', set with SQL as db/oauthClientLoginMode.test.ts
// does) that S's owner registered and installed on the person's Servers. Both
// runs must equal the same fixture entry, so no account-mode row may change a
// server-mode answer.
//
// Fixture: __fixtures__/oauthServerModeFrozen.json
// sha256:  6a6fe140f487dd53f7fafc6dade1f3e07e2db52aa36a77fba5084a4e8a2d9af6
// From phase 3a PR 1 on, a PR that changes the fixture is blocked (review
// rule; the last test pins the sha256 above, so the change shows here too).
//
// Normalisation (Normaliser below), applied to request lines, header values,
// bodies and the decoded ID token; everything else is kept byte for byte,
// JSON key order included (bodies are compared as text, never re-serialised):
// - the test app's origin -> <origin>; SERVER_URL, APP_URL and JWT_SECRET are
//   pinned (PINNED_ENV) so issuers, URLs and the signing key are fixed;
// - random values the test knows (access tokens, codes, the ID token, the
//   client secret, the PKCE verifier and challenge, the seed's random name
//   parts) -> <kind:n>; UUIDs -> <uuid:n> (a UUID written without hyphens ->
//   <uuid:n,without hyphens>); ISO dates -> <date:n>. n counts distinct values
//   of a kind by first appearance within the record (dates: by occurrence);
// - `expires_in` -> <~Ns>, N rounded to the minute: the endpoint floors the
//   time left on a token minted milliseconds earlier (3599 or 3600 for an hour);
// - ID token: `iat` -> <now> (checked within 5 minutes of the clock), `exp` ->
//   <now+expires_in> when it is exactly iat + expires_in; the signature, random
//   in ES256, is verified against the JWKS and recorded as <verified ES256 signature>.
//
// Regenerate only for a reviewed reason, never to turn a red row green:
//   UPDATE_OAUTH_FROZEN_FIXTURE=1 pnpm exec vitest run src/routes/oauthServerModeFrozen.api.test.ts
// (from packages/server; it needs the whole file, both runs, and refuses to
// write if they differ), then put the new sha256 above
// (`sha256sum src/routes/__fixtures__/oauthServerModeFrozen.json`; the last
// test's failure names it too).

import assert from "node:assert/strict";
import { createHash, createPublicKey, verify, type webcrypto } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll } from "vitest";

import { getDb } from "../db/index";
import { oauthClients, serverMembers } from "../db/schema";
import { createOAuthClient, installMarketplaceOAuthClient } from "../services/oauthService";
import { createApiTest } from "../test/integration/apiTest";
import { currentAppPermissions, expectedAppPermissionsJson } from "../test/integration/appPermissions";
import {
  continueLogin,
  DEFAULT_SCOPES,
  exchange,
  LOGINS,
  lookup,
  REFUSALS,
  RETURN_URL,
  seed,
  start,
  writeServerId,
  type RegisteredApp,
  type Row,
  type Seeded,
} from "./oauthLoginAllowedMatrix.fixtures";

const test = createApiTest();

const FIXTURE_PATH = path.join(import.meta.dirname, "__fixtures__", "oauthServerModeFrozen.json");
const UPDATE = process.env.UPDATE_OAUTH_FROZEN_FIXTURE === "1";

/** Everything an answer's bytes depend on besides the request; restored after the file. */
const PINNED_ENV: Readonly<Record<string, string | undefined>> = {
  SERVER_URL: "https://api.raft.test",
  APP_URL: "https://app.raft.test",
  // The harness default (test/integration/app.ts); the ID-token key is derived from it.
  JWT_SECRET: "test-jwt-secret",
  RAFT_OIDC_SIGNING_PRIVATE_KEY: undefined,
};

/** The headers recorded; others (ETag, Content-Length, Date, rate-limit, security) follow the body or are app-wide. */
const RECORDED_HEADERS = ["cache-control", "content-type", "location", "pragma", "www-authenticate"] as const;

const VARIANTS = ["alone", "with account-mode bystanders"] as const;
type Variant = (typeof VARIANTS)[number];

const DISCOVERY_KEY = "discovery and JWKS";
const rowKey = (row: Row) => `${row.expect}: ${row.name} [${row.path}]`;
const RECORD_KEYS = [DISCOVERY_KEY, ...[...LOGINS, ...REFUSALS].map(rowKey)];

type Answer = {
  step: string;
  request: string;
  status: number;
  headers?: Record<string, string>;
  body?: string;
  idToken?: { header: string; payload: string; signature: string };
};
type Fixture = { about: string; records: Record<string, Answer[]> };

const savedEnv = new Map<string, string | undefined>();
beforeAll(() => {
  for (const [name, value] of Object.entries(PINNED_ENV)) {
    savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
afterAll(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Replaces what differs from run to run with placeholders, deterministically:
 * the same value gets the same placeholder within one record, numbered by
 * first appearance per kind. One left-to-right pass per text, so numbering
 * follows the order the values appear in.
 */
class Normaliser {
  /** Long random values the test was handed (tokens, codes, secrets): matched before UUIDs. */
  private readonly secrets = new Map<string, string>();
  /** Short random name parts: matched after UUIDs, since a user's is the start of the UUID in their email. */
  private readonly fragments = new Map<string, string>();
  private readonly placeholders = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  private dates = 0;

  constructor(private readonly origin: string) {}

  secret(kind: string, value: string) {
    assert.ok(value.length >= 16, `normaliser: a ${kind} this short could match by accident`);
    this.secrets.set(value, kind);
  }

  fragment(kind: string, value: string) {
    assert.match(value, /^[0-9a-f]{8}$/, `normaliser: ${kind} is an 8-digit hex name part`);
    this.fragments.set(value, kind);
  }

  private placeholder(kind: string, value: string) {
    const key = `${kind}\u0000${value}`;
    let placeholder = this.placeholders.get(key);
    if (placeholder === undefined) {
      const n = (this.counts.get(kind) ?? 0) + 1;
      this.counts.set(kind, n);
      placeholder = `<${kind}:${n}>`;
      this.placeholders.set(key, placeholder);
    }
    return placeholder;
  }

  text(raw: string): string {
    const alternatives = (values: Map<string, string>) =>
      [...values.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
    const pattern = new RegExp([
      `(?<origin>${escapeRegExp(this.origin)})`,
      ...(this.secrets.size > 0 ? [`(?<secret>${alternatives(this.secrets)})`] : []),
      `(?<uuid>${UUID_PATTERN})`,
      "(?<bareUuid>(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f]))",
      ...(this.fragments.size > 0 ? [`(?<fragment>${alternatives(this.fragments)})`] : []),
      "(?<date>\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2}))",
    ].join("|"), "g");
    return raw.replace(pattern, (match: string, ...rest: unknown[]) => {
      const groups = rest.at(-1) as Record<string, string | undefined>;
      if (groups.origin !== undefined) return "<origin>";
      if (groups.secret !== undefined) return this.placeholder(this.secrets.get(match)!, match);
      if (groups.uuid !== undefined) return this.placeholder("uuid", match);
      if (groups.bareUuid !== undefined) {
        const canonical = [match.slice(0, 8), match.slice(8, 12), match.slice(12, 16), match.slice(16, 20), match.slice(20)].join("-");
        return this.placeholder("uuid", canonical).replace(/>$/, ",without hyphens>");
      }
      if (groups.fragment !== undefined) return this.placeholder(this.fragments.get(match)!, match);
      this.dates += 1;
      return `<date:${this.dates}>`;
    });
  }
}

/** `expires_in` to the minute: <~3600s> for an hour minted a moment ago. */
function expiresInPlaceholder(seconds: number) {
  return `<~${Math.round(seconds / 60) * 60}s>`;
}

type Base = { baseUrl: string };

class Recorder {
  readonly answers: Answer[] = [];
  readonly n: Normaliser;

  constructor(private readonly app: Base) {
    this.n = new Normaliser(app.baseUrl);
  }

  private requestLine(method: string, res: Response) {
    const url = new URL(res.url);
    return this.n.text(`${method} ${url.pathname}${url.search}`);
  }

  private headers(res: Response) {
    const headers: Record<string, string> = {};
    for (const name of RECORDED_HEADERS) {
      const value = res.headers.get(name);
      if (value !== null) headers[name] = this.n.text(value);
    }
    return headers;
  }

  /** Records an answer whole; returns its raw body text for the caller to read on. */
  async record(step: string, method: string, res: Response, rewriteBody: (raw: string) => string = (raw) => raw) {
    const raw = await res.text();
    const request = this.requestLine(method, res);
    this.answers.push({ step, request, status: res.status, headers: this.headers(res), body: this.n.text(rewriteBody(raw)) });
    return raw;
  }

  /** Records only the status: a step of the flow whose body is not Login with Raft's. */
  async recordStatus(step: string, method: string, res: Response) {
    await res.body?.cancel();
    this.answers.push({ step, request: this.requestLine(method, res), status: res.status });
  }

  /** The code exchange: the token answer, and the ID token as signed. */
  async recordToken(step: string, res: Response) {
    const raw = await res.clone().text();
    assert.equal(res.status, 200, `${step}: ${raw}`);
    const token = JSON.parse(raw) as { access_token: string; expires_in: number; id_token?: string };
    this.n.secret("access_token", token.access_token);
    if (token.id_token) this.n.secret("id_token", token.id_token);
    await this.record(step, "POST", res, (body) => body.replace(/"expires_in":(\d+)/, (_m, value: string) => `"expires_in":${expiresInPlaceholder(Number(value))}`));
    if (token.id_token) {
      this.answers.at(-1)!.idToken = await this.idToken(token.id_token, token.expires_in);
    }
    return token;
  }

  private async idToken(idToken: string, expiresIn: number) {
    const [encodedHeader, encodedPayload, encodedSignature, extra] = idToken.split(".");
    assert.ok(encodedHeader && encodedPayload && encodedSignature && extra === undefined, "ID token: three parts");
    const header = Buffer.from(encodedHeader, "base64url").toString("utf8");
    const payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
    // ES256 signatures are random: verify this one against the JWKS instead of recording it.
    const { kid } = JSON.parse(header) as { kid?: string };
    const jwks = await (await fetch(`${this.app.baseUrl}/api/oauth/jwks`)).json() as { keys: Array<webcrypto.JsonWebKey & { kid?: string }> };
    const jwk = jwks.keys.find((key) => key.kid === kid);
    assert.ok(jwk, "ID token: its kid is in the JWKS");
    const verified = verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
      { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(encodedSignature, "base64url"),
    );
    assert.ok(verified, "ID token: the signature verifies against the JWKS");

    const claims = JSON.parse(payload) as { iat?: number; exp?: number };
    assert.ok(typeof claims.iat === "number" && Math.abs(claims.iat - Date.now() / 1000) < 300, "ID token: iat is now");
    const timed = payload
      .replace(/"iat":(\d+)/, '"iat":<now>')
      .replace(/"exp":(\d+)/, (_m, value: string) => {
        const lifetime = Number(value) - claims.iat!;
        return `"exp":${lifetime === expiresIn ? "<now+expires_in>" : `<now+${expiresInPlaceholder(lifetime).slice(1, -1)}>`}`;
      });
    return { header: this.n.text(header), payload: this.n.text(timed), signature: "<verified ES256 signature>" };
  }
}

/**
 * Account-mode bystanders: apps S's owner (who owns every Server of the row)
 * registered, one installed on S and on every Server the person is in, one
 * local to S, both switched to account mode as the reviewed switch would.
 */
async function seedAccountModeBystanders(f: Seeded) {
  const register = async (serverId: string, appType: "server_local" | "third_party_global", label: string) => {
    const { client } = await createOAuthClient({
      serverId,
      createdByUserId: f.owner.id,
      appType,
      clientId: `allowed-bystander-${label}-${f.suffix}`,
      name: "Allowed App",
      returnUrl: RETURN_URL,
      allowedScopes: DEFAULT_SCOPES,
    });
    return client;
  };
  const global = await register(f.publisher.id, "third_party_global", "global");
  await getDb().update(oauthClients)
    .set({ enabled: true, publishStatus: "published", humanMarketplaceVisible: true })
    .where(eq(oauthClients.id, global.id));
  const personServers = await getDb().select({ serverId: serverMembers.serverId }).from(serverMembers)
    .where(eq(serverMembers.userId, f.person.id));
  const targets = new Set([f.server.id, ...personServers.map((member) => member.serverId)]);
  targets.delete(f.publisher.id);
  for (const serverId of [...targets].sort()) {
    assert.ok(await installMarketplaceOAuthClient({
      serverId,
      clientId: global.id,
      installedByUserId: f.owner.id,
      expected: await currentAppPermissions(global.id),
    }), "fixture: bystander installed");
  }
  const local = await register(f.server.id, "server_local", "local");
  for (const client of [global, local]) {
    await getDb().execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'account' WHERE "id" = ${client.id}`);
  }
  const modes = await getDb().select({ loginMode: oauthClients.loginMode }).from(oauthClients).where(eq(oauthClients.createdByUserId, f.owner.id));
  assert.equal(modes.filter((row) => row.loginMode === "account").length, 2, "fixture: two account-mode bystanders beside the row's app");
}

async function seedRow(row: Row, variant: Variant, recorder: Recorder) {
  const f = await seed(row);
  if (variant === "with account-mode bystanders") await seedAccountModeBystanders(f);
  recorder.n.fragment("name", f.suffix);
  for (const user of new Set([f.person, f.owner])) recorder.n.fragment("name", user.name.slice(-8));
  if (f.client) recorder.n.secret("client_secret", f.client.clientSecret);
  return f;
}

async function startRow(rec: Recorder, app: Base, row: Row, f: Seeded, scopes: string[], serverId: string) {
  const entry = await start(app, row, f, scopes, serverId);
  if (entry.verifier !== null) {
    rec.n.secret("pkce_verifier", entry.verifier);
    rec.n.secret("pkce_challenge", createHash("sha256").update(entry.verifier, "ascii").digest("base64url"));
  }
  if (entry.authorize) await rec.record("authorize", "GET", entry.authorize);
  return entry;
}

function bearerGet(app: Base, pathAndQuery: string, accessToken: string) {
  return fetch(`${app.baseUrl}${pathAndQuery}`, { headers: { Authorization: `Bearer ${accessToken}` } });
}

/** A grant the token endpoint should refuse, sent the way the row's exchange is (JSON at the root, or Basic and a form at the mount). */
function tokenRequest(app: Base, client: RegisteredApp, mount: string, oidc: boolean, grant: Record<string, string>) {
  if (!oidc) {
    return fetch(`${app.baseUrl}${mount}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret, ...grant }),
    });
  }
  return fetch(`${app.baseUrl}${mount}/api/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}` },
    body: new URLSearchParams({ redirect_uri: RETURN_URL, ...grant }),
  });
}

async function recordLogin(rec: Recorder, app: Base, row: Row & { expect: "login" }, f: Seeded) {
  const scopes = row.scopes?.ask ?? DEFAULT_SCOPES;
  const entry = await startRow(rec, app, row, f, scopes, f.server.id);
  const { bearer } = f.person;
  const client = f.client!;

  if (row.path === "marketplace") {
    const offer = JSON.parse(await rec.record("lookup before install", "GET", await lookup(app, bearer, f.clientKey, f.server.id, scopes))) as { id: string };
    await rec.recordStatus("install from the setup page", "POST", await fetch(`${app.baseUrl}/api/integrations/marketplace/${offer.id}/install`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "X-Server-Id": f.server.id, "Content-Type": "application/json" },
      body: await expectedAppPermissionsJson(client.id),
    }));
  }
  await rec.record("lookup", "GET", await lookup(app, bearer, f.clientKey, f.server.id, scopes));

  const continued = await continueLogin(app, bearer, entry.body);
  const { code } = JSON.parse(await continued.clone().text()) as { code: string };
  assert.equal(continued.status, 200, "continue");
  rec.n.secret("code", code);
  await rec.record("continue", "POST", continued);

  const token = await rec.recordToken("token", await exchange(app, client, code, entry.mount, entry.verifier));

  // The issued token on the root mount, S's two scoped mounts, and another Server's.
  const mounts = [
    ["root", ""],
    ["S's issuer by id", `/oidc/${f.server.id}`],
    ["S's issuer by slug", `/oidc/${f.server.slug}`],
    ["another Server's issuer", `/oidc/${f.publisher.id}`],
  ] as const;
  const calls = [
    ["userinfo", "/userinfo"],
    ["serverinfo, no server_id", "/serverinfo"],
    ["serverinfo, S", `/serverinfo?server_id=${f.server.id}`],
    ["serverinfo, another Server", `/serverinfo?server_id=${f.publisher.id}`],
    ["agents", "/agents"],
    ["servers", "/servers"],
    ["membership, S", `/membership?server_id=${f.server.id}`],
    ["membership, another Server", `/membership?server_id=${f.publisher.id}`],
    ["membership, no server_id", "/membership"],
  ] as const;
  for (const [mountName, mount] of mounts) {
    for (const [callName, call] of calls) {
      await rec.record(`${callName} (${mountName})`, "GET", await bearerGet(app, `${mount}/api/oauth${call}`, token.access_token));
    }
  }

  // The token endpoint's refusals, at the mount the row exchanged at.
  const verifier = entry.verifier;
  const oidc = verifier !== null;
  const authorizationCode = (value: string): Record<string, string> => verifier !== null
    ? { grant_type: "authorization_code", code: value, code_verifier: verifier }
    : { grantType: "authorization_code", code: value };
  await rec.record("token, the code again", "POST", await tokenRequest(app, client, entry.mount, oidc, authorizationCode(code)));
  await rec.record("token, a malformed code", "POST", await tokenRequest(app, client, entry.mount, oidc, authorizationCode("not-a-code")));
  await rec.record("token, refresh grant", "POST", await tokenRequest(
    app, client, entry.mount, oidc,
    oidc ? { grant_type: "refresh_token", refresh_token: token.access_token } : { grantType: "refresh_token", refreshToken: token.access_token },
  ));
  // A fresh code for S, exchanged at another Server's issuer.
  const again = await continueLogin(app, bearer, entry.body);
  const { code: second } = JSON.parse(await again.clone().text()) as { code: string };
  rec.n.secret("code", second);
  await rec.record("continue again", "POST", again);
  await rec.record("token, at another Server's issuer", "POST", await tokenRequest(app, client, `/oidc/${f.publisher.id}`, oidc, authorizationCode(second)));
}

async function recordRefusal(rec: Recorder, app: Base, row: Row, f: Seeded) {
  const serverId = row.expect === "app_not_available" ? writeServerId(f.server.id, row.serverIdWritten) : f.server.id;
  const entry = await startRow(rec, app, row, f, DEFAULT_SCOPES, serverId);
  const { bearer } = f.person;
  await rec.record("lookup", "GET", await lookup(app, bearer, f.clientKey, serverId, DEFAULT_SCOPES));
  await rec.record("continue", "POST", await continueLogin(app, bearer, entry.body));
  if (row.expect === "app_not_available" && row.serverIdWritten) {
    await rec.record("lookup, S's canonical id", "GET", await lookup(app, bearer, f.clientKey, f.server.id, DEFAULT_SCOPES));
  }
}

async function recordDiscovery(rec: Recorder, app: Base, f: Seeded) {
  const paths = [
    "/.well-known/openid-configuration",
    "/api/oauth/.well-known/openid-configuration",
    `/oidc/${f.server.id}/.well-known/openid-configuration`,
    `/oidc/${f.server.slug}/.well-known/openid-configuration`,
    `/oidc/${f.server.id}/api/oauth/.well-known/openid-configuration`,
    `/oidc/${f.server.slug}/api/oauth/.well-known/openid-configuration`,
    "/api/oauth/jwks",
    `/oidc/${f.server.id}/api/oauth/jwks`,
    `/oidc/${f.server.slug}/api/oauth/jwks`,
  ];
  for (const pathname of paths) {
    await rec.record(pathname.includes("jwks") ? "jwks" : "discovery", "GET", await fetch(`${app.baseUrl}${pathname}`));
  }
}

// ---- comparison, fixture file ----

function render(answers: Answer[]) {
  return JSON.stringify(answers, null, 2);
}

/** The lines that differ, with context; for a changed line, the column of the first difference. */
function readableDiff(expected: string, actual: string) {
  const a = expected.split("\n");
  const b = actual.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA -= 1;
    tailB -= 1;
  }
  const context = 4;
  const out = a.slice(Math.max(0, head - context), head).map((line) => `  ${line}`);
  const removed = a.slice(head, tailA);
  const added = b.slice(head, tailB);
  out.push(...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`));
  if (removed.length === 1 && added.length === 1) {
    let column = 0;
    while (removed[0]![column] === added[0]![column]) column += 1;
    out.push(`  first difference at column ${column}: fixture …${removed[0]!.slice(Math.max(0, column - 30), column + 50)}… vs now …${added[0]!.slice(Math.max(0, column - 30), column + 50)}…`);
  }
  out.push(...a.slice(tailA, tailA + context).map((line) => `  ${line}`));
  const shown = out.length > 120 ? [...out.slice(0, 120), `  … ${out.length - 120} more lines`] : out;
  return shown.join("\n");
}

function readFixture(): Fixture {
  assert.ok(existsSync(FIXTURE_PATH), `${FIXTURE_PATH} is missing; regenerate it with UPDATE_OAUTH_FROZEN_FIXTURE=1 (see the header)`);
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
}

const fixture = UPDATE ? null : readFixture();
const recorded = new Map<string, Answer[]>();

function settle(variant: Variant, key: string, answers: Answer[]) {
  if (UPDATE) {
    recorded.set(`${variant}\u0000${key}`, answers);
    return;
  }
  const expected = fixture!.records[key];
  assert.ok(expected, `the fixture has no record "${key}"; regenerate it (see the header)`);
  const want = render(expected);
  const got = render(answers);
  if (want !== got) {
    assert.fail(`server-mode answers changed (${variant}): "${key}"\n--- fixture  +++ now\n${readableDiff(want, got)}`);
  }
}

afterAll(() => {
  if (!UPDATE) return;
  const records: Record<string, Answer[]> = {};
  for (const key of RECORD_KEYS) {
    const [alone, bystanders] = VARIANTS.map((variant) => recorded.get(`${variant}\u0000${key}`));
    assert.ok(alone && bystanders, `UPDATE_OAUTH_FROZEN_FIXTURE: "${key}" did not run in both variants; run the whole file`);
    const a = render(alone);
    const b = render(bystanders);
    if (a !== b) assert.fail(`UPDATE_OAUTH_FROZEN_FIXTURE: account-mode bystanders changed "${key}"; not writing\n${readableDiff(a, b)}`);
    records[key] = alone;
  }
  const written: Fixture = {
    about: "Server-mode Login with Raft answers, frozen for RFC 079 phase 3a (PR 0). Written by oauthServerModeFrozen.api.test.ts with UPDATE_OAUTH_FROZEN_FIXTURE=1; its header records this file's sha256 and the normalisation. Do not edit by hand.",
    records,
  };
  mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(written, null, 2)}\n`);
});

// ---- the records ----

// The two variants keep independent seeds and recorders while sharing only the
// database/application lifecycle for this record. Every frozen answer is checked.
test(DISCOVERY_KEY, async ({ app }) => {
  for (const variant of VARIANTS) {
    const rec = new Recorder(app);
    const f = await seedRow(LOGINS[0]!, variant, rec);
    await recordDiscovery(rec, app, f);
    settle(variant, DISCOVERY_KEY, rec.answers);
  }
});

for (const row of [...LOGINS, ...REFUSALS]) {
  test(rowKey(row), async ({ app }) => {
    for (const variant of VARIANTS) {
      const rec = new Recorder(app);
      const f = await seedRow(row, variant, rec);
      if (row.expect === "login") await recordLogin(rec, app, row, f);
      else await recordRefusal(rec, app, row, f);
      settle(variant, rowKey(row), rec.answers);
    }
  });
}

test.skipIf(UPDATE)("the fixture holds exactly the matrix's records, and its sha256 is the one in this file's header", () => {
  assert.deepEqual(Object.keys(fixture!.records), RECORD_KEYS, "records: one per matrix row, in matrix order, after discovery");
  const header = /^\/\/ sha256:\s+([0-9a-f]{64})$/m.exec(readFileSync(fileURLToPath(import.meta.url), "utf8"));
  assert.ok(header, "the header names the fixture's sha256");
  const actual = createHash("sha256").update(readFileSync(FIXTURE_PATH)).digest("hex");
  assert.equal(actual, header[1], "the fixture changed: from phase 3a PR 1 on, that blocks the PR (see the header)");
});
