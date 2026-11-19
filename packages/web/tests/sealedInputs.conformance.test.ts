import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, vi } from "vitest";
import { createSealedInputsMemory, openSealedInputs } from "@botiverse/raft-shared/src/sealedInputs";
import { SEALED_INPUTS_VECTOR_PATH } from "@botiverse/raft-shared/src/sealedInputsVectors.testkit";
import type { SealedInputsOpenCase, SealedInputsVectors } from "@botiverse/raft-shared/src/sealedInputsVectors.testkit";
import { sealLinkCardSecrets } from "../src/components/message/linkCardSeal";
import type { LinkCardSealTo } from "../src/components/message/linkCardSeal";
import type { LinkCardMessageView } from "../src/components/message/linkCardExecute";

// RFC 086 §5.3 ("one shared set of test vectors passes on web, iOS, Android
// and in Vault"): the web against packages/shared/src/sealedInputs.v1.vector.json.
// - open: every case gives its expected result through the reference check;
// - seal: each case sealed the way the web seals (linkCardSeal.ts, from the
//   case's client inputs: the view's viewer and Server, the handle, the
//   action, the prepared action, the request id and the handle's expiry)
//   carries exactly the case's header (but `epk`) and opens to its values.
// createSealedInputsMemory is the App's one-process replay memory: the
// reference check needs one, so it is used here; the web keeps no such thing.

const vectors = JSON.parse(readFileSync(SEALED_INPUTS_VECTOR_PATH, "utf8")) as SealedInputsVectors;
const at = (seconds: number) => new Date(seconds * 1000);
const keyPair = (kid: string) => {
  const pair = vectors.keys.find((key) => key.publicJwk.kid === kid);
  assert.ok(pair, `vector key ${kid}`);
  return pair;
};
// The protected header, as JSON (the first segment); `jose` is shared's dependency, not the web's.
const protectedHeader = (jwe: string) => JSON.parse(Buffer.from(jwe.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
const format = ((descriptor: { id: string }) => descriptor.id) as Parameters<typeof sealLinkCardSecrets>[0]["format"];

afterEach(() => {
  vi.useRealTimers();
});

async function open(c: SealedInputsOpenCase) {
  const memory = createSealedInputsMemory({ now: () => at(c.now) });
  for (const delivery of c.accepted) assert.equal(memory.remember(delivery), true);
  return openSealedInputs({ jwe: c.jwe, keys: c.keys.map((kid) => keyPair(kid).privateJwk), claims: c.claims, now: at(c.now), remember: memory.remember });
}

test("the vectors are the test-only sealed-inputs.v1 set", () => {
  assert.equal(vectors.contract, "sealed-inputs.v1");
  assert.equal(vectors.testOnly, true);
  assert.ok(vectors.open.length > 0 && vectors.seal.length > 0);
});

test("every open case gives its expected result through the reference check", async () => {
  for (const c of vectors.open) assert.deepEqual(await open(c), c.expect, c.name);
});

test("every seal case, sealed as the web seals, has the case's header and opens to its values", async () => {
  for (const c of vectors.seal) {
    const inputs = c.bindingInputs;
    assert.ok(inputs.prepared, `${c.name}: a SecretInput button is always prepared`);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(c.now));
    const sealTo: LinkCardSealTo = { key: keyPair(c.key).publicJwk, clientKey: inputs.appClientKey, handleExp: inputs.handleExp, revision: "3" };
    const view: LinkCardMessageView = {
      key: `${inputs.userId}:${inputs.serverId}|message-1`,
      messageId: "message-1",
      // The read right before sealing answers the same key: nothing changed.
      reread: async () => ({ kind: "read", result: { kind: "card", url: "https://vault.example.test/k", app: { name: "Vault", icon: null }, title: "Save", sealsTo: { [inputs.actionId]: { ...sealTo, handleExp: inputs.handleExp + 600 } } } }),
      beginExecute: () => {},
    };
    const values = new Map(Object.entries(c.values));
    const jwe = await sealLinkCardSecrets(
      { viewerKey: `${inputs.userId}:${inputs.serverId}`, view, url: "https://vault.example.test/k", format },
      { actionId: inputs.actionId, handle: inputs.handle, prepared: inputs.prepared, clientRequestId: inputs.clientRequestId, sealTo, values },
    );
    vi.useRealTimers();
    assert.ok(jwe, c.name);
    assert.equal(values.size, 0, `${c.name}: the values are dropped once sealed`);
    const { epk, ...header } = protectedHeader(jwe);
    assert.ok(epk, c.name);
    assert.deepEqual(header, c.header, c.name);
    const opened = await openSealedInputs({ jwe, keys: [keyPair(c.key).privateJwk], claims: c.claims, now: at(c.now), remember: createSealedInputsMemory().remember });
    assert.deepEqual(opened, { ok: true, values: c.values }, c.name);
  }
});
