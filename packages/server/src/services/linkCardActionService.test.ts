import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { test } from "vitest";
import { MESSAGE_CARD_SEALED_INPUTS_MAX_BYTES } from "@botiverse/raft-shared";
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
  const execute = (body: unknown) => {
    const parsed = parseLinkCardExecuteBody(body);
    return "refused" in parsed ? parsed : { ...parsed, form: parsed.form.submission };
  };
  const none = { sealedInputs: null, inputs: null };
  assert.deepEqual(execute({ client_request_id: crid, handle }), { clientRequestId: crid, handle, prepared: null, form: none });
  const pa = randomUUID();
  assert.deepEqual(execute({ client_request_id: crid, handle, prepared_action_id: pa, prepared_digest: "f".repeat(64) }),
    { clientRequestId: crid, handle, prepared: { actionId: pa, digest: "f".repeat(64) }, form: none });
  assert.deepEqual(execute({ client_request_id: crid, handle, prepared_digest: "f".repeat(64) }), { refused: 400 });
  assert.deepEqual(execute({ client_request_id: crid, handle, prepared_action_id: pa.toUpperCase(), prepared_digest: "f".repeat(64) }), { refused: 400 });
  assert.deepEqual(execute({ client_request_id: crid, handle, prepared_description: {} }), { refused: 400 });
});

test("RFC 086 §5.4: sealed_inputs and inputs on execute: an opaque JWE compact string under its cap, read first; TextInput values by field id; never shown", () => {
  const handle = "v1.k1.x.y";
  const crid = "c".repeat(16);
  const sealed = `${"h".repeat(40)}..${"i".repeat(16)}.${"c".repeat(64)}.${"t".repeat(22)}`;
  const parsed = parseLinkCardExecuteBody({ client_request_id: crid, handle, sealed_inputs: sealed, inputs: { name: "deploy-key-prod" } });
  assert.ok(!("refused" in parsed));
  assert.deepEqual(parsed.form.submission, { sealedInputs: sealed, inputs: { name: "deploy-key-prod" } });
  // Serialized or inspected (a log line, an error report), the values never show: only that there were some.
  assert.equal(JSON.stringify(parsed), JSON.stringify({ clientRequestId: crid, handle, prepared: null, form: { sealed: true, inputs: true } }));
  assert.ok(!inspect(parsed, { depth: 5 }).includes(sealed) && !inspect(parsed, { depth: 5 }).includes("deploy-key-prod"), inspect(parsed));
  assert.ok(!String(parsed.form).includes("deploy-key-prod"));

  const refused = (body: Record<string, unknown>) => {
    const answer = parseLinkCardExecuteBody(body);
    return "refused" in answer ? answer.refused : "parsed";
  };
  const base = { client_request_id: crid, handle };
  assert.equal(refused({ ...base, sealed_inputs: "x".repeat(MESSAGE_CARD_SEALED_INPUTS_MAX_BYTES + 1) }), 413, "over the cap, whatever its shape");
  assert.equal(refused({ ...base, sealed_inputs: `${sealed.slice(0, 1)}${"c".repeat(MESSAGE_CARD_SEALED_INPUTS_MAX_BYTES - sealed.length)}${sealed.slice(1)}` }), "parsed", "at the cap");
  // The cap is checked before anything else of the body: an over-cap value next to an unknown member or a bad handle is still 413.
  assert.equal(refused({ sealed_inputs: "x".repeat(MESSAGE_CARD_SEALED_INPUTS_MAX_BYTES + 1), handle: 7, extra: true }), 413);
  for (const value of [{ v: sealed }, [sealed], 42, null, true, "", "not a jwe", "a.b.c.d", "a.b.c.d.e.f", `${sealed} `, `${sealed}\n`, "a..b.c.d+"]) {
    assert.equal(refused({ ...base, sealed_inputs: value }), 400, JSON.stringify(value));
  }
  for (const value of [[], "name", { name: 1 }, { name: null }, { Name: "x" }, { "1x": "x" }, { name: "x".repeat(501) }, { a: "", b: "", c: "", d: "", e: "" }]) {
    assert.equal(refused({ ...base, inputs: value }), 400, JSON.stringify(value));
  }
  assert.equal(refused({ ...base, inputs: { name: "é".repeat(500) } }), "parsed", "500 code points");
  assert.equal(refused({ ...base, inputs: {} }), "parsed", "an empty object parses; the form decides");
});
