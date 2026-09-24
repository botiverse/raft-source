import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const schemaDir = resolve(root, "generated/json-schema");
const decimalPattern = "^(0|[1-9][0-9]*)$";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonLines(path) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${index + 1}: ${error.message}`);
      }
    });
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function treeSha256(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort((a, b) => relative(directory, a).localeCompare(relative(directory, b)));
  const index = [];
  for (const path of files) {
    index.push(`${await sha256(path)}  ${relative(directory, path)}\n`);
  }
  return createHash("sha256").update(index.join("")).digest("hex");
}

function isSealed(schema) {
  return schema.additionalProperties === false ||
    schema.unevaluatedProperties === false ||
    JSON.stringify(schema.additionalProperties) === JSON.stringify({ not: {} }) ||
    JSON.stringify(schema.unevaluatedProperties) === JSON.stringify({ not: {} });
}

// The emitter bundles every model into one compound document (`bundleId`).
// Embedded resources keep their own `$id`, so ajv resolves them by `$id` —
// NOT by a `#/$defs/...` pointer. Everything below therefore still addresses
// models as "ActivityIngress.json", exactly as it did when they were files.
const bundlePath = resolve(schemaDir, "activity-sync.schema.json");
const bundle = await readJson(bundlePath);
const schemas = new Map();
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(bundle, "activity-sync.schema.json");
for (const definition of Object.values(bundle.$defs ?? {})) {
  if (definition && typeof definition === "object" && typeof definition.$id === "string") {
    schemas.set(definition.$id, definition);
  }
}
assert(schemas.size > 0, "the bundle must expose its models under $defs with retained $id");

const ingressSchema = schemas.get("ActivityIngress.json");
const intentSchema = schemas.get("ActivityIntent.json");
assert.equal(ingressSchema.oneOf.length, 7, "ActivityIngress must have seven branches");
assert.equal(intentSchema.oneOf.length, 7, "ActivityIntent must have seven branches");

const ingressBranches = [
  ["SnapshotIngress.json", "snapshot"],
  ["NotModifiedIngress.json", "notModified"],
  ["DifferenceIngress.json", "difference"],
  ["FrameIngress.json", "frame"],
  ["CommandReceiptIngress.json", "commandReceipt"],
  ["CommandRejectedIngress.json", "commandRejected"],
  ["ReadStateUpdatedIngress.json", "readStateUpdated"],
];
for (const [name, discriminator] of ingressBranches) {
  const schema = schemas.get(name);
  assert(isSealed(schema), `${name} must be sealed`);
  assert(schema.required.includes("type"), `${name} type must be required`);
  assert.equal(schema.properties.type.const, discriminator, `${name} discriminator must stay literal`);
}

const uint64 = schemas.get("UInt64String.json");
assert.equal(uint64.type, "string");
assert.equal(uint64.pattern, decimalPattern);

const difference = schemas.get("DifferenceIngress.json");
assert(difference.required.includes("nextFromSeq"));
assert(
  JSON.stringify(difference.properties.nextFromSeq).includes('"type":"null"'),
  "nextFromSeq must remain required nullable",
);

const openapi = await readJson(resolve(root, "generated/openapi/openapi.json"));
assert.equal(openapi.components.schemas.UInt64String.type, "string");
assert.equal(openapi.components.schemas.UInt64String.pattern, decimalPattern);
for (const [path, method] of [
  ["/api/channels/activity/snapshot", "get"],
  ["/api/channels/activity/difference", "get"],
  ["/api/channels/inbox", "get"],
  ["/api/channels/inbox/read-all", "post"],
  ["/api/channels/{channelId}/read-all", "post"],
  ["/api/channels/inbox/done", "post"],
  ["/api/channels/threads/done", "post"],
]) {
  const operation = openapi.paths[path]?.[method];
  assert(operation, `OpenAPI must retain ${method.toUpperCase()} ${path}`);
  assert(operation.responses["200"], `${method.toUpperCase()} ${path} must retain 200`);
}
// GET /inbox never emits 304 — the handler has no conditional-request path.
// This standalone assertion outlived the per-status loop it belonged to and was
// still pinning the invented contract; EXPECTED_OPERATIONS now owns the table.
// The per-status expectations moved to EXPECTED_OPERATIONS below, which pins
// the table BOTH ways against the real handlers. This loop previously required
// 400/401/403/409/503 on every route — statuses the Server never emits — so it
// was itself asserting the invented contract.

