import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const cliUrl = new URL("./cli.ts", import.meta.url);
const apiUrl = new URL("./lib/api.ts", import.meta.url);
const localIntentUrl = new URL("./localLifecycleIntents.ts", import.meta.url);

test("upgrade CLI consumes K's single release authority and has no legacy resolver branch", async () => {
  const source = await readFile(cliUrl, "utf8");
  assert.match(source, /resolveComputerUpgradeTargetVersion\(channel!/u);
  assert.doesNotMatch(source, /resolveComputerTargetVersionResult|describeComputerTargetResolveFailure/u);
  const selection = source.slice(
    source.indexOf("const channel = opts.channel"),
    source.indexOf("if (opts.dryRun)"),
  );
  assert.match(selection, /opts\.channel\s*\?\s*parseChannel\(opts\.channel\)\s*:\s*await readChannel/u);
  assert.equal(
    selection.match(/resolveComputerUpgradeTargetVersion\(/gu)?.length,
    1,
    "saved and one-shot channels must converge on one resolver call",
  );
});

test("dry-run ends after package resolution without authorization, intent, IPC, or K mutation", async () => {
  const source = await readFile(cliUrl, "utf8");
  const start = source.indexOf("if (opts.dryRun)");
  const end = source.indexOf("// An explicit target", start);
  assert.ok(start >= 0 && end > start, "dry-run branch must precede upgrade consent and execution");
  const branch = source.slice(start, end);
  assert.match(branch, /Server authorization was not checked/u);
  assert.match(branch, /no changes were made/u);
  assert.doesNotMatch(branch, /createComputerApi|tryUpgradeViaService|prepareLocal|runKUpgradeCoordinator|upgrade-start/u);
  assert.doesNotMatch(source, /Computer \$\{kTargetVersion\} is available; no changes were made/u);
});

test("already-current upgrade short-circuits before consent, intents, coordinator, and receipts", async () => {
  const source = await readFile(cliUrl, "utf8");
  const start = source.indexOf("if (kTargetVersion === COMPUTER_VERSION)");
  const dryRun = source.indexOf("if (opts.dryRun)");
  const consent = source.indexOf("const consent = await requestKTargetConsent", start);
  const execution = source.indexOf("const api = createComputerApi", start);
  assert.ok(start >= 0, "current-target no-op guard must exist");
  assert.ok(dryRun > start && consent > start && execution > start, "no-op guard must precede dry-run, consent, and execution");
  const guardEnd = source.indexOf("\n        }\n        if (opts.dryRun)", start);
  assert.ok(guardEnd > start, "current-target no-op guard must close before dry-run");
  const guard = source.slice(start, guardEnd + "\n        }".length);
  assert.match(guard, /info\(`Already at \$\{COMPUTER_VERSION\}\.`\)/u);
  assert.match(guard, /^\s*return;\s*$/mu, "no-op guard must return from the command");
  assert.doesNotMatch(guard, /requestKTargetConsent|prepareLocal|runKUpgradeCoordinator|createComputerUpgrader|randomUUID/u);
});

test("already-current no-op contract catches a removed guard (right-cause mutation)", async () => {
  const original = await readFile(cliUrl, "utf8");
  const mutated = original.replace(
    "          info(`Already at ${COMPUTER_VERSION}.`);\n          return;\n        }\n        if (opts.dryRun)",
    "          info(`Already at ${COMPUTER_VERSION}.`);\n          // return;\n        }\n        if (opts.dryRun)",
  );
  assert.notEqual(mutated, original, "mutation must remove the guarded return");
  const assertGuard = (candidate: string): void => {
    const start = candidate.indexOf("if (kTargetVersion === COMPUTER_VERSION)");
    const guardEnd = candidate.indexOf("\n        }\n        if (opts.dryRun)", start);
    assert.ok(start >= 0 && guardEnd > start, "current-target guard must close before dry-run");
    const guard = candidate.slice(start, guardEnd + "\n        }".length);
    assert.match(guard, /info\(`Already at \$\{COMPUTER_VERSION\}\.`\)/u);
    assert.match(guard, /^\s*return;\s*$/mu, "no-op guard must return from the command");
  };
  assertGuard(original);
  assert.throws(
    () => assertGuard(mutated),
    /no-op guard must return from the command/u,
    "removing the no-op return must fail the right-cause verifier",
  );
});

test("upgrade CLI presents the typed authorization outcome instead of flattening its message", async () => {
  const source = await readFile(cliUrl, "utf8");
  const call = source.indexOf("await api.tryUpgradeViaService");
  const next = source.indexOf("if (routed.routed)", call);
  assert.ok(call >= 0 && next > call);
  assert.match(source.slice(call, next), /error instanceof ComputerError/u);
  assert.match(source.slice(call, next), /fail\(error\.code, error\.message\)/u);
});

test("service-routed manual upgrade carries one resolved exact target across every local intent seam", async () => {
  const [cli, api, localIntent] = await Promise.all([
    readFile(cliUrl, "utf8"),
    readFile(apiUrl, "utf8"),
    readFile(localIntentUrl, "utf8"),
  ]);
  const selection = cli.indexOf("kTargetVersion = await resolveComputerUpgradeTargetVersion");
  const routed = cli.indexOf("await api.tryUpgradeViaService(kTargetVersion");
  assert.ok(selection >= 0 && routed > selection, "Hands resolution must precede service routing");
  assert.match(api, /tryUpgradeViaService\(\s*targetVersion: string,/u);
  assert.doesNotMatch(api, /tryUpgradeViaService\(\s*targetVersion: string \| undefined,/u);
  const prepareStart = localIntent.indexOf("export async function prepareLocalUpgradeLifecycleOperation");
  const prepareEnd = localIntent.indexOf("export async function prepareExactLocalUpgradeLifecycleOperation", prepareStart);
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart);
  const prepare = localIntent.slice(prepareStart, prepareEnd);
  assert.match(prepare, /targetVersion: string,/u);
  assert.doesNotMatch(prepare, /targetVersion: string \| undefined/u);
  assert.equal(
    prepare.match(/^\s+targetVersion,$/gmu)?.length,
    2,
    "the exact target must be written to both Server intent and local durable queue",
  );
  const genericStart = localIntent.indexOf("export async function prepareLocalLifecycleOperations");
  assert.ok(genericStart >= 0);
  assert.match(
    localIntent.slice(genericStart, genericStart + 260),
    /action: Exclude<ComputerLifecycleAction, "upgrade">,/u,
    "generic start/stop/restart preparation must not reopen an optional upgrade path",
  );
});
