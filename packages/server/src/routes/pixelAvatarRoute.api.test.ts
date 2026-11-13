import assert from "node:assert/strict";

import { createApiTest } from "../test/integration/apiTest";
import { DEFAULT_PIXEL_AVATAR_KEY, renderPixelAvatarSvg } from "../services/pixelAvatarService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const encode = (key: string) => Buffer.from(key, "utf8").toString("base64url");

test("GET /api/avatars/pixel/:key.svg draws robot for a key this server doesn't know, cached briefly", async ({ app }) => {
  const response = await fetch(`${app.baseUrl}/api/avatars/pixel/${encode("not-a-real-avatar")}.svg`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  assert.equal(await response.text(), renderPixelAvatarSvg(DEFAULT_PIXEL_AVATAR_KEY));
  // Not immutable: once this server knows the key, the real sprite must show.
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
});

test("GET /api/avatars/pixel/:key.svg serves a known key, immutable", async ({ app }) => {
  const response = await fetch(`${app.baseUrl}/api/avatars/pixel/${encode("cat")}.svg`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), renderPixelAvatarSvg("cat"));
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
});

test("GET /api/avatars/pixel/:key.svg still rejects a malformed key", async ({ app }) => {
  const response = await fetch(`${app.baseUrl}/api/avatars/pixel/not%20base64.svg`);
  assert.equal(response.status, 400);
});