const validateVectorEnvelope = ajv.getSchema("ContractVectorEnvelope.json");
const validateIngress = ajv.getSchema("ActivityIngress.json");
const validateIntent = ajv.getSchema("ActivityIntent.json");
assert(validateVectorEnvelope && validateIngress && validateIntent);
const vectors = await readJsonLines(
  resolve(root, "fixtures/activity-sync.contract-vectors.jsonl"),
);
const INTENT_TYPES = new Set([
  "ensureWindow",
  "refresh",
  "loadMore",
  "markChannelReadAll",
  "markInboxReadAll",
  "markThreadDone",
  "markInboxDone",
]);
const ingressCounts = { positive: 0, structural: 0, valueDomain: 0 };
const intentCounts = { positive: 0, structural: 0, valueDomain: 0 };
for (const vector of vectors) {
  assert(
    validateVectorEnvelope(vector),
    `${vector.vectorId ?? "unknown"} vector envelope invalid: ${ajv.errorsText(validateVectorEnvelope.errors)}`,
  );
  const isIntent = INTENT_TYPES.has(vector.candidate.type);
  const counts = isIntent ? intentCounts : ingressCounts;
  counts[vector.constraintClass] += 1;
  const validate = isIntent ? validateIntent : validateIngress;
  const accepted = validate(vector.candidate);
  const expected = vector.expectation.validator === "accept";
  assert.equal(
    accepted,
    expected,
    `${vector.vectorId} validator mismatch: ${ajv.errorsText(validate.errors)}`,
  );
  if (vector.constraintClass === "positive") {
    assert.deepEqual(vector.expectation, {
      validator: "accept",
      typescriptStatic: "accept",
      kotlinRuntime: "accept",
    });
  } else if (vector.constraintClass === "structural") {
    assert.deepEqual(vector.expectation, {
      validator: "reject",
      typescriptStatic: "reject",
      kotlinRuntime: "reject",
    });
  } else {
    assert.deepEqual(vector.expectation, {
      validator: "reject",
      typescriptStatic: "exempt",
      kotlinRuntime: "reject",
    });
  }
}
assert.deepEqual(ingressCounts, { positive: 3, structural: 7, valueDomain: 3 });
assert.deepEqual(intentCounts, { positive: 1, structural: 3, valueDomain: 1 });

const validateFixtureEnvelope = ajv.getSchema("ActivityFixtureEnvelope.json");
assert(validateFixtureEnvelope);
const behaviorSeeds = await readJsonLines(
  resolve(root, "fixtures/activity-sync.behavior.seed.jsonl"),
);
for (const seed of behaviorSeeds) {
  assert(
    validateFixtureEnvelope(seed),
    `${seed.caseId ?? "unknown"} fixture invalid: ${ajv.errorsText(validateFixtureEnvelope.errors)}`,
  );
  const seen = new Set(
    seed.steps
      .filter((step) => step.type === "ingest")
      .map((step) => step.ingress.type),
  );
  assert.deepEqual(
    [...seen].sort(),
    ingressBranches.map(([, type]) => type).sort(),
    "seed must exercise all seven ingress branches",
  );
}

