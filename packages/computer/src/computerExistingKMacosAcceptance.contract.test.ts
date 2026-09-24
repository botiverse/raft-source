import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { parseLegacyOsSupervisorInvocation } from "./osSupervisorLifecycle.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(resolve(repoRoot, "RELEASE_SOURCE"));
const workflowPath = resolve(repoRoot, ".github/workflows/computer-existing-k-macos-acceptance.yml");
const scriptPath = resolve(repoRoot, "packages/computer/scripts/acceptance/existing-k-macos.sh");
const fixturePath = resolve(repoRoot, "packages/computer/scripts/acceptance/existing-k-macos-fixture.mjs");
const mktempPath = resolve(repoRoot, "packages/computer/scripts/acceptance/bin/mktemp");

interface Sources {
  workflow: string;
  script: string;
  fixture: string;
  mktemp: string;
}

const sources: Sources = {
  workflow: inSourceSnapshot ? "" : await readFile(workflowPath, "utf8"),
  script: await readFile(scriptPath, "utf8"),
  fixture: await readFile(fixturePath, "utf8"),
  mktemp: await readFile(mktempPath, "utf8"),
};

function mutated(patch: Partial<Sources>): Sources {
  return { ...sources, ...patch };
}

function assertRunKeyStartupProbe(script: string): void {
  const assignment = script.match(/^readonly RUN_KEY=.*$/mu)?.[0];
  assert.ok(assignment, "acceptance run-key assignment is missing");

  const probe = [
    "set -u",
    "unset BASHPID 2>/dev/null || true",
    assignment,
    'case "$RUN_KEY" in task608-7-[0-9]*) ;; *) printf "unexpected_run_key=%s\\n" "$RUN_KEY" >&2; exit 64 ;; esac',
    'printf "run_key=%s\\n" "$RUN_KEY"',
  ].join("\n");
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", probe], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_RUN_ID: "task608",
      GITHUB_RUN_ATTEMPT: "7",
    },
  });

  assert.equal(
    result.status,
    0,
    `Bash nounset startup probe failed: ${result.stderr.trim()}`,
  );
  assert.match(result.stdout, /^run_key=task608-7-[0-9]+\n$/u);
}

