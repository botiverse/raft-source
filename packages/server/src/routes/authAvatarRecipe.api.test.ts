// A person's built pixel avatar (shared humanAvatar.ts): PUT /api/auth/me/avatar-recipe
// stores the options as `pixel-human:v1:...`, replacing any avatar (an upload
// too); the Server draws it as SVG for surfaces that need an image URL;
// projections that show only a stored upload show it too. Saving one and a
// new account's random one are behind human_avatar_builder_v0; drawing is not.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { CURRENT_LEGAL_ACCEPTANCE, HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import {
  DEFAULT_HUMAN_AVATAR_RECIPE,
  isAutoHumanAvatarUrl,
  parseHumanAvatarRecipe,
  serializeHumanAvatarRecipe,
} from "@botiverse/raft-shared/src/humanAvatar";
import type { HumanAvatarRecipe } from "@botiverse/raft-shared/src/humanAvatar";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { featureFlagRules, featureFlags, users } from "../db/schema";
import { installFakeIo } from "./channels.api.fixtures";
import { createServer } from "../services/serverService";
import { encodePixelAvatarKey } from "../services/pixelAvatarService";
import { HUMAN_AVATAR_ART_REVISION } from "@botiverse/raft-shared/src/humanAvatarArt";
import { newAccountAvatarUrl, newAccountAvatarUrlFor } from "../services/userService";

const test = createApiTest();

const ONE_BY_ONE_GIF = Buffer.from("R0lGODdhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");
const RECIPE: HumanAvatarRecipe = {
  background: "mint", skin: "4", hair: "curly", hairColor: "ginger", expression: "grin", head: "headphones", face: "glasses",
};

async function seedUser(name: string, avatarUrl: string | null = null) {
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    passwordHash: "x",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
    avatarUrl,
  }).returning();
  return user!;
}

/** human_avatar_builder_v0 on for these servers only (the flag row is off by default). */
async function enableBuilderFor(...serverIds: string[]) {
  await getDb().insert(featureFlags)
    .values({ key: HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false })
    .onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: serverIds,
  });
}

/** A person in a server where the builder is on. */
async function seedBuilder(name: string, avatarUrl: string | null = null) {
  const person = await seedUser(name, avatarUrl);
  const server = await createServer(name, name, person.id);
  await enableBuilderFor(server.id);
  return person;
}

async function storedAvatar(userId: string) {
  const [row] = await getDb().select({ avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, userId));
  return row?.avatarUrl ?? null;
}

