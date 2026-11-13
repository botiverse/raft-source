import assert from "node:assert/strict";
import { projectOpencodeModels, type ListModelsResult, type ModelEntry, type ModelLister } from "@botiverse/oar";
import { formatRuntimeProviderModelLabel, type RuntimeModelSourceOutcome } from "@botiverse/raft-shared";

import { detectOpenCodeModelSourceViaOar, parseOpenCodeModelsOutput } from "../drivers/opencode";
import { detectModelSourceViaOar, projectOarModelEntries } from "./oarListModels";

function listerReturning(result: ListModelsResult): ModelLister {
  return async () => result;
}

const BASE = {
  installation: { kind: "available", via: "executable", command: "opencode" },
  deadlineMs: 1_000,
  label: (entry: ModelEntry) => entry.displayName ?? `label:${entry.id}`,
  keepReasoningEfforts: true,
  onUnsupported: (): RuntimeModelSourceOutcome => ({ kind: "unsupported" }),
} as const;

test("ok with models maps to live, keeping tiers and the runtime's effort menu", async () => {
  const outcome = await detectModelSourceViaOar({
    ...BASE,
    lister: listerReturning({
      kind: "ok",
      models: [
        { id: "a/one", displayName: "One", effortLevels: ["low", "high"], defaultEffort: "high", serviceTiers: ["fast"], defaultServiceTier: "fast" },
        { id: "a/two" },
      ],
    }),
  });
  assert.deepEqual(outcome, {
    kind: "live",
    value: {
      models: [
        { id: "a/one", label: "One", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high", serviceTiers: ["fast"], defaultServiceTier: "fast", verified: "launchable" },
        { id: "a/two", label: "label:a/two", verified: "launchable" },
      ],
    },
  });
});

test("the entry OAR marks default is the set's default only when the caller asks for it", async () => {
  const lister = listerReturning({ kind: "ok", models: [{ id: "a/one" }, { id: "a/two", default: true }] });
  const reported = await detectModelSourceViaOar({ ...BASE, lister, reportDefault: true });
  assert.equal(reported.kind === "live" ? reported.value.default : null, "a/two");
  const plain = await detectModelSourceViaOar({ ...BASE, lister });
  assert.equal(plain.kind === "live" ? plain.value.default : null, undefined);
  // A disabled default is not offered, so it is not the default either.
  const disabled = await detectModelSourceViaOar({
    ...BASE,
    lister: listerReturning({ kind: "ok", models: [{ id: "a/one" }, { id: "a/two", default: true, disabled: { reason: "plan" } }] }),
    reportDefault: true,
  });
  assert.equal(disabled.kind === "live" ? disabled.value.default : null, undefined);
});

test("ok with an empty list maps to no_models", async () => {
  assert.deepEqual(
    await detectModelSourceViaOar({ ...BASE, lister: listerReturning({ kind: "ok", models: [] }) }),
    { kind: "no_models" },
  );
});

test("ok whose only entries are disabled maps to no_models, not a live list of unlaunchable models", async () => {
  assert.deepEqual(
    await detectModelSourceViaOar({ ...BASE, lister: listerReturning({ kind: "ok", models: [{ id: "a/x", disabled: { reason: "plan" } }] }) }),
    { kind: "no_models" },
  );
});

test("disabled entries are reported as unavailable with the runtime's reason, never as selectable models", async () => {
  const outcome = await detectModelSourceViaOar({
    ...BASE,
    lister: listerReturning({
      kind: "ok",
      models: [
        { id: "a/one", displayName: "One" },
        { id: "a/new", displayName: "New", disabled: { reason: `  Update\n the CLI ${"x".repeat(300)}` } },
        // Listed usable and disabled: usable wins, not repeated.
        { id: "a/one", disabled: { reason: "dup" } },
      ],
    }),
  });
  assert.equal(outcome.kind, "live");
  if (outcome.kind !== "live") return;
  assert.deepEqual(outcome.value.models.map((model) => model.id), ["a/one"]);
  assert.equal(outcome.value.unavailable?.length, 1);
  const [entry] = outcome.value.unavailable!;
  assert.equal(entry!.id, "a/new");
  assert.equal(entry!.label, "New");
  assert.ok(entry!.reason.startsWith("Update the CLI x"), "whitespace collapsed and trimmed");
  assert.ok(entry!.reason.length <= 200, "length-capped");
});

test("unauthenticated maps to a retryable runtime_not_authenticated error", async () => {
  assert.deepEqual(
    await detectModelSourceViaOar({ ...BASE, lister: listerReturning({ kind: "unauthenticated" }) }),
    { kind: "error", retryable: true, code: "runtime_not_authenticated" },
  );
});

test("unsupported is the caller's decision, with OAR's reason", async () => {
  const reasons: string[] = [];
  const outcome = await detectModelSourceViaOar({
    ...BASE,
    lister: listerReturning({ kind: "unsupported", reason: "why" }),
    onUnsupported: (reason) => {
      reasons.push(reason);
      return { kind: "error", retryable: true, code: "detect_failed" };
    },
  });
  assert.deepEqual(outcome, { kind: "error", retryable: true, code: "detect_failed" });
  assert.deepEqual(reasons, ["why"]);
});

test("a thrown listing maps to a retryable error with no code", async () => {
  const outcome = await detectModelSourceViaOar({
    ...BASE,
    lister: async () => {
      throw new Error("Failed to list opencode models");
    },
  });
  assert.deepEqual(outcome, { kind: "error", retryable: true });
});

test("a listing still running at our deadline reports detect_timeout", async () => {
  const outcome = await detectModelSourceViaOar({
    ...BASE,
    deadlineMs: 20,
    lister: () => new Promise<ListModelsResult>(() => {}),
  });
  assert.deepEqual(outcome, { kind: "error", retryable: true, code: "detect_timeout" });
});

test("the lister gets a timeout above our deadline, so our deadline decides", async () => {
  const seen: Array<number | undefined> = [];
  await detectModelSourceViaOar({
    ...BASE,
    lister: async (_installation, options) => {
      seen.push(options?.timeoutMs);
      return { kind: "ok", models: [] };
    },
  });
  assert.equal(seen.length, 1);
  assert.ok((seen[0] ?? 0) > BASE.deadlineMs, `lister timeout ${seen[0]} must exceed the ${BASE.deadlineMs} ms deadline`);
});

test("projection drops efforts when the runtime cannot apply them, and de-duplicates ids", () => {
  assert.deepEqual(
    projectOarModelEntries(
      [{ id: "a/one", effortLevels: ["low"], defaultEffort: "low" }, { id: "a/one", displayName: "dup" }],
      { label: (entry) => entry.id, keepReasoningEfforts: false },
    ),
    [{ id: "a/one", label: "a/one", verified: "launchable" }],
  );
});

test("opencode: the installation listed is the bare opencode command sessions launch", async () => {
  const seen: unknown[] = [];
  await detectOpenCodeModelSourceViaOar(async (installation) => {
    seen.push(installation);
    return { kind: "ok", models: [{ id: "opencode/gpt-5-nano" }] };
  });
  assert.deepEqual(seen, [{ kind: "available", via: "executable", command: "opencode" }]);
});

test("opencode: an empty 2.x listing (OAR unsupported) is a retryable failure, not no_models", async () => {
  assert.deepEqual(
    await detectOpenCodeModelSourceViaOar(listerReturning({ kind: "unsupported", reason: "cold catalog" })),
    { kind: "error", retryable: true, code: "detect_failed" },
  );
});

test("opencode: ids and labels match the daemon's own parser for the same CLI output; OAR's efforts are dropped", async () => {
  const ids = ["opencode/gpt-5-nano", "fusecode/opus[1m]", "openrouter/anthropic/claude-opus-4.5"];
  // `opencode models --verbose` (1.x): id line, then the model JSON closed by `}`. OAR's display name omits the
  // provider, so the daemon's provider-qualified label must win over it.
  const verbose = ids.flatMap((id) => [id, "{", `  "name": "Bare ${id}",`, `  "variants": { "high": {} }`, "}"]).join("\n");
  const viaOar = await detectOpenCodeModelSourceViaOar(listerReturning({ kind: "ok", models: projectOpencodeModels(verbose) }));
  const daemonOwn = parseOpenCodeModelsOutput(ids.join("\n"));
  assert.ok(daemonOwn);
  assert.deepEqual(viaOar, { kind: "live", value: daemonOwn });
  assert.equal(daemonOwn!.models[0]!.label, formatRuntimeProviderModelLabel(ids[0]!));
});

test("a request after our deadline joins the listing still running instead of starting a second one", async () => {
  let started = 0;
  let finish!: (result: ListModelsResult) => void;
  const lister: ModelLister = () => {
    started += 1;
    return new Promise<ListModelsResult>((resolve) => { finish = resolve; });
  };
  const first = await detectModelSourceViaOar({ ...BASE, deadlineMs: 10, lister });
  assert.deepEqual(first, { kind: "error", retryable: true, code: "detect_timeout" });
  const second = detectModelSourceViaOar({ ...BASE, deadlineMs: 1_000, lister });
  finish({ kind: "ok", models: [{ id: "a/late" }] });
  assert.deepEqual(await second, { kind: "live", value: { models: [{ id: "a/late", label: "label:a/late", verified: "launchable" }] } });
  assert.equal(started, 1, "one listing ran for both requests");
  // Once it settled, the next request starts a new listing.
  await detectModelSourceViaOar({ ...BASE, lister });
  assert.equal(started, 2);
});
