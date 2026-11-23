import assert from "node:assert/strict";
import type { InstallationSnapshot, ListModelsResult, ModelEntry, ModelLister } from "@botiverse/oar";
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

test("a CLI OAR finds too old (version_unsupported) is protocol_unsupported, whatever the caller does with other unsupported answers", async () => {
  let asked = false;
  const outcome = await detectModelSourceViaOar({
    ...BASE,
    lister: listerReturning({ kind: "unsupported", code: "version_unsupported", reason: "needs 1.5.0", installedVersion: "1.4.2", requiredVersion: "1.5.0" }),
    onUnsupported: () => { asked = true; return { kind: "unsupported" }; },
  });
  assert.deepEqual(outcome, { kind: "error", retryable: true, code: "protocol_unsupported" });
  assert.equal(asked, false);
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

test("projection: an unreadable menu carries OAR's reason; an empty menu is \"none\" only where the lister marks it", () => {
  const entries: ModelEntry[] = [
    { id: "unread", effortUnavailableReason: "  Native catalog did not\nexpose this menu. " },
    { id: "empty", effortLevels: [] },
    { id: "listed", effortLevels: ["high"], effortUnavailableReason: "ignored next to a menu" },
  ];
  const label = (entry: ModelEntry) => entry.id;
  assert.deepEqual(projectOarModelEntries(entries, { label, keepReasoningEfforts: true, keepEmptyEffortLevels: true }), [
    { id: "unread", label: "unread", reasoningEffortUnavailableReason: "Native catalog did not expose this menu.", verified: "launchable" },
    { id: "empty", label: "empty", supportedReasoningEfforts: [], verified: "launchable" },
    { id: "listed", label: "listed", supportedReasoningEfforts: ["high"], verified: "launchable" },
  ]);
  // Other listers (Claude): an empty menu stays not reported, as before.
  assert.deepEqual(projectOarModelEntries([{ id: "empty", effortLevels: [] }], { label, keepReasoningEfforts: true }), [
    { id: "empty", label: "empty", verified: "launchable" },
  ]);
});

test("projection: an unreadable-menu reason is scrubbed like a start failure before it is bounded", () => {
  const [model] = projectOarModelEntries(
    [{ id: "unread", effortUnavailableReason: "Could not read /Users/alice/.agy/catalog.json with Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789" }],
    { label: (entry) => entry.id, keepReasoningEfforts: true },
  );
  const reason = model?.reasoningEffortUnavailableReason ?? "";
  assert.match(reason, /\[REDACTED_PATH\]/);
  assert.match(reason, /Bearer \[REDACTED_TOKEN\]/);
  assert.ok(!reason.includes("/Users/alice"), reason);
  assert.ok(!reason.includes("sk-live-"), reason);
});

/** OAR's OpenCode installation as `readOpenCodeInstallation` would report it. */
const OPENCODE_INSTALLED = async (): Promise<InstallationSnapshot> => ({ kind: "available", via: "executable", command: "/usr/local/bin/opencode", version: "opencode v2.3.0" });

test("opencode: the installation listed is OAR's own, a Windows npm shim included (OAR runs its target), with its version", async () => {
  const shim: InstallationSnapshot = { kind: "available", via: "executable", command: "C:\\Users\\tester\\AppData\\Roaming\\npm\\opencode.cmd", version: "opencode v2.3.0" };
  const seen: unknown[] = [];
  const outcome = await detectOpenCodeModelSourceViaOar(async (installation) => {
    seen.push(installation);
    return { kind: "ok", models: [{ id: "opencode/gpt-5-nano" }] };
  }, 1_000, async () => shim);
  assert.deepEqual(seen, [shim]);
  assert.equal(outcome.kind, "live");
});

test("opencode: no installation is runtime_not_found and a failed installation probe is detect_failed, both retryable, nothing listed", async () => {
  let listed = 0;
  const lister: ModelLister = async () => { listed += 1; return { kind: "ok", models: [] }; };
  assert.deepEqual(await detectOpenCodeModelSourceViaOar(lister, 1_000, async () => ({ kind: "not_found" })), { kind: "error", retryable: true, code: "runtime_not_found" });
  assert.deepEqual(
    await detectOpenCodeModelSourceViaOar(lister, 1_000, async () => { throw new Error("Failed to run opencode --version"); }),
    { kind: "error", retryable: true, code: "detect_failed" },
  );
  assert.equal(listed, 0);
});

test("opencode: an empty 2.x listing (OAR unsupported) is a retryable failure, not no_models", async () => {
  assert.deepEqual(
    await detectOpenCodeModelSourceViaOar(listerReturning({ kind: "unsupported", reason: "cold catalog" }), undefined, OPENCODE_INSTALLED),
    { kind: "error", retryable: true, code: "detect_failed" },
  );
});

test("opencode: ids and labels match the daemon's own parser for the same CLI output; OAR's efforts are dropped", async () => {
  const ids = ["opencode/gpt-5-nano", "fusecode/opus[1m]", "openrouter/anthropic/claude-opus-4.5"];
  // What OAR lists for `opencode models --verbose` (1.x): its display name omits the provider, and it carries
  // efforts, so the daemon's provider-qualified label must win and the efforts must be dropped.
  const models: ModelEntry[] = ids.map((id) => ({ id, displayName: `Bare ${id}`, effortLevels: ["high"] }));
  const viaOar = await detectOpenCodeModelSourceViaOar(listerReturning({ kind: "ok", models }), undefined, OPENCODE_INSTALLED);
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
