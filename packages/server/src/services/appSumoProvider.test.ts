import { test } from "vitest";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createAppSumoProvider, parseAppSumoWebhook, verifyAppSumoSignature } from "./appSumoProvider";
import { parseAppSumoLicenseKey } from "./appSumoContracts";

const key = parseAppSumoLicenseKey("11111111-1111-4111-8111-111111111111")!;
const now = new Date("2026-10-28T00:00:00Z");
const secret = "synthetic-appsumo-api-key";
const rawBody = Buffer.from(JSON.stringify({ license_key: key, event: "activate", license_status: "inactive", tier: 2,
  event_timestamp: now.getTime(), created_at: now.getTime() - 1000, test: false }));

test("webhook uses exact signed bytes and header time, not retry-sensitive event time", () => {
  for (const timestamp of [String(now.getTime() / 1000), String(now.getTime())]) {
    const signature = createHmac("sha256", secret).update(timestamp).update(rawBody).digest("hex");
    const input = { timestamp, signature, rawBody, apiKey: secret, now };
    assert.equal(verifyAppSumoSignature(input), true);
    assert.equal(verifyAppSumoSignature({ ...input, rawBody: Buffer.concat([rawBody, Buffer.from(" ")]) }), false);
    assert.equal(verifyAppSumoSignature({ ...input, apiKey: "another-key" }), false);
    assert.equal(verifyAppSumoSignature({ ...input, now: new Date(now.getTime() + 301_000) }), false);
    assert.equal(verifyAppSumoSignature({ ...input, signature: "00" }), false);
    assert.equal(verifyAppSumoSignature({ ...input, timestamp: undefined }), false);
  }
  assert.equal(parseAppSumoWebhook(rawBody)?.event, "activate");
  assert.equal(parseAppSumoWebhook(Buffer.from(rawBody.toString().replace('"tier":2', '"tier":5'))), null);
  assert.equal(parseAppSumoWebhook(Buffer.from(rawBody.toString().replace('"activate"', '"upgrade"'))), null);
  assert.equal(parseAppSumoWebhook(Buffer.from("[")), null);
  assert.equal(parseAppSumoWebhook(Buffer.alloc(65_537)), null);
});

test("provider exchanges code only with configured redirect and validates returned license identity", async () => {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const config = { productId: "fixture", apiKey: secret, clientId: "fixture-client", clientSecret: "fixture-secret", redirectUri: "https://api.example.test/api/appsumo/oauth/callback" };
  const provider = createAppSumoProvider(config, (async (url, init) => {
    requests.push({ url: new URL(String(url)), init });
    const data = requests.length === 1 ? { access_token: "fixture-oauth-token", token_type: "bearer" }
      : { license_key: key, status: "active", tier: 2 };
    return new Response(JSON.stringify(data), { status: 200 });
  }) as typeof fetch);
  assert.equal(await provider.exchangeCode("fixture-code-123"), key);
  assert.equal(requests[0].url.href, "https://appsumo.com/openid/token/");
  assert.equal(JSON.parse(String(requests[0].init?.body)).redirect_uri, config.redirectUri);
  assert.equal(requests[1].url.searchParams.get("access_token"), "fixture-oauth-token");
  assert.equal(requests.every((request) => request.init?.redirect === "error"), true);
  assert.deepEqual(await provider.getLicense(key), { licenseKey: key, status: "active", tier: 2 });
  assert.equal(new Headers(requests[2].init?.headers).get("X-AppSumo-Licensing-Key"), secret);
  const mismatch = createAppSumoProvider(config, (async () => new Response(JSON.stringify({ license_key: "22222222-2222-4222-8222-222222222222", status: "active", tier: 2 }))) as typeof fetch);
  await assert.rejects(mismatch.getLicense(key), /invalid_response/);
  const network = createAppSumoProvider(config, (async () => { throw new Error("url?access_token=fixture-oauth-token"); }) as typeof fetch);
  await assert.rejects(network.exchangeCode("fixture-code-123"), (error: Error) => !error.message.includes("fixture-oauth-token") && error.message.includes("unavailable"));
});
