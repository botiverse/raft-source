import assert from "node:assert/strict";
import { RUNTIMES, RUNTIME_MODELS, SERVER_RUNTIME_CATALOG_VERSION } from "@botiverse/raft-shared";
import { DEFAULT_RUNTIME_ADMISSION_POLICY, resolveRuntimeAdmissionPolicy } from "./runtimeAdmissionService";
import { KIMI_SDK_FORM_DEFINITION_REF } from "./runtimeFormDefinitionService";
import { projectServerRuntimeCatalog } from "./serverRuntimeCatalogService";

const ALL_ON = { disabledRuntimeIds: new Set<string>() };

test("lists every shared runtime with its catalog fields, external agents excluded", () => {
  const catalog = projectServerRuntimeCatalog(ALL_ON);
  assert.equal(catalog.catalogVersion, SERVER_RUNTIME_CATALOG_VERSION);
  assert.deepEqual(catalog.runtimes.map((runtime) => runtime.id), RUNTIMES.map((runtime) => runtime.id));
  assert.equal(catalog.runtimes.some((runtime) => runtime.id === "external"), false);

  const claude = catalog.runtimes.find((runtime) => runtime.id === "claude");
  assert.deepEqual({ ...claude, models: undefined }, {
    id: "claude",
    displayName: "Claude Code",
    abbreviation: "CC",
    binary: "claude",
    supported: true,
    experimental: false,
    deprecated: false,
    oarOnly: false,
    models: undefined,
    modelsSource: "static",
    forms: [{ kind: "generic" }, { kind: "v2" }],
  });
  assert.deepEqual(claude?.models, RUNTIME_MODELS.claude);
});

test("deprecated, experimental and OAR-only runtimes are flagged, not dropped", () => {
  const byId = new Map(projectServerRuntimeCatalog(ALL_ON).runtimes.map((runtime) => [runtime.id, runtime]));
  assert.equal(byId.get("copilot")?.deprecated, true);
  assert.equal(byId.get("qwen")?.experimental, true);
  assert.equal(byId.get("qwen")?.oarOnly, true);
  assert.equal(byId.get("qoder")?.oarOnly, true);
  // Live detection decides these; the bundled list is the fallback.
  assert.equal(byId.get("codex")?.modelsSource, "fallback");
  assert.deepEqual(byId.get("qwen")?.models, []);
});

test("a runtime with a v1 form lists that form instead of the generic one", () => {
  const byId = new Map(projectServerRuntimeCatalog(ALL_ON).runtimes.map((runtime) => [runtime.id, runtime]));
  assert.deepEqual(byId.get("kimi-sdk")?.forms, [
    { kind: "v1", schemaVersion: KIMI_SDK_FORM_DEFINITION_REF.schemaVersion },
    { kind: "v2" },
  ]);
  assert.deepEqual(byId.get("builtin")?.forms[0], { kind: "v1", schemaVersion: "builtin-pi.create.v3" });
  for (const runtime of byId.values()) assert.ok(runtime.forms.length > 0, runtime.id);
});

test("a runtime this server's switch keeps off is not listed", () => {
  const catalog = projectServerRuntimeCatalog({ disabledRuntimeIds: new Set(["qwen"]) });
  assert.equal(catalog.runtimes.some((runtime) => runtime.id === "qwen"), false);
  assert.equal(catalog.runtimes.some((runtime) => runtime.id === "qoder"), true);
});

test("CodeBuddy Code is listed (experimental, OAR-only, live models, v2 form), with no server switch", () => {
  const byId = new Map(projectServerRuntimeCatalog(ALL_ON).runtimes.map((runtime) => [runtime.id, runtime]));
  const codebuddy = byId.get("codebuddy");
  assert.equal(codebuddy?.displayName, "CodeBuddy Code");
  assert.equal(codebuddy?.binary, "codebuddy");
  assert.equal(codebuddy?.experimental, true);
  assert.equal(codebuddy?.oarOnly, true);
  assert.equal(codebuddy?.modelsSource, "fallback");
  assert.deepEqual(codebuddy?.forms, [{ kind: "generic" }, { kind: "v2" }]);
  // No switch: the fail-closed default (a flag store error) still lists it.
  assert.equal(projectServerRuntimeCatalog(DEFAULT_RUNTIME_ADMISSION_POLICY).runtimes.some((runtime) => runtime.id === "codebuddy"), true);
});

test("single source: the ids and their order are shared RUNTIMES after the switches", () => {
  // docs/contracts/server-runtime-catalog.md "Single source": no server-side copy.
  const disabled = new Set(["qwen", "codex"]);
  assert.deepEqual(
    projectServerRuntimeCatalog({ disabledRuntimeIds: disabled }).runtimes.map((runtime) => runtime.id),
    RUNTIMES.filter((runtime) => !disabled.has(runtime.id)).map((runtime) => runtime.id),
  );
});

test("a failing flag store leaves the runtimes without a switch listed", async () => {
  const policy = await resolveRuntimeAdmissionPolicy(
    { serverId: "server-a", userId: "user-a" },
    async () => { throw new Error("flag store down"); },
  );
  assert.deepEqual(policy, DEFAULT_RUNTIME_ADMISSION_POLICY);
  const ids = projectServerRuntimeCatalog(policy).runtimes.map((runtime) => runtime.id);
  for (const runtime of RUNTIMES) {
    if (!DEFAULT_RUNTIME_ADMISSION_POLICY.disabledRuntimeIds.has(runtime.id)) assert.ok(ids.includes(runtime.id), runtime.id);
  }
  assert.ok(ids.includes("claude"));
});

test("a deprecated runtime revived by its OAR flag is listed as not deprecated", () => {
  const revived = { disabledRuntimeIds: new Set<string>(), revivedRuntimeIds: new Set(["antigravity"]) };
  const byId = new Map(projectServerRuntimeCatalog(revived).runtimes.map((runtime) => [runtime.id, runtime]));
  assert.equal(byId.get("antigravity")?.deprecated, false);
  assert.equal(byId.get("gemini")?.deprecated, true);
  assert.equal(new Map(projectServerRuntimeCatalog(ALL_ON).runtimes.map((runtime) => [runtime.id, runtime])).get("antigravity")?.deprecated, true);
});
