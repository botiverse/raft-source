import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  decryptProductFeedbackRouteSubject,
  deriveProductFeedbackRouteMaterial,
  feedbackRouteTuple,
  mintProductFeedbackRouteSubject,
} from "./productFeedbackRouteSubject.js";

describe("product feedback route subject", () => {
  const root = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
  const reporterRoot = Buffer.from("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f", "hex").toString();
  const userId = "00000000-0000-4000-8000-000000000001";
  const appId = "11111111-1111-4111-8111-111111111111";
  const reporterIntegrationId = `legacy-feedback:${appId}`;
  const reporterId = "7FKVzP8KOc8O-Sf-Gh5UwW_CR1_Qa6uqGxmm5wq8mYc";
  const coordinate = { appId, reporterIntegrationId, reporterId };

  it("matches the v1 fixed vector and decrypts with reporter ownership", () => {
    const material = deriveProductFeedbackRouteMaterial(root, coordinate);
    assert.equal(material.encKey.toString("hex"), "7fe18c7711e8c2699bf9fd0b0f34b2a1eabce4b18a469cd7e5f5102ab71043dd");
    assert.equal(material.nonceKey.toString("hex"), "6f8794de8e419e7451a132185699a322e8710ee6ec9e2aa9c671cca7eb3c8ba9");
    const subject = mintProductFeedbackRouteSubject({ root, userId, coordinate });
    assert.equal(subject, "rfr_v1_afyFkJ7MiaUIDZdyIYMj3sI3k3lJ3Ngr5R-5baag0DyXyRd1gTucsWBH9J9nQKsZSpFZRmaqdd4W_YwXS5r5UQ");
    assert.equal(decryptProductFeedbackRouteSubject({
      root, reporterIdSecret: reporterRoot, subject, coordinate,
    }), userId);
  });

  it("rejects copied coordinates and noncanonical subjects", () => {
    const subject = mintProductFeedbackRouteSubject({ root, userId, coordinate });
    assert.throws(() => decryptProductFeedbackRouteSubject({
      root, reporterIdSecret: reporterRoot, subject: `${subject}=`, coordinate,
    }));
    assert.throws(() => decryptProductFeedbackRouteSubject({
      root, reporterIdSecret: reporterRoot, subject,
      coordinate: { ...coordinate, reporterId: `${reporterId.slice(0, -1)}A` },
    }));
  });

  it("isolates derived key and raw nonce material across every route coordinate", () => {
    const variants = [
      { ...coordinate, appId: "22222222-2222-4222-8222-222222222222" },
      { ...coordinate, reporterIntegrationId: `${reporterIntegrationId}-other` },
      { ...coordinate, reporterId: `${reporterId.slice(0, -1)}A` },
    ];
    const baselineMaterial = deriveProductFeedbackRouteMaterial(root, coordinate);
    const baselineSubject = mintProductFeedbackRouteSubject({ root, userId, coordinate });
    const baselineNonce = Buffer.from(baselineSubject.slice("rfr_v1_".length), "base64url").subarray(0, 12);
    for (const variant of variants) {
      const derived = deriveProductFeedbackRouteMaterial(root, variant);
      const subject = mintProductFeedbackRouteSubject({ root, userId, coordinate: variant });
      const nonce = Buffer.from(subject.slice("rfr_v1_".length), "base64url").subarray(0, 12);
      assert.notDeepEqual(derived.encKey, baselineMaterial.encKey);
      assert.notDeepEqual(derived.nonceKey, baselineMaterial.nonceKey);
      assert.notDeepEqual(nonce, baselineNonce);
    }
  });

  it("uses byte lengths and a fixed-width multi-field count", () => {
    const encoded = feedbackRouteTuple("é", ...Array.from({ length: 11 }, (_, i) => String(i)));
    assert.equal(encoded.readUInt32BE(0), 12);
    assert.equal(encoded.readUInt32BE(4), 2);
  });
});
