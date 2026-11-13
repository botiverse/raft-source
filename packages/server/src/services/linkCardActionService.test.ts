import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { canonicalJsonSha256 } from "../lib/canonicalJson";
import { linkCardRequestSha256, parseLinkCardExecuteBody, parseLinkCardPrepareBody } from "./linkCardActionService";

test("the intent digest (protocol §5.3.1) is the JCS SHA-256 of R; prepared fields only when present, the native description slot last", () => {
  const base = { urlSha256: "a".repeat(64), actionId: "merge", handleSha256: "b".repeat(64) };
  assert.equal(linkCardRequestSha256({ ...base, prepared: null }), canonicalJsonSha256({ url_sha256: base.urlSha256, action_id: "merge", handle_sha256: base.handleSha256 }));
  const prepared = { actionId: randomUUID(), digest: "c".repeat(64) };
  const withPrepared = linkCardRequestSha256({ ...base, prepared });
  assert.equal(withPrepared, canonicalJsonSha256({ handle_sha256: base.handleSha256, prepared_digest: prepared.digest, action_id: "merge",
    prepared_action_id: prepared.actionId, url_sha256: base.urlSha256 }), "key order never matters");
  assert.notEqual(withPrepared, linkCardRequestSha256({ ...base, prepared: { ...prepared, digest: "d".repeat(64) } }), "another confirmation is another intent");
  assert.notEqual(linkCardRequestSha256({ ...base, prepared, preparedDescriptionSha256: "e".repeat(64) }), withPrepared);
});

test("bodies: exactly the protocol's fields, own properties only", () => {
  const handle = "v1.k1.x.y";
  assert.deepEqual(parseLinkCardPrepareBody({ handle, claimed: { business_revision: "br" } }), { handle, claimedBusinessRevision: "br" });
  assert.equal(parseLinkCardPrepareBody(Object.assign(Object.create({ handle }), { claimed: { business_revision: "br" } })), null, "never through the prototype");
  assert.equal(parseLinkCardPrepareBody(JSON.parse(`{"handle":"${handle}","claimed":{"business_revision":"br"},"__proto__":{}}`)), null);
  const crid = "c".repeat(16);
  assert.deepEqual(parseLinkCardExecuteBody({ client_request_id: crid, handle }), { clientRequestId: crid, handle, prepared: null });
  const pa = randomUUID();
  assert.deepEqual(parseLinkCardExecuteBody({ client_request_id: crid, handle, prepared_action_id: pa, prepared_digest: "f".repeat(64) }),
    { clientRequestId: crid, handle, prepared: { actionId: pa, digest: "f".repeat(64) } });
  assert.equal(parseLinkCardExecuteBody({ client_request_id: crid, handle, prepared_digest: "f".repeat(64) }), null);
  assert.equal(parseLinkCardExecuteBody({ client_request_id: crid, handle, prepared_action_id: pa.toUpperCase(), prepared_digest: "f".repeat(64) }), null);
  assert.equal(parseLinkCardExecuteBody({ client_request_id: crid, handle, prepared_description: {} }), null);
});