const bindingPath = resolve(root, "generated/bindings/activity-sync.ts");
const binding = await readFile(bindingPath, "utf8");
assert(binding.includes("Generated directly from activity-sync.tsp via the TypeSpec compiler semantic graph."));
assert(binding.includes("export type UInt64String = string;"));
assert(binding.includes("Runtime raw-byte validation remains mandatory"));
assert(!binding.includes("[key: string]"));
const parsed = ts.createSourceFile(
  bindingPath,
  binding,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
assert.equal(parsed.parseDiagnostics.length, 0, "generated TypeScript must parse cleanly");
for (const name of ["ActivityIngress", "ActivityIntent", "ActivityRow", "ActivityFixtureStep"]) {
  assert(binding.includes(`export type ${name} =`), `generated TypeScript must export ${name}`);
}

// ── executable behavior vectors ───────────────────────────────────────────
// The seed above is a decode/envelope fixture. THIS is the file the runners
// actually execute, and until now nothing validated it, hashed it, or checked
// what it covers: replacing `manifest.behaviorVectorsSha256` with 64 zeroes
// still printed PASS.
const behaviorVectorsPath = resolve(root, "fixtures/activity-sync.behavior.jsonl");
const behaviorVectors = await readJsonLines(behaviorVectorsPath);
assert(behaviorVectors.length > 0, "executable behavior vectors must not be empty");

const sequencedBranches = new Set([
  "snapshot",
  "notModified",
  "difference",
  "frame",
  "readStateUpdated",
]);
const coveredBranches = new Set();
const caseIds = new Set();
for (const envelope of behaviorVectors) {
  assert(
    validateFixtureEnvelope(envelope),
    `${envelope.caseId ?? "unknown"} behavior vector invalid: ${ajv.errorsText(validateFixtureEnvelope.errors)}`,
  );
  assert(!caseIds.has(envelope.caseId), `duplicate behavior caseId ${envelope.caseId}`);
  caseIds.add(envelope.caseId);
  for (const step of envelope.steps) {
    assert.equal(step.type, "ingest", `${envelope.caseId}: runnerProtocol 1 only executes ingest steps`);
    const branch = step.ingress.type;
    assert(
      sequencedBranches.has(branch),
      `${envelope.caseId}: ${branch} is not sequenced by runnerProtocol 1`,
    );
    coveredBranches.add(branch);
  }
}
assert.deepEqual(
  [...coveredBranches].sort(),
  [...sequencedBranches].sort(),
  "the executable vectors must exercise every sequenced ingress branch",
);

// ── legacy lossy numbers must not reach the exact sequence path ───────────
// V1 read-all responses carry seq/version as JSON numbers (the live server
// types them `number`), so they are only trustworthy inside the JS safe range.
// The core's exactness proof assumes wire-exact values; promoting one of these
// into a SyncSeq would silently reintroduce the 2^53 defect the contract exists
// to prevent. Pin both halves: they stay `safeint`, and they stay OUT of the
// ingress union the reducer consumes.
const legacyNumberModels = ["V1AffectedReadState", "V1MarkChannelReadAllResponse"];
for (const name of legacyNumberModels) {
  const model = schemas.get(`${name}.json`);
  assert(model, `${name} must exist in the bundle`);
  for (const [field, node] of Object.entries(model.properties ?? {})) {
    if (!["maxReadSeq", "readStateVersion", "seq"].includes(field)) continue;
    // Follow the $ref: these fields now point at the bounded scalar, so
    // inspecting the inline node alone would silently assert nothing.
    const resolved = node.$ref ? schemas.get(String(node.$ref)) : node;
    assert(resolved, `${name}.${field} must resolve to a schema`);
    assert.equal(
      resolved.type,
      "integer",
      `${name}.${field} must stay a JSON number — it is legacy lossy, not exact`,
    );
    assert(
      !("pattern" in resolved),
      `${name}.${field} must not be dressed as a decimal string; it is not wire-exact`,
    );
    assert.equal(
      resolved.maximum,
      9007199254740991,
      `${name}.${field} must carry the JS safe-integer ceiling`,
    );
  }
}
const ingressBranchNames = new Set(
  (ingressSchema.oneOf ?? []).map((branch) => String(branch.$ref ?? "")),
);
for (const name of legacyNumberModels) {
  assert(
    !ingressBranchNames.has(`${name}.json`),
    `${name} must never be an ActivityIngress branch — lossy numbers must not enter the reducer`,
  );
}

// ── operation table conformance ───────────────────────────────────────────
// @赵梓淇 deleted the 404 from five routes, regenerated, and every existing
// gate stayed green: the verifier pinned models but never the operation table,
// so it could certify an operation contract the Server does not implement.
// This pins the table BOTH ways — every declared status/body must be expected,
// and every expected one must be declared — so neither dropping nor inventing
// a response can pass.
const openapiPaths = openapi.paths ?? {};
const EXPECTED_OPERATIONS = {
  // Derived from all THREE layers, not just the handler body: the handler's own
  // res.status calls, the auth middleware (401/403 on every route), and the
  // shared sendCompatibilityReadPending helper (202 on all four writes). Two
  // earlier attempts read only the handler and shipped a table that was still
  // wrong.
  // requireServer returns 400 when X-Server-Id is absent, on EVERY route under
  // /api/channels — a second middleware I missed while enumerating the first.
  "/api/channels/activity/snapshot": { get: { statuses: ["200", "400", "401", "403", "500"], requestBody: false } },
  "/api/channels/activity/difference": { get: { statuses: ["200", "400", "401", "403", "409", "500"], requestBody: false } },
  "/api/channels/inbox": { get: { statuses: ["200", "400", "401", "403", "500"], requestBody: false } },
  "/api/channels/inbox/read-all": { post: { statuses: ["200", "202", "400", "401", "403", "500"], requestBody: false } },
  "/api/channels/{channelId}/read-all": { post: { statuses: ["200", "202", "400", "401", "403", "404", "500"], requestBody: false } },
  "/api/channels/inbox/done": { post: { statuses: ["200", "202", "400", "401", "403", "404", "409", "412", "500"], requestBody: true } },
  "/api/channels/threads/done": { post: { statuses: ["200", "202", "400", "401", "403", "404", "409", "412", "500"], requestBody: true } },
};
assert.deepEqual(
  Object.keys(openapiPaths).sort(),
  Object.keys(EXPECTED_OPERATIONS).sort(),
  "the operation table must match the Server routes exactly — no invented or missing paths",
);
for (const [path, verbs] of Object.entries(EXPECTED_OPERATIONS)) {
  for (const [verb, expected] of Object.entries(verbs)) {
    const op = openapiPaths[path]?.[verb];
    assert(op, `${verb.toUpperCase()} ${path} must exist`);
    assert.deepEqual(
      Object.keys(op.responses ?? {}).sort(),
      [...expected.statuses].sort(),
      `${verb.toUpperCase()} ${path} statuses must match the real handler exactly`,
    );
    assert.equal(
      Boolean(op.requestBody),
      expected.requestBody,
      `${verb.toUpperCase()} ${path} requestBody presence must match the real handler`,
    );
  }
}
// Error bodies are the Server's legacy `{error}` family, never the V2
// ContractError. Done additionally exposes the machine-readable frontier code.
for (const [path, verbs] of Object.entries(openapiPaths)) {
  for (const [verb, op] of Object.entries(verbs)) {
    for (const [status, response] of Object.entries(op.responses ?? {})) {
      if (!/^[45]/.test(status)) continue;
      const ref = JSON.stringify(response.content?.["application/json"]?.schema ?? {});
      const expectedBody =
        path === "/api/channels/activity/difference" && status === "409"
          ? "SnapshotRequiredBody"
          : status === "401"
            ? "V1AuthErrorBody"
            : path.endsWith("/done") && status === "400"
              ? "V1DoneBadRequestBody"
              : path.endsWith("/done") && (status === "409" || status === "412")
                ? "V1DoneConflictBody"
                : "V1ErrorBody";
      assert(
        ref.includes(expectedBody),
        `${verb.toUpperCase()} ${path} ${status} must use ${expectedBody} — the real Server shape`,
      );
    }
  }
}

// The name is not the contract: swapping V1ErrorBody's fields for the V2
// {code,message,retryable} shape kept the reference check green, so pin the
// actual shape the Server emits.
const errorBody = schemas.get("V1ErrorBody.json");
assert(errorBody, "V1ErrorBody must exist");
assert.deepEqual(
  Object.keys(errorBody.properties ?? {}).sort(),
  ["error"],
  "V1 error body must be exactly {error} — that is what every route emits",
);
assert.deepEqual(errorBody.required, ["error"], "V1 error body's `error` is required");
assert.equal(errorBody.properties.error.type, "string");

const doneBadRequestBody = schemas.get("V1DoneBadRequestBody.json");
assert(doneBadRequestBody, "V1DoneBadRequestBody must exist");
assert.deepEqual(Object.keys(doneBadRequestBody.properties ?? {}).sort(), ["code", "error"]);
assert.deepEqual(doneBadRequestBody.required, ["error"], "legacy id errors omit code; frontier errors include it");
assert.equal(doneBadRequestBody.properties.code.type, "string");
const doneConflictBody = schemas.get("V1DoneConflictBody.json");
assert(doneConflictBody, "V1DoneConflictBody must exist");
assert.deepEqual(Object.keys(doneConflictBody.properties ?? {}).sort(), ["code", "error"]);
assert.deepEqual(doneConflictBody.required.sort(), ["code", "error"]);

for (const [modelName, idField] of [
  ["V1MarkInboxDoneRequest", "channelId"],
  ["V1MarkThreadDoneRequest", "threadChannelId"],
]) {
  const model = schemas.get(`${modelName}.json`);
  assert(model, `${modelName} must exist`);
  assert.deepEqual(
    [...model.required].sort(),
    [idField, "throughActivitySeq", "frontierSpace"].sort(),
    `${modelName} must require the storage-space Done frontier and its identity`,
  );
  assert.equal(model.properties.throughActivitySeq.$ref, "UInt64String.json");
  assert.deepEqual(model.properties.frontierSpace.enum ?? [model.properties.frontierSpace.const], ["storage"]);
}

// GET /inbox returns a PAGE, not the sync ingress union. Declaring the union
// meant a generated client could not decode the endpoint at all.
{
  const get200 = openapiPaths["/api/channels/inbox"].get.responses["200"];
  const ref = JSON.stringify(get200.content?.["application/json"]?.schema ?? {});
  assert(ref.includes("V1InboxPage"), "GET /inbox must return V1InboxPage");
  assert(
    !ref.includes("SnapshotIngress") && !ref.includes("DifferenceIngress"),
    "GET /inbox must not claim to return the sync ingress union",
  );
  const page = schemas.get("V1InboxPage.json");
  assert.deepEqual(
    Object.keys(page.properties ?? {}).sort(),
    ["activeUnreadCount", "hasMore", "items", "totalCount", "totalUnreadCount"],
    "V1InboxPage must match the real page body",
  );
}

// ── numeric domain must survive into the artifacts ────────────────────────
const counter = schemas.get("SafeUnsignedCounter.json");
assert(counter, "SafeUnsignedCounter must exist");
assert.equal(counter.type, "integer", "legacy counters stay JSON integers");
assert.equal(counter.minimum, 0, "legacy counters must carry a lower bound");
assert.equal(
  counter.maximum,
  9007199254740991,
  "legacy counters must carry the JS safe-integer ceiling — bare safeint emitted no bound at all",
);
assert(!("format" in counter), "must not claim int64: the wire cannot carry it");

// Every previous numeric gate was keyed on a NAME — a model whitelist plus a
// field whitelist. V1InboxPage's three counts were in neither, so they shipped
// as bare `safeint` with a floor and no ceiling: JSON Schema emitted no
// `maximum` and OpenAPI claimed `format: int64`, restating the exact
// overstatement SafeUnsignedCounter exists to prevent. A name-keyed gate cannot
// defend a model nobody remembered to add.
//
// Key it on the relationship instead: an integer on this wire is carried by a
// JSON number, so an open-ended integer always overstates its range. Every
// integer node must therefore carry BOTH bounds. Narrower ceilings (uint32,
// int32) are fine — the gate is finiteness, not one specific value — and any
// new bare `safeint` goes red without anyone maintaining a list.
{
  const openEnded = [];
  const seen = new Set();
  const walk = (node, model, path) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, model, path);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (node.type === "integer") {
      const key = `${model}.${path}`;
      if (!seen.has(key)) {
        seen.add(key);
        if (!Number.isFinite(node.minimum) || !Number.isFinite(node.maximum)) {
          openEnded.push(
            `${key} (minimum=${node.minimum ?? "absent"}, maximum=${node.maximum ?? "absent"})`,
          );
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && value && typeof value === "object") {
        for (const [prop, sub] of Object.entries(value)) {
          walk(sub, model, path ? `${path}.${prop}` : prop);
        }
      } else if (value && typeof value === "object") {
        walk(value, model, path);
      }
    }
  };
  for (const [name, schema] of schemas) walk(schema, name.replace(/\.json$/, ""), "");
  assert.deepEqual(
    openEnded,
    [],
    `every integer on the wire must carry both bounds — an open-ended integer overstates what a JSON number can carry:\n  ${openEnded.join("\n  ")}`,
  );
}