function assertAcceptanceContract(input: Sources): void {
  const { workflow, script, fixture, mktemp } = input;
  const workflowExecutable = workflow.replace(/^#.*$/gmu, "");

  assert.match(workflow, /^on:\n  workflow_dispatch:\n    inputs:\n/mu,
    "workflow must remain dispatch-only");
  assert.doesNotMatch(workflow, /^\s{2}(?:push|pull_request|schedule|workflow_run|workflow_call|repository_dispatch):/mu,
    "workflow must not gain an automatic or callable trigger");
  assert.match(workflow, /^permissions:\n  contents: read\n/mu,
    "workflow authority must remain contents:read only");
  assert.deepEqual(
    [...workflow.matchAll(/^  ([a-z0-9-]+):\n    runs-on:/gmu)].map((match) => match[1]),
    ["existing-k-macos"],
    "workflow must contain exactly one disposable macOS job",
  );
  assert.match(workflow, /runs-on: macos-15/u,
    "acceptance must use a GitHub-hosted macOS runner");
  assert.match(workflow, /node-version-file: \.node-version/u,
    "acceptance must use the repository-pinned Node 24 runtime");
  for (const name of [
    "candidate_version",
    "baseline_version",
    "hands_alpha_sha256",
    "candidate_manifest_sha256",
    "candidate_inventory_sha256",
    "staging_installer_sha256",
    "baseline_manifest_sha256",
  ]) {
    assert.match(workflow, new RegExp(`^      ${name}:$`, "mu"), `missing caller-bound input ${name}`);
  }
  for (const [name, value] of [
    ["candidate_version", "1.0.22"],
    ["baseline_version", "1.0.17"],
    ["hands_alpha_sha256", "daad691d789cbc156829e4e182b1deeb783902ddcd9d3b6401ee171c293554ef"],
    ["candidate_manifest_sha256", "e473e791d002dd736a08a68997e0a2c1e60b44603c784229a9fbeb3e54975786"],
    ["candidate_inventory_sha256", "8899690a8c1d07efc35f784b636ffa5dd1caf8c14092e0fc7999768233f9b5d9"],
    ["staging_installer_sha256", "c9a1da0327b8b8c570a85039fccc013d51c0de108cd0dbfd4b33624c6d31c25f"],
    ["baseline_manifest_sha256", "19f8ca2b06faddfbd48c0f029ae6f8ddb28d14dd850fbd9f2b4d940b72b5b428"],
  ] as const) {
    assert.match(
      workflow,
      new RegExp(`^      ${name}:\\n(?:        .*\\n)*?        default: ${value}$`, "mu"),
      `workflow default must bind ${name} to the accepted public bytes`,
    );
  }
  assert.doesNotMatch(workflowExecutable, /secrets\.|\bdeploy\b|\bpublish\b|upload-artifact|self-hosted/iu,
    "workflow must not gain secret, deploy, publish, artifact-upload, or persistent-runner authority");
  assert.match(workflow, /bash packages\/computer\/scripts\/acceptance\/existing-k-macos\.sh/u,
    "workflow must execute the checked-in acceptance harness");

  assert.match(script, /readonly RUN_KEY="\$\{GITHUB_RUN_ID:-local\}-\$\{GITHUB_RUN_ATTEMPT:-1\}-\$\$"/u,
    "acceptance run identity must use the Bash 3.2-compatible shell PID");
  assert.doesNotMatch(script, /\bBASHPID\b/u,
    "acceptance must not require BASHPID, which is unavailable in macOS Bash 3.2");

  for (const tooth of [
    "HANDS_ALPHA_HASH_MISMATCH",
    "CANDIDATE_MANIFEST_HASH_MISMATCH",
    "CANDIDATE_INVENTORY_HASH_MISMATCH",
    "STAGING_INSTALLER_HASH_MISMATCH",
    "BASELINE_MANIFEST_HASH_MISMATCH",
    "CANDIDATE_PUBLIC_BYTES_HASH_MISMATCH",
    "BASELINE_PUBLIC_BYTES_HASH_MISMATCH",
  ]) {
    assert.match(script, new RegExp(tooth, "u"), `public entrypoint/hash fence missing ${tooth}`);
  }
  assert.match(script, /\[ "\$CANDIDATE_VERSION" = '1\.0\.22' \] \|\| die 'CANDIDATE_VERSION_MUST_EQUAL_1\.0\.22'/u,
    "acceptance must reject any candidate other than exact public 1.0.22");
  assert.match(script, /curl -fsSL https:\/\/slock-cdn-staging\.botiverse\.dev\/computer\/staging\/install\.sh[\s\S]*RAFT_COMPUTER_VERSION=1\.0\.22[\s\S]*RAFT_COMPUTER_INSTALL_CHANNEL=pinned:1\.0\.22[\s\S]*sh/u,
    "candidate must enter through the exact public staging curl pipeline");
  assert.equal(
    (script.match(/install_candidate (?:first|final)/gu) ?? []).length,
    2,
    "exact public candidate entrypoint must run before and after rollback",
  );
  assert.doesNotMatch(script, /sh packages\/computer\/scripts\/install\.sh|bash packages\/computer\/scripts\/install\.sh/u,
    "checked-out installer substitution is forbidden");
  assert.equal((script.match(/curl -fsSL "\$STAGING_INSTALLER_URL"/gu) ?? []).length, 3,
    "the preflight, baseline install, and forced rollback must use the hash-fenced public installer");

  assert.match(script, /upgrade --target-version 1\.0\.18/u,
    "failed K fixture must be created by a real baseline upgrade");
  assert.match(script, /launchctl bootstrap[\s\S]*upgrade --target-version 1\.0\.18/u,
    "failed K fixture must be created through the live service path");
  assert.match(script, /FAILED_K_SERVICE_PATH_NOT_USED/u,
    "failed K fixture must prove the live service accepted the request");
  assert.match(script, /assert-failed-receipt/u,
    "exact prior failed receipt assertion is missing");
  assert.match(fixture, /previousStableVersion !== "1\.0\.17"[\s\S]*targetVersion !== "1\.0\.18"[\s\S]*outcome !== "failed"/u,
    "failed K receipt fields are not bound exactly");
  assert.match(fixture, /operation\.acknowledgedAtMs !== null/u,
    "failed K receipt must remain unacknowledged");
  assert.match(script, /EXISTING_UNACKNOWLEDGED_K_BLOCKED/u,
    "candidate installer must preserve and report an unacknowledged-K first break");
  assert.equal((fixture.match(/serverSlug: "task603-[abc]"/gu) ?? []).length, 3,
    "exactly three deterministic attachment fixtures are required");
  assert.match(script, /launchctl bootstrap/u,
    "baseline must create a real launchd resident");
  assert.match(script, /SLOCK_HOME_CANONICAL=.*os\.path\.realpath/u,
    "baseline must bind the macOS canonical home before invoking legacy 1.0.17");
  assert.match(script, /BASELINE_DISPATCHER_BYTES_MISMATCH[\s\S]*materialize-legacy-k-stable[\s\S]*--slock-home "\$SLOCK_HOME_LEXICAL"[\s\S]*--version "\$BASELINE_VERSION"[\s\S]*--artifact "\$COMPUTER_BINARY"[\s\S]*--artifact-sha256 "\$BASELINE_ARTIFACT_SHA256"[\s\S]*BASELINE_STABLE_BINARY_CANONICAL/u,
    "verified public 1.0.17 bytes must initialize the existing-K stable slot before it is dereferenced");
  assert.match(fixture, /stagingDir = `\$\{stableDir\}\.bootstrap`[\s\S]*copyFileFn \?\? copyFile[\s\S]*syncArtifactFn[\s\S]*artifactHandle\.sync\(\)[\s\S]*chmod\(stagingArtifact, 0o755\)[\s\S]*writeVersionFn[\s\S]*versionHandle\.sync\(\)[\s\S]*renameFn \?\? rename[\s\S]*stableMode !== 0o755[\s\S]*BASELINE_LEGACY_K_STABLE_READBACK_MISMATCH/u,
    "existing-K materialization must mirror K 0.1.6 atomic bootstrap file effects and verify the stable slot");
  assert.match(script, /assert-legacy-k-launch-identity[\s\S]*--source-slock-home "\$SLOCK_HOME_LEXICAL"[\s\S]*--launch-slock-home "\$SLOCK_HOME_CANONICAL"[\s\S]*--binary "\$BASELINE_STABLE_BINARY_CANONICAL"/u,
    "baseline must prove the legacy /tmp alias would redispatch and the canonical launch will not");
  assert.match(fixture, /BASELINE_LEGACY_K_ALIAS_PRECONDITION_MISSING[\s\S]*BASELINE_LEGACY_K_SELF_DISPATCH_ALIAS/u,
    "legacy K identity probe must fail closed for both a missing alias precondition and self-dispatch alias");
  assert.match(script, /"ProgramArguments": \[\s*binary,\s*"__service",\s*"--slock-home",\s*slock_home,\s*\]/u,
    "launchd fixture must start the baseline service without the retired manager argv grammar");
  assert.match(script, /"\$LAUNCHD_PLIST" "\$LAUNCHD_LABEL" "\$SLOCK_HOME_CANONICAL"[\s\S]*"\$BASELINE_STABLE_BINARY_CANONICAL"/u,
    "launchd must use canonical spellings that legacy 1.0.17 compares as the same K resident");
  assert.doesNotMatch(script, /"ProgramArguments": \[[\s\S]*?"--os-supervised",\s*"launchd-user"[\s\S]*?\]/u,
    "launchd fixture must not invoke the 1.0.17 retired manager tombstone");
  assert.match(script, /"RAFT_COMPUTER_OS_SUPERVISOR_KIND": "launchd-user"/u,
    "launchd fixture must preserve the supervised shell-environment seam without retired argv");
  assert.match(script, /"StandardOutPath": service_stdout[\s\S]*"StandardErrorPath": service_stderr/u,
    "launchd fixture must preserve separate service stdout and stderr before cleanup");
  assert.match(script, /wait_for_baseline_service_start\nif ! node "\$FIXTURE" assert-live/u,
    "baseline bootstrap must fail fast on early service exit before the bounded live proof");
  assert.match(script, /BASELINE_SERVICE_EXITED_EARLY/u,
    "baseline early-exit failure must have an actionable typed reason");
  assert.match(script, /BASELINE_LIVE_PROOF_FAILED/u,
    "post-start non-readiness must retain a distinct bounded failure reason");
  assert.match(script, /BASELINE_PROOF_PATH reason=%s status=(?:present|absent)/u,
    "baseline diagnostics must state whether the expected proof path exists");
  assert.match(script, /emit_bounded_diagnostic_file launchctl-state[\s\S]*emit_bounded_diagnostic_file owned-processes[\s\S]*emit_bounded_diagnostic_file service-stdout[\s\S]*emit_bounded_diagnostic_file service-stderr/u,
    "baseline diagnostics must preserve launchctl, process, stdout, and stderr evidence before cleanup");
  assert.match(script, /BASELINE_DIAGNOSTIC_FILE_EMPTY kind=%s/u,
    "baseline diagnostics must distinguish an empty captured stream from a missing one");
  assert.match(script, /tail -n 120[\s\S]*cut -c 1-2000/u,
    "baseline diagnostics must remain bounded by lines and line length");
  assert.match(script, /\[REDACTED\]/u,
    "baseline diagnostics must redact credential-shaped output");
  assert.match(script, /assert-live[\s\S]*attachments=3/u,
    "three real attachment processes must survive the state machine");

  assert.match(script, /\/var\/folders\/\*[\s\S]*\/private\/var\/folders\/\*/u,
    "candidate temp identity must bind lexical and canonical macOS paths");
  assert.match(script, /case "\$K_ROOT_LEXICAL" in \/tmp\/\*[\s\S]*case "\$K_ROOT_CANONICAL" in \/private\/tmp\/\*/u,
    "K identity must bind /tmp and /private/tmp as one real root");
  assert.match(mktemp, /os\.path\.realpath/u,
    "mktemp probe must record canonical identity");

  assert.match(script, /FOREIGN_ARGV_WAS_SWALLOWED/u,
    "foreign absolute argv fail-closed tooth is missing");
  assert.match(fixture, /MISSING_SELF_FAIL_CLOSED_TOOTH_MISSING/u,
    "unresolvable self-token fail-closed tooth is missing");
  assert.match(fixture, /MISSING_SELF_MUTATED_RESIDENT_STATE/u,
    "unresolvable self-token probe must preserve stable, receipt, and service state");

  assert.equal((script.match(/"\$COMPUTER_BINARY" restart/gu) ?? []).length, 2,
    "candidate must prove explicit restart before rollback and after re-upgrade");
  assert.match(script, /RAFT_COMPUTER_FORCE=1/u,
    "forced baseline rollback is missing");
  assert.match(script, /ROLLBACK_RECEIPT[\s\S]*install_candidate final[\s\S]*FINAL_ACCEPTANCE_RECEIPT/u,
    "terminal rollback and final candidate re-upgrade receipts are missing");

  assert.match(script, /launchctl bootout/u,
    "cleanup must remove the exact launchd label");
  assert.match(script, /zeroOwnedProcesses[\s\S]*zeroOwnedLabels[\s\S]*zeroOwnedFiles/u,
    "cleanup receipt must independently prove zero owned processes, labels, and files");
}

test.skipIf(inSourceSnapshot)("existing-K macOS acceptance binds public bytes, live K state, rollback, restart, and cleanup", () => {
  assertAcceptanceContract(sources);
});

test("existing-K macOS acceptance initializes its run key with Bash nounset before network or state", () => {
  assertRunKeyStartupProbe(sources.script);
});

test("existing-K macOS acceptance launchd argv bypasses the 1.0.17 retired-manager tombstone", () => {
  const slockHome = "/tmp/raft-existing-k/state";
  assert.equal(parseLegacyOsSupervisorInvocation([
    "/tmp/raft-computer",
    "__service",
    "--slock-home",
    slockHome,
  ]), null);
  assert.deepEqual(parseLegacyOsSupervisorInvocation([
    "/tmp/raft-computer",
    "__service",
    "--slock-home",
    slockHome,
    "--os-supervised",
    "launchd-user",
  ]), { kind: "launchd-user", slockHome });
});

test.skipIf(inSourceSnapshot)("existing-K macOS acceptance has right-cause mutation teeth", () => {
  assert.throws(() => assertAcceptanceContract(mutated({
    workflow: sources.workflow.replace("default: 1.0.22", "default: 1.0.21"),
  })), /workflow default must bind candidate_version to the accepted public bytes/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    workflow: sources.workflow.replace(
      "daad691d789cbc156829e4e182b1deeb783902ddcd9d3b6401ee171c293554ef",
      "bb27820e38bd423ea1c3c945640103efe46804b43eb2ba8ee29ccb6f1207657e",
    ),
  })), /workflow default must bind hands_alpha_sha256 to the accepted public bytes/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    script: sources.script.replace(
      "CANDIDATE_VERSION\" = '1.0.22'",
      "CANDIDATE_VERSION\" = '1.0.21'",
    ),
  })), /acceptance must reject any candidate other than exact public 1\.0\.22/u);
  assert.throws(() => assertRunKeyStartupProbe(sources.script.replace('-$$"', '-${BASHPID}"')),
    /BASHPID: unbound variable/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    script: sources.script.replace('-$$"', '-${BASHPID}"'),
  })), /Bash 3\.2-compatible shell PID/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    script: sources.script.replace("CANDIDATE_PUBLIC_BYTES_HASH_MISMATCH", "CANDIDATE_BYTES_UNCHECKED"),
  })), /public entrypoint\/hash fence missing CANDIDATE_PUBLIC_BYTES_HASH_MISMATCH/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    script: sources.script.replace(
      "curl -fsSL https://slock-cdn-staging.botiverse.dev/computer/staging/install.sh",
      "sh packages/computer/scripts/install.sh #",
    ),
  })), /candidate must enter through the exact public staging curl pipeline/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    script: sources.script.replace("node \"$FIXTURE\" assert-failed-receipt", "node \"$FIXTURE\" receipt-unchecked"),
  })), /exact prior failed receipt assertion is missing/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    fixture: sources.fixture.replace("operation.acknowledgedAtMs !== null", "false"),
  })), /failed K receipt must remain unacknowledged/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    fixture: sources.fixture.replace('serverSlug: "task603-c"', 'serverSlug: "removed-c"'),
  })), /exactly three deterministic attachment fixtures are required/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    script: sources.script.replace(
      '        slock_home,\n    ],',
      '        slock_home,\n        "--os-supervised",\n        "launchd-user",\n    ],',
    ),
  })), /retired manager argv grammar|retired manager tombstone/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    script: sources.script.replace(
      '--launch-slock-home "$SLOCK_HOME_CANONICAL"',
      '--launch-slock-home "$SLOCK_HOME_LEXICAL"',
    ),
  })), /legacy \/tmp alias would redispatch/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    script: sources.script.replace("wait_for_baseline_service_start\n", "printf 'baseline start unchecked\\n'\n"),
  })), /fail fast on early service exit/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    script: sources.script.replace("emit_bounded_diagnostic_file service-stderr", "printf 'service stderr unavailable'"),
  })), /launchctl, process, stdout, and stderr evidence/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    mktemp: sources.mktemp.replace("os.path.realpath", "str"),
  })), /mktemp probe must record canonical identity/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    script: sources.script.replace(
      'case "$K_ROOT_CANONICAL" in /private/tmp/*)',
      'case "$K_ROOT_LEXICAL" in /tmp/*)',
    ),
  })), /K identity must bind \/tmp and \/private\/tmp as one real root/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    script: sources.script.replace("FOREIGN_ARGV_WAS_SWALLOWED", "FOREIGN_ARGV_IGNORED"),
  })), /foreign absolute argv fail-closed tooth is missing/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    script: sources.script.replace("materialize-legacy-k-stable", "skip-legacy-k-stable"),
  })), /verified public 1\.0\.17 bytes must initialize the existing-K stable slot/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    fixture: sources.fixture.replace("MISSING_SELF_FAIL_CLOSED_TOOTH_MISSING", "MISSING_SELF_IGNORED"),
  })), /unresolvable self-token fail-closed tooth is missing/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    script: sources.script.replace('"$COMPUTER_BINARY" restart', 'printf "restart skipped\\n"'),
  })), /candidate must prove explicit restart before rollback and after re-upgrade/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    script: sources.script.replace("RAFT_COMPUTER_FORCE=1", "RAFT_COMPUTER_FORCE=0"),
  })), /forced baseline rollback is missing/u);
  assert.throws(() => assertAcceptanceContract(mutated({
    script: sources.script.replace("zeroOwnedFiles", "filesNotChecked"),
  })), /cleanup receipt must independently prove zero owned processes, labels, and files/u);
});