test("PUT /api/auth/me/avatar-recipe needs a signed-in person", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}/api/auth/me/avatar-recipe`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipe: RECIPE }),
  });
  assert.equal(res.status, 401);
});

test("PUT /api/auth/me/avatar-recipe stores the options and tells the person's servers", async ({ app, http }) => {
  const events = installFakeIo(app.app);
  const person = await seedUser("recipe-store");
  const server = await createServer("Recipe Store", "recipe-store", person.id);
  await enableBuilderFor(server.id);

  const res = await http.as(person).request("/api/auth/me/avatar-recipe", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    // A newer client's extra field is dropped, not refused.
    body: JSON.stringify({ recipe: { ...RECIPE, scarf: "red" } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { id: string; avatarUrl: string };
  assert.equal(body.avatarUrl, "pixel-human:v1:mint.4.curly.ginger.grin.headphones.glasses");
  assert.deepEqual(parseHumanAvatarRecipe(body.avatarUrl), RECIPE);
  assert.equal(await storedAvatar(person.id), body.avatarUrl);

  const announced = events.filter((entry) => entry.event === "user:profile-updated");
  assert.deepEqual(announced.map(({ room, payload }) => [room, (payload as { avatarUrl: string }).avatarUrl]), [
    [`server:${server.id}`, body.avatarUrl],
  ]);

  const me = await http.as(person).request("/api/auth/me", {});
  assert.equal((await me.json() as { avatarUrl: string }).avatarUrl, body.avatarUrl, "reopening reads the stored recipe");
});

test("PUT /api/auth/me/avatar-recipe refuses anything but known options, and keeps the avatar", async ({ http }) => {
  const before = serializeHumanAvatarRecipe(DEFAULT_HUMAN_AVATAR_RECIPE);
  const person = await seedBuilder("recipe-invalid", before);
  for (const body of [
    {},
    { recipe: { ...RECIPE, head: "crown" } },
    { recipe: { ...RECIPE, expression: undefined } },
    { recipe: { ...RECIPE, skin: 4 } },
    { recipe: "pixel-human:v1:mint.4.curly.ginger.grin.headphones.glasses" },
    { avatarUrl: "https://example.com/me.png" },
  ]) {
    const res = await http.as(person).request("/api/auth/me/avatar-recipe", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, JSON.stringify(body));
    const refusal = await res.json() as { code: string; errorCode: string; error: string };
    assert.equal(refusal.code, "PROFILE_AVATAR_RECIPE_INVALID");
    assert.equal(refusal.errorCode, "PROFILE_AVATAR_RECIPE_INVALID", "refuse() writes the older name too");
    assert.match(refusal.error, / /);
  }
  assert.equal(await storedAvatar(person.id), before);
});

test("a built avatar replaces an uploaded photo, and an upload replaces a built avatar", async ({ http }) => {
  const person = await seedBuilder("recipe-replace");
  const form = new FormData();
  form.set("avatar", new Blob([ONE_BY_ONE_GIF], { type: "image/gif" }), "avatar.gif");
  const uploaded = await http.as(person).request("/api/auth/me/avatar", { method: "POST", body: form });
  assert.equal(uploaded.status, 200);
  const photo = (await uploaded.json() as { avatarUrl: string }).avatarUrl;
  assert.match(photo, /\/avatars\/users\/[0-9a-f]{32}\.webp$/);

  const built = await http.as(person).request("/api/auth/me/avatar-recipe", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipe: RECIPE }),
  });
  assert.equal(built.status, 200);
  assert.equal(await storedAvatar(person.id), serializeHumanAvatarRecipe(RECIPE));

  const again = new FormData();
  again.set("avatar", new Blob([ONE_BY_ONE_GIF], { type: "image/gif" }), "avatar.gif");
  const reuploaded = await http.as(person).request("/api/auth/me/avatar", { method: "POST", body: again });
  assert.equal(reuploaded.status, 200);
  assert.equal(await storedAvatar(person.id), photo);
});

test("a built avatar or PATCH /me avatarUrl null deletes the photo it replaces", async ({ app, http }) => {
  const person = await seedBuilder("recipe-delete-photo");
  const upload = async () => {
    const form = new FormData();
    form.set("avatar", new Blob([ONE_BY_ONE_GIF], { type: "image/gif" }), "avatar.gif");
    const res = await http.as(person).request("/api/auth/me/avatar", { method: "POST", body: form });
    assert.equal(res.status, 200);
    return (await res.json() as { avatarUrl: string }).avatarUrl;
  };
  const served = async (avatarUrl: string) => (await fetch(new URL(avatarUrl, app.baseUrl))).status;

  const photo = await upload();
  assert.equal(await served(photo), 200);
  const built = await http.as(person).request("/api/auth/me/avatar-recipe", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipe: RECIPE }),
  });
  assert.equal(built.status, 200);
  assert.notEqual(await served(photo), 200, "the replaced photo is no longer served");

  const again = await upload();
  assert.equal(await served(again), 200);
  const removed = await http.as(person).request("/api/auth/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ avatarUrl: null }),
  });
  assert.equal(removed.status, 200);
  assert.equal(await storedAvatar(person.id), null);
  assert.notEqual(await served(again), 200, "a removed photo is no longer served");
});

test("a photo someone else still shows stays when one person replaces it", async ({ app, http }) => {
  const person = await seedBuilder("recipe-shared-photo-a");
  const form = new FormData();
  form.set("avatar", new Blob([ONE_BY_ONE_GIF], { type: "image/gif" }), "avatar.gif");
  const photo = (await (await http.as(person).request("/api/auth/me/avatar", { method: "POST", body: form })).json() as { avatarUrl: string }).avatarUrl;
  await seedUser("recipe-shared-photo-b", photo);
  await http.as(person).request("/api/auth/me/avatar-recipe", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipe: RECIPE }),
  });
  assert.equal((await fetch(new URL(photo, app.baseUrl))).status, 200);
});

test("PUT /api/auth/me/avatar-recipe refuses while human_avatar_builder_v0 is off, and keeps the avatar", async ({ http }) => {
  const put = (person: { id: string }, headers: Record<string, string> = {}) => http.as(person).request("/api/auth/me/avatar-recipe", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ recipe: RECIPE }),
  });
  const refused = async (res: Response) => {
    assert.equal(res.status, 404);
    const body = await res.json() as { code: string };
    assert.equal(body.code, "HUMAN_AVATAR_BUILDER_DISABLED");
  };

  // No flag row at all (missing = off), in a server and in none.
  const loner = await seedUser("recipe-off-loner");
  await refused(await put(loner));
  const member = await seedUser("recipe-off-member", "/api/avatars/users/0123456789abcdef0123456789abcdef.webp");
  const offServer = await createServer("Recipe Off", "recipe-off", member.id);
  await refused(await put(member));
  assert.equal(await storedAvatar(member.id), "/api/avatars/users/0123456789abcdef0123456789abcdef.webp");

  // On for another of the person's servers: no header asks any of them.
  const onServer = await createServer("Recipe On", "recipe-on", member.id);
  await enableBuilderFor(onServer.id);
  // Naming the server where it is off refuses (the web's current server).
  await refused(await put(member, { "X-Server-Id": offServer.id }));
  assert.equal((await put(member, { "X-Server-Id": onServer.id })).status, 200);
  assert.equal((await put(member)).status, 200);
  // A named server they are not in is no context: any of theirs.
  assert.equal((await put(member, { "X-Server-Id": randomUUID() })).status, 200);
  assert.equal(await storedAvatar(member.id), serializeHumanAvatarRecipe(RECIPE));
});

test("a new account gets no avatar while signup knows no server where the builder is on", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "recipe-new-email@slock.test",
      password: "password123",
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const { user } = await res.json() as { user: { id: string; avatarUrl: string | null } };
  assert.equal(user.avatarUrl, null, "email sign-up joins no server: the generic person icon");
  assert.equal(await storedAvatar(user.id), null);

  const owner = await seedUser("recipe-new-owner");
  const offServer = await createServer("Recipe New Off", "recipe-new-off", owner.id);
  assert.equal(await newAccountAvatarUrlFor(null), null);
  assert.equal(await newAccountAvatarUrlFor(offServer.id), null, "missing flag = off");
  const onServer = await createServer("Recipe New On", "recipe-new-on", owner.id);
  await enableBuilderFor(onServer.id);
  assert.equal(await newAccountAvatarUrlFor(offServer.id), null);
  const picked = await newAccountAvatarUrlFor(onServer.id);
  assert.ok(picked && parseHumanAvatarRecipe(picked) && isAutoHumanAvatarUrl(picked), `the Server's pick, marked: ${picked}`);
});

