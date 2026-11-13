// PATCH /api/auth/me { avatarUrl } sets only what a person may show: no
// avatar, the photo they uploaded and show now, or a pixel avatar they built
// (never the Server-picked `/auto` marker). Anything else is refused and the
// request applies nothing.
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { serializeHumanAvatarRecipe } from "@botiverse/raft-shared/src/humanAvatar";
import type { HumanAvatarRecipe } from "@botiverse/raft-shared/src/humanAvatar";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { users } from "../db/schema";

const test = createApiTest();

const ONE_BY_ONE_GIF = Buffer.from("R0lGODdhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");
const RECIPE: HumanAvatarRecipe = {
  background: "mint", skin: "4", hair: "curly", hairColor: "ginger", expression: "grin", head: "headphones", face: "glasses",
};
const BUILT = serializeHumanAvatarRecipe(RECIPE);

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

async function storedRow(userId: string) {
  const [row] = await getDb().select({ avatarUrl: users.avatarUrl, displayName: users.displayName }).from(users).where(eq(users.id, userId));
  return row!;
}

type Http = { as(human: { id: string }): { request(path: string, init: RequestInit): Promise<Response> } };
type Person = Awaited<ReturnType<typeof seedUser>>;

function patchMe(http: Http, person: Person, body: unknown) {
  return http.as(person).request("/api/auth/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function upload(http: Http, person: Person) {
  const form = new FormData();
  form.set("avatar", new Blob([ONE_BY_ONE_GIF], { type: "image/gif" }), "avatar.gif");
  const res = await http.as(person).request("/api/auth/me/avatar", { method: "POST", body: form });
  assert.equal(res.status, 200);
  return (await res.json() as { avatarUrl: string }).avatarUrl;
}

test("PATCH /me avatarUrl null or empty removes the avatar, a built one or the Server-picked /auto one", async ({ http }) => {
  const AUTO = serializeHumanAvatarRecipe(RECIPE, { auto: true });
  for (const [label, current] of [["built", BUILT], ["auto", AUTO]] as const) {
    for (const value of [null, ""]) {
      const person = await seedUser(`avatar-url-remove-${label}-${value === null ? "null" : "empty"}`, current);
      const res = await patchMe(http, person, { avatarUrl: value });
      assert.equal(res.status, 200, `${label} ${JSON.stringify(value)}`);
      assert.equal((await res.json() as { avatarUrl: string | null }).avatarUrl, null);
      assert.equal((await storedRow(person.id)).avatarUrl, null);
    }
  }
});

test("PATCH /me avatarUrl accepts a built avatar the person chose", async ({ http }) => {
  const person = await seedUser("avatar-url-built");
  const res = await patchMe(http, person, { avatarUrl: BUILT });
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { avatarUrl: string }).avatarUrl, BUILT);
  assert.equal((await storedRow(person.id)).avatarUrl, BUILT);
});

test("PATCH /me avatarUrl accepts the person's own current photo, in any spelling, and keeps it as stored", async ({ http }) => {
  const person = await seedUser("avatar-url-own-photo");
  const photo = await upload(http, person);
  const hash = /([0-9a-f]{32})\.webp$/.exec(photo)![1];
  for (const spelling of [photo, `/avatars/users/${hash}.webp`, `https://cdn.example.test/avatars/users/${hash}.webp?v=2`]) {
    const res = await patchMe(http, person, { avatarUrl: spelling });
    assert.equal(res.status, 200, spelling);
    assert.equal((await storedRow(person.id)).avatarUrl, photo, spelling);
  }
});

test("PATCH /me avatarUrl refuses anything else and applies nothing in that request", async ({ http }) => {
  const other = await seedUser("avatar-url-other-owner");
  const othersPhoto = await upload(http, other);
  const person = await seedUser("avatar-url-refused", BUILT);
  const refused: Array<[unknown, string]> = [
    [othersPhoto, "PROFILE_AVATAR_URL_NOT_OWN"],
    [`/api/avatars/users/${"f".repeat(32)}.webp`, "PROFILE_AVATAR_URL_NOT_OWN"],
    [serializeHumanAvatarRecipe(RECIPE, { auto: true }), "PROFILE_AVATAR_URL_INVALID"],
    ["pixel-human:v1:mint.4.curly.ginger.grin.crown.glasses", "PROFILE_AVATAR_URL_INVALID"],
    ["pixel-human:v1:mint.4.curly.ginger.grin.headphones", "PROFILE_AVATAR_URL_INVALID"],
    ["pixel-human:v2:mint.4.curly.ginger.grin.headphones.glasses", "PROFILE_AVATAR_URL_INVALID"],
    ["pixel:robot", "PROFILE_AVATAR_URL_INVALID"],
    ["https://example.com/me.png", "PROFILE_AVATAR_URL_INVALID"],
    [`/api/avatars/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/${"a".repeat(32)}.webp`, "PROFILE_AVATAR_URL_INVALID"],
    [42, "PROFILE_AVATAR_URL_INVALID"],
    [{ recipe: RECIPE }, "PROFILE_AVATAR_URL_INVALID"],
  ];
  for (const [value, code] of refused) {
    const res = await patchMe(http, person, { avatarUrl: value, displayName: "Should Not Apply" });
    assert.equal(res.status, 400, JSON.stringify(value));
    const body = await res.json() as { code: string; error: string };
    assert.equal(body.code, code, JSON.stringify(value));
    assert.match(body.error, / /);
  }
  const row = await storedRow(person.id);
  assert.equal(row.avatarUrl, BUILT, "the avatar is unchanged");
  assert.equal(row.displayName, null, "nothing else in a refused request is applied");
  assert.equal((await storedRow(other.id)).avatarUrl, othersPhoto);
});