test("existing-K materialization bootstraps a complete stable slot from verified public baseline bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "task645-existing-k-bootstrap-"));
  try {
    const slockHome = join(root, "state");
    const artifact = join(root, "raft-computer-1.0.17");
    const baseline = Buffer.from("exact public Computer 1.0.17 fixture bytes\n");
    await writeFile(artifact, baseline);
    const sha256 = createHash("sha256").update(baseline).digest("hex");

    const result = spawnSync(process.execPath, [
      fixturePath,
      "materialize-legacy-k-stable",
      "--slock-home",
      slockHome,
      "--version",
      "1.0.17",
      "--artifact",
      artifact,
      "--artifact-sha256",
      sha256,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout) as {
      outcome: string;
      stablePath: string;
      stableVersion: string;
      stableSha256: string;
      stableMode: string;
    };
    assert.equal(receipt.outcome, "bootstrapped");
    assert.equal(receipt.stableVersion, "1.0.17");
    assert.equal(receipt.stableSha256, sha256);
    assert.equal(receipt.stableMode, "0755");
    assert.deepEqual(await readFile(receipt.stablePath), baseline);
    assert.deepEqual(await readFile(artifact), baseline, "bootstrap must not mutate its sole verified source");
    assert.equal(
      (await readFile(join(slockHome, "computer", "k", "slots", "stable", "VERSION"), "utf8")).trim(),
      "1.0.17",
    );

    const rejectedHome = join(root, "rejected-state");
    const rejected = spawnSync(process.execPath, [
      fixturePath,
      "materialize-legacy-k-stable",
      "--slock-home",
      rejectedHome,
      "--version",
      "1.0.17",
      "--artifact",
      artifact,
      "--artifact-sha256",
      "0".repeat(64),
    ], { encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /BASELINE_LEGACY_K_SOURCE_BYTES_MISMATCH/u);
    await assert.rejects(
      stat(join(rejectedHome, "computer", "k")),
      /ENOENT/u,
      "wrong source hash must fail before writing any K state",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing-K materialization cleans every partial staging failure before stable publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "task645-existing-k-faults-"));
  try {
    const artifact = join(root, "raft-computer-1.0.17");
    const baseline = Buffer.from("exact public Computer 1.0.17 failure fixture bytes\n");
    await writeFile(artifact, baseline);
    const sha256 = createHash("sha256").update(baseline).digest("hex");
    const fixtureModule = await import(pathToFileURL(fixturePath).href) as {
      materializeLegacyKStable: (
        slockHome: string,
        version: string,
        artifactPath: string,
        expectedSha256: string,
        deps: {
          copyFileFn?: (source: string, destination: string) => Promise<void>;
          syncArtifactFn?: (path: string) => Promise<void>;
          writeVersionFn?: (path: string, version: string) => Promise<void>;
          renameFn?: (source: string, destination: string) => Promise<void>;
        },
      ) => Promise<unknown>;
    };
    const failures = [
      ["copy", { copyFileFn: async () => { throw new Error("fault-copy"); } }],
      ["artifact-sync", { syncArtifactFn: async () => { throw new Error("fault-artifact-sync"); } }],
      ["version-sync", { writeVersionFn: async (path: string) => {
        await writeFile(path, "partial");
        throw new Error("fault-version-sync");
      } }],
      ["rename", { renameFn: async () => { throw new Error("fault-rename"); } }],
    ] as const;

    for (const [name, deps] of failures) {
      const slockHome = join(root, name);
      await assert.rejects(
        fixtureModule.materializeLegacyKStable(slockHome, "1.0.17", artifact, sha256, deps),
        new RegExp(`fault-${name}`, "u"),
      );
      const stableDir = join(slockHome, "computer", "k", "slots", "stable");
      await assert.rejects(
        readFile(join(stableDir, "artifact.bin")),
        /ENOENT/u,
        `${name} must not publish stable`,
      );
      await assert.rejects(
        readFile(`${stableDir}.bootstrap/artifact.bin`),
        /ENOENT/u,
        `${name} must not leave reusable staged bytes`,
      );
      assert.deepEqual(await readFile(artifact), baseline, `${name} must not mutate the verified source`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy 1.0.17 K identity probe rejects the old alias spelling and accepts canonical launch identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "task620-legacy-k-"));
  try {
    const canonicalHome = join(root, "canonical-state");
    const lexicalHome = join(root, "alias-state");
    const binary = join(canonicalHome, "computer", "k", "slots", "stable", "artifact.bin");
    await mkdir(join(canonicalHome, "computer", "k", "slots", "stable"), { recursive: true });
    await writeFile(binary, "baseline");
    await symlink(canonicalHome, lexicalHome);
    const resolvedCanonicalHome = await realpath(canonicalHome);

    const accepted = spawnSync(process.execPath, [
      fixturePath,
      "assert-legacy-k-launch-identity",
      "--source-slock-home",
      lexicalHome,
      "--launch-slock-home",
      resolvedCanonicalHome,
      "--binary",
      binary,
    ], { encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    const receipt = JSON.parse(accepted.stdout) as {
      sourceWouldRedispatch: boolean;
      launchWouldRedispatch: boolean;
    };
    assert.equal(receipt.sourceWouldRedispatch, true);
    assert.equal(receipt.launchWouldRedispatch, false);

    const restoredOldAlias = spawnSync(process.execPath, [
      fixturePath,
      "assert-legacy-k-launch-identity",
      "--source-slock-home",
      lexicalHome,
      "--launch-slock-home",
      lexicalHome,
      "--binary",
      binary,
    ], { encoding: "utf8" });
    assert.equal(restoredOldAlias.status, 1);
    assert.match(restoredOldAlias.stderr, /BASELINE_LEGACY_K_SELF_DISPATCH_ALIAS/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture CLI seeds three identities and verifies a terminal failed K receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "task603-fixture-"));
  try {
    const slockHome = join(root, "state");
    execFileSync(process.execPath, [fixturePath, "seed", "--slock-home", slockHome, "--server-url", "http://127.0.0.1:1"]);
    const serverRoot = join(slockHome, "computer", "servers");
    for (const id of [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ]) {
      const attachment = JSON.parse(await readFile(join(serverRoot, id, "runner.state.json"), "utf8"));
      assert.equal(attachment.kind, "computer-attachment");
      assert.equal(await readFile(join(serverRoot, id, "managed.flag"), "utf8"), "managed\n");
    }

    const kDir = join(slockHome, "computer", "k");
    await mkdir(join(kDir, "slots", "stable"), { recursive: true });
    await writeFile(join(kDir, "slots", "stable", "VERSION"), "1.0.17\n");
    await writeFile(join(kDir, "slots", "stable", "artifact.bin"), "baseline");
    await writeFile(join(kDir, "operation.json"), `${JSON.stringify({
      fromVersion: "1.0.17",
      previousStableVersion: "1.0.17",
      targetVersion: "1.0.18",
      phase: "failed",
      outcome: "failed",
      acknowledgedAtMs: null,
    })}\n`);
    const receipt = JSON.parse(execFileSync(process.execPath, [
      fixturePath,
      "assert-failed-receipt",
      "--slock-home",
      slockHome,
    ], { encoding: "utf8" }));
    assert.equal(receipt.operation.outcome, "failed");
    assert.equal(receipt.operation.acknowledgedAtMs, null);
    assert.equal(receipt.stableVersion, "1.0.17");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture server exposes the exact failure source before any Computer mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "task603-server-"));
  const stateFile = join(root, "fixture.json");
  const child = spawn(process.execPath, [fixturePath, "serve", "--state-file", stateFile], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    let state: { serverUrl: string } | undefined;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        state = JSON.parse(await readFile(stateFile, "utf8"));
        break;
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    }
    assert.ok(state, "fixture server did not publish its state");
    const response = await fetch(`${state.serverUrl}/failure/1.0.18/manifest.json`);
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "fixture source unavailable\n");
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    await rm(root, { recursive: true, force: true });
  }
});
