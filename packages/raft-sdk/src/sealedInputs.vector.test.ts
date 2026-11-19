// `./app`'s sealed inputs (RFC 086 §5.3) are shared's one implementation,
// re-exported: the same functions, and the shared vectors pass through the
// SDK's entry. The full vector suite is shared's sealedInputs.vector.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as shared from "@botiverse/raft-shared/src/sealedInputs";
import type { SealedInputsVectors } from "@botiverse/raft-shared/src/sealedInputsVectors.testkit";
import * as app from "./app";

const vectors = JSON.parse(
  readFileSync(new URL("../../shared/src/sealedInputs.v1.vector.json", import.meta.url), "utf8"),
) as SealedInputsVectors;
const at = (seconds: number) => new Date(seconds * 1000);

test("./app re-exports shared's functions, not a copy", () => {
  for (const name of ["openSealedInputs", "sealInputs", "sealedInputsBinding", "createSealedInputsMemory"] as const) {
    assert.equal(app[name], shared[name], name);
  }
});

test("every open case gives its expected result through ./app", async () => {
  assert.ok(vectors.open.length > 0);
  for (const c of vectors.open) {
    const memory = app.createSealedInputsMemory({ now: () => at(c.now) });
    for (const delivery of c.accepted) assert.equal(memory.remember(delivery), true);
    const keys = c.keys.map((kid) => vectors.keys.find((k) => k.publicJwk.kid === kid)!.privateJwk);
    assert.deepEqual(await app.openSealedInputs({ jwe: c.jwe, keys, claims: c.claims, now: at(c.now), remember: memory.remember }), c.expect, c.name);
  }
});

test("every seal case round-trips through ./app, its binding built from the client's inputs", async () => {
  for (const c of vectors.seal) {
    const key = vectors.keys.find((k) => k.publicJwk.kid === c.key)!;
    const binding = await app.sealedInputsBinding(c.bindingInputs);
    assert.deepEqual(binding, c.binding, c.name);
    const jwe = await app.sealInputs({ key: key.publicJwk, binding, values: c.values });
    const opened = await app.openSealedInputs({ jwe, keys: [key.privateJwk], claims: c.claims, now: at(c.now), remember: app.createSealedInputsMemory().remember });
    assert.deepEqual(opened, { ok: true, values: c.values }, c.name);
  }
});
