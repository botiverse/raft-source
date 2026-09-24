import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_PACKAGE_ROOT,
  analyzeOperatorClientLifetimeSources,
  checkOperatorClientLifetimePackage,
} from "./check-operator-client-lifetime.mjs";

function analyzeFixture(fixtureName) {
  const fixturePath = `scripts/fixtures/${fixtureName}`;
  return analyzeOperatorClientLifetimeSources(
    [
      {
        path: fixturePath,
        source: readFileSync(
          path.join(DEFAULT_PACKAGE_ROOT, fixturePath),
          "utf8",
        ),
      },
    ],
    { ownerFile: fixturePath },
  );
}

test("current tree satisfies the direct-call PG lifetime regression contract", () => {
  assert.deepEqual(
    checkOperatorClientLifetimePackage(DEFAULT_PACKAGE_ROOT),
    [],
  );
});

test("verify-the-verifier rejects a direct PG client lifetime bypass", () => {
  const diagnostics = analyzeFixture("direct-pg-client-bypass.ts");

  assert.deepEqual(
    diagnostics.map(({ code, method }) => ({ code, method })),
    [
      { code: "lifetime-call-outside-owner", method: "connect" },
      { code: "lifetime-call-outside-owner", method: "end" },
    ],
  );
  assert.ok(
    diagnostics.every((diagnostic) =>
      diagnostic.message.includes("must be owned by"),
    ),
  );
});

test("verify-the-verifier rejects the original unawaited operation regression", () => {
  const diagnostics = analyzeFixture("unawaited-operation.ts");

  assert.deepEqual(
    diagnostics.map(({ code }) => code),
    ["unawaited-operation"],
  );
  assert.match(diagnostics[0].message, /must await operation\(client\)/);
});

test("verify-the-verifier rejects client end outside finally", () => {
  const diagnostics = analyzeFixture("end-outside-finally.ts");

  assert.deepEqual(
    diagnostics.map(({ code }) => code),
    ["owner-try-finally-shape"],
  );
  assert.match(diagnostics[0].message, /await client\.end\(\) in its finally/);
});

test("verify-the-verifier pins the direct Client factory ownership chain", () => {
  const fixturePath = "scripts/fixtures/unawaited-operation.ts";
  const source = readFileSync(
    path.join(DEFAULT_PACKAGE_ROOT, fixturePath),
    "utf8",
  ).replace(
    "const client = getClient(env);",
    "const client = new Client({ connectionString: env.connectionString });",
  );
  const diagnostics = analyzeOperatorClientLifetimeSources(
    [{ path: fixturePath, source }],
    { ownerFile: fixturePath },
  );

  assert.ok(
    diagnostics.some(({ code }) => code === "client-construction-count"),
  );
  assert.ok(
    diagnostics.some(
      ({ code }) => code === "client-construction-outside-factory",
    ),
  );
  assert.ok(
    diagnostics.some(({ code }) => code === "client-factory-call-count"),
  );
});
