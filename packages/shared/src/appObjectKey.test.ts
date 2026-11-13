import assert from "node:assert/strict";
import vectors from "./testVectors/appObjectKeys.vectors.json" with { type: "json" };
import { appObjectKeyProblem, APP_OBJECT_KEY_MAX_BYTES } from "./appObjectKey";

describe("appObjectKeyProblem", () => {
  it("answers every shared case as the vectors say", () => {
    assert.equal(vectors.prefix, "apps/artifacts/");
    for (const { why, key, problem } of vectors.cases) assert.equal(appObjectKeyProblem(vectors.prefix, key), problem, why);
  });

  it("counts the prefix in the length limit", () => {
    const key = "x".repeat(APP_OBJECT_KEY_MAX_BYTES - "apps/a/".length);
    assert.equal(appObjectKeyProblem("apps/a/", key), null);
    assert.match(appObjectKeyProblem("apps/ab/", key) ?? "", /^longer than/);
  });
});
