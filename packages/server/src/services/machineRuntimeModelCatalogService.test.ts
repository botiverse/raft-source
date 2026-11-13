import assert from "node:assert/strict";
import {
  MachineRuntimeModelCatalogService,
  applyRuntimeModelCatalogReport,
  __clearMachineRuntimeModelCatalogLocalCacheForTests,
} from "./machineRuntimeModelCatalogService";

function freshService() {
  __clearMachineRuntimeModelCatalogLocalCacheForTests();
  return new MachineRuntimeModelCatalogService(undefined, () => Date.UTC(2026, 8, 29, 9, 0, 0));
}

test("reports merge per runtime and read back whole", async () => {
  const service = freshService();
  assert.equal(await service.writeRuntime("machine-1", "codex", [{ id: "gpt-6-astra", label: "GPT-6-Astra" }]), true);
  assert.equal(await service.writeRuntime("machine-1", "claude", [{ id: "opus", label: "Claude Opus" }]), true);
  const catalog = await service.read("machine-1");
  assert.deepEqual(catalog.runtimes.codex, {
    models: [{ id: "gpt-6-astra", label: "GPT-6-Astra" }],
    updatedAt: "2026-09-29T09:00:00.000Z",
  });
  assert.deepEqual(catalog.runtimes.claude?.models, [{ id: "opus", label: "Claude Opus" }]);
  assert.deepEqual(await service.read("machine-unknown"), { runtimes: {} });
});

test("a later report replaces the whole list for that runtime", async () => {
  const service = freshService();
  await service.writeRuntime("machine-2", "codex", [
    { id: "gpt-6-astra", label: "GPT-6-Astra" },
    { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
  ]);
  await service.writeRuntime("machine-2", "codex", [{ id: "gpt-6-astra", label: "GPT-6 Astra" }]);
  const catalog = await service.read("machine-2");
  assert.deepEqual(catalog.runtimes.codex?.models, [{ id: "gpt-6-astra", label: "GPT-6 Astra" }]);
});

test("malformed reports keep the previous copy", async () => {
  const service = freshService();
  await service.writeRuntime("machine-3", "codex", [{ id: "gpt-6-astra", label: "GPT-6-Astra" }]);
  assert.equal(await service.writeRuntime("machine-3", "codex", []), false);
  assert.equal(await service.writeRuntime("machine-3", "codex", [{ id: "", label: "" }]), false);
  assert.equal(await service.writeRuntime("machine-3", "  ", [{ id: "a", label: "A" }]), false);
  const catalog = await service.read("machine-3");
  assert.deepEqual(catalog.runtimes.codex?.models, [{ id: "gpt-6-astra", label: "GPT-6-Astra" }]);
});

test("concurrent runtime reports do not lose each other, even across instances", async () => {
  // Two service instances share the backend: a proactive frame on one replica
  // and an on-demand upsert on another must both survive (HSET per runtime).
  freshService();
  const onConnectReplica = new MachineRuntimeModelCatalogService(undefined, () => Date.UTC(2026, 8, 29, 9, 0, 0));
  const onDemandReplica = new MachineRuntimeModelCatalogService(undefined, () => Date.UTC(2026, 8, 29, 9, 0, 1));
  await Promise.all([
    onConnectReplica.writeRuntime("machine-4", "codex", [{ id: "gpt-6-astra", label: "GPT-6-Astra" }]),
    onDemandReplica.writeRuntime("machine-4", "claude", [{ id: "opus", label: "Claude Opus" }]),
    onConnectReplica.writeRuntime("machine-4", "grok", [{ id: "grok-4.6", label: "Grok 4.6" }]),
  ]);
  const catalog = await onDemandReplica.read("machine-4");
  assert.deepEqual(Object.keys(catalog.runtimes).sort(), ["claude", "codex", "grok"]);
});

test("a runtime's own word that it has no models clears its list; the others keep theirs", async () => {
  const service = freshService();
  await service.writeRuntime("machine-5", "pi", [{ id: "anthropic/claude-opus", label: "Claude Opus · Anthropic" }]);
  await service.writeRuntime("machine-5", "codex", [{ id: "gpt-6-astra", label: "GPT-6-Astra" }]);
  assert.equal(await service.clearRuntime("machine-5", "pi"), true);
  const catalog = await service.read("machine-5");
  assert.equal(catalog.runtimes.pi, undefined, "no surface offers the signed-out provider's models");
  assert.deepEqual(catalog.runtimes.codex?.models, [{ id: "gpt-6-astra", label: "GPT-6-Astra" }]);
  await service.writeRuntime("machine-5", "pi", [{ id: "openrouter/x", label: "X · OpenRouter" }]);
  assert.deepEqual((await service.read("machine-5")).runtimes.pi?.models, [{ id: "openrouter/x", label: "X · OpenRouter" }], "a later sign-in brings a list back");
});

test("a Computer's catalog report clears a list only when authoritative, empty, and for a runtime that signs in per provider", async () => {
  const service = freshService();
  const seedLists = async () => {
    await service.writeRuntime("machine-6", "pi", [{ id: "anthropic/opus", label: "Opus · Anthropic" }]);
    await service.writeRuntime("machine-6", "codex", [{ id: "gpt-6-astra", label: "GPT-6-Astra" }]);
  };
  await seedLists();
  assert.equal(await applyRuntimeModelCatalogReport(service, "machine-6", { runtime: "codex", models: [], authoritative: true }), "kept", "Codex has one sign-in: its probes never clear");
  assert.equal(await applyRuntimeModelCatalogReport(service, "machine-6", { runtime: "pi", models: [] }), "kept", "a routine empty probe keeps the copy");
  assert.equal(await applyRuntimeModelCatalogReport(service, "machine-6", { runtime: "pi", models: [{ id: "x", label: "X" }], authoritative: true }), "written");
  assert.deepEqual((await service.read("machine-6")).runtimes.pi?.models, [{ id: "x", label: "X" }]);
  assert.deepEqual((await service.read("machine-6")).runtimes.codex?.models, [{ id: "gpt-6-astra", label: "GPT-6-Astra" }]);
  assert.equal(await applyRuntimeModelCatalogReport(service, "machine-6", { runtime: "pi", models: [], authoritative: true }), "cleared");
  assert.equal((await service.read("machine-6")).runtimes.pi, undefined);

  const calls: string[] = [];
  const spy = {
    writeRuntime: async (_machineId: string, runtime: string) => { calls.push(`write:${runtime}`); return true; },
    clearRuntime: async (_machineId: string, runtime: string) => { calls.push(`clear:${runtime}`); return true; },
  };
  await applyRuntimeModelCatalogReport(spy, "machine-7", { runtime: "pi", models: [], authoritative: true });
  await applyRuntimeModelCatalogReport(spy, "machine-7", { runtime: "claude", models: [], authoritative: true });
  assert.deepEqual(calls, ["clear:pi", "write:claude"], "the orchestrator's path: clear for Pi only");
});