// ── the Kotlin canary must have no private copy of the binding ────────────
// It previously carried its own ActivitySync.kt, pinned to a voided digest and
// still containing the @JvmInline construct that breaks OHOS — and nothing
// compiled it, so it was a canary that could not sing.
{
  const canaryRoot = resolve(root, "canary-kotlin");
  const duplicates = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "ActivitySync.kt" || entry.name === "ActivitySyncContractFixtures.kt") {
        duplicates.push(full);
      }
    }
  };
  await walk(canaryRoot);
  assert.deepEqual(
    duplicates,
    [],
    "canary-kotlin must not copy any generated file — it must compile generated/bindings",
  );
  const gradle = await readFile(resolve(canaryRoot, "build.gradle.kts"), "utf8");
  assert(
    gradle.includes('srcDir("../generated/bindings")'),
    "canary-kotlin must source the canonical generated binding",
  );
}

const manifest = await readJson(resolve(root, "manifest.json"));
assert.equal(manifest.status, "experimental");
// Was `=== null` at freeze time, when no Kotlin binding existed. Now that the
// Kotlin leg is here it is pinned the same way every other binding is: the
// manifest value must equal the real file's digest. That is a STRONGER gate
// than the placeholder it replaces — a hand-typed or stale digest fails.
assert.equal(
  manifest.kotlinBindingSha256,
  await sha256(resolve(root, "generated/bindings/ActivitySync.kt")),
  "manifest kotlinBindingSha256 must match the generated Kotlin binding",
);
// Still null: no canonical reducer result exists until a KMP reducer can be
// compared against the TS one. A TS-only digest would agree with nothing.
assert.equal(manifest.canonicalBehaviorResultSha256, null);
// Pin the executable bytes themselves: a stale or hand-edited digest here is
// how a runner silently starts eating a different file than the one reviewed.
assert.equal(
  manifest.behaviorVectorsSha256,
  await sha256(behaviorVectorsPath),
  "manifest behaviorVectorsSha256 must match the executable behavior vectors",
);
assert.equal(manifest.sourceSha256, await sha256(resolve(root, "activity-sync.tsp")));
assert.equal(manifest.jsonSchemaTreeSha256, await treeSha256(schemaDir));
assert.equal(
  manifest.openApiSha256,
  await sha256(resolve(root, "generated/openapi/openapi.json")),
);
assert.equal(manifest.typescriptBindingSha256, await sha256(bindingPath));
assert.equal(
  manifest.typescriptLegVerifierSha256,
  await sha256(resolve(root, "tools/verify-typescript-leg.mjs")),
);
assert.equal(
  manifest.typescriptLegMutationSha256,
  await sha256(resolve(root, "tools/verify-typescript-leg-mutations.mjs")),
);
assert.equal(
  manifest.contractVectorsSha256,
  await sha256(resolve(root, "fixtures/activity-sync.contract-vectors.jsonl")),
);
assert.equal(
  manifest.behaviorSeedSha256,
  await sha256(resolve(root, "fixtures/activity-sync.behavior.seed.jsonl")),
);

console.log("Activity direct-binding contract canary: PASS");
console.log(`  ingress branches: ${ingressBranches.length}`);
console.log(`  intent branches: ${intentSchema.oneOf.length}`);
console.log(`  contract vectors: ${vectors.length} (ingress ${JSON.stringify(ingressCounts)}, intent ${JSON.stringify(intentCounts)})`);
console.log("  behavior seed: envelope-valid, all seven ingress branches, no fabricated result digest");