test("a new account's built avatar is random", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const value = newAccountAvatarUrl();
    assert.ok(parseHumanAvatarRecipe(value), `a full v1 recipe: ${value}`);
    assert.ok(isAutoHumanAvatarUrl(value), "marked as the Server's pick, so a provider photo may replace it");
    seen.add(value);
  }
  // 7 random fields: four identical draws in a row would be a broken source.
  assert.ok(seen.size > 1, `random, not one fixed look: ${[...seen].join(", ")}`);
});

test("a built avatar's SVG is cached for good only at the current art's URL", async ({ app }) => {
  const key = encodePixelAvatarKey(serializeHumanAvatarRecipe(RECIPE));
  const cacheOf = async (query: string) => {
    const res = await fetch(`${app.baseUrl}/api/avatars/pixel/${key}.svg${query}`);
    assert.equal(res.status, 200, query);
    return res.headers.get("cache-control");
  };
  assert.equal(await cacheOf(`?art=${HUMAN_AVATAR_ART_REVISION}`), "public, max-age=31536000, immutable");
  assert.equal(await cacheOf("?art=0.1"), "public, max-age=300", "another art revision");
  assert.equal(await cacheOf(""), "public, max-age=300", "no art revision");
  // An agent's sprite keeps its year whatever the query.
  assert.equal((await fetch(`${app.baseUrl}/api/avatars/pixel/${encodePixelAvatarKey("pixel:robot")}.svg`)).headers.get("cache-control"), "public, max-age=31536000, immutable");
});

test("the pixel SVG route draws a built avatar, and an unknown option as its default", async ({ app }) => {
  const value = serializeHumanAvatarRecipe(RECIPE);
  const res = await fetch(`${app.baseUrl}/api/avatars/pixel/${encodePixelAvatarKey(value)}.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  const svg = await res.text();
  assert.match(svg, /^<svg [^>]*viewBox="0 0 112 112" shape-rendering="crispEdges"><rect width="112" height="112" fill="#82d6a0"\/>/);

  const newer = await fetch(`${app.baseUrl}/api/avatars/pixel/${encodePixelAvatarKey("pixel-human:v1:mint.4.curly.ginger.grin.crown.glasses")}.svg`);
  assert.equal(newer.status, 200);
  assert.match(await newer.text(), /fill="#82d6a0"/, "the rest of the look survives an option this build doesn't know");
});
