import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowPath = resolve(repoRoot, ".github/workflows/computer-installer-live-check.yml");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(resolve(repoRoot, "RELEASE_SOURCE"));
const workflow = inSourceSnapshot ? "" : readFileSync(workflowPath, "utf8");

const orderedSteps = [
  "Validate exact version inputs",
  "Configure isolated acceptance state",
  "Require exact Hands alpha candidate",
  "Fresh install exact pinned baseline",
  "Select alpha and install exact candidate",
  "Refuse unforced downgrade without mutation",
  "Force exact rollback to pinned baseline",
  "Re-upgrade from rolled-back dispatcher and verify composition",
] as const;

function jobBlock(source: string, jobName: string): string {
  const marker = `  ${jobName}:\n`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing job ${jobName}`);
  const remainder = source.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-z0-9-]+:\n/m);
  return source.slice(start, nextJob < 0 ? source.length : start + marker.length + nextJob);
}

function stepBlock(job: string, stepName: string): string {
  const marker = `      - name: ${stepName}\n`;
  const start = job.indexOf(marker);
  assert.ok(start >= 0, `missing step ${stepName}`);
  const remainder = job.slice(start + marker.length);
  const nextStep = remainder.search(/^      - (?:name|uses):/m);
  return job.slice(start, nextStep < 0 ? job.length : start + marker.length + nextStep);
}

function assertOrderedSteps(job: string, jobName: string): void {
  let prior = -1;
  for (const name of orderedSteps) {
    const position = job.indexOf(`      - name: ${name}\n`);
    assert.ok(position > prior, `${jobName}: step order must place ${name} after its predecessor`);
    prior = position;
  }
}

function assertMacContract(job: string): void {
  const validate = stepBlock(job, orderedSteps[0]);
  assert.match(validate, /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+-staging\\\.sha\\\.\[0-9a-f\]\{12\}\$/u,
    "macOS: expected candidate validation must require exact staging SHA SemVer");
  assert.match(validate, /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/u,
    "macOS: baseline validation must require plain release SemVer");

  const configure = stepBlock(job, orderedSteps[1]);
  for (const key of ["HOME", "SLOCK_HOME", "RAFT_HOME", "RAFT_COMPUTER_INSTALL_DIR", "COMPUTER_BINARY"]) {
    assert.match(configure, new RegExp(`echo "${key}=`), `macOS: isolated state must export ${key}`);
  }

  const hands = stepBlock(job, orderedSteps[2]);
  assert.match(hands, /apps\/raft-computer-cli\/latest\?channel=alpha&product_type=cli-binary/u,
    "macOS: Hands lookup must be fixed to raft-computer-cli alpha");
  assert.match(hands, /if \[ "\$HANDS_VERSION" != "\$EXPECTED_VERSION" \]; then/u,
    "macOS: Hands exact-equality tooth is missing");

  const baseline = stepBlock(job, orderedSteps[3]);
  assert.match(baseline, /RAFT_COMPUTER_VERSION="\$BASELINE_VERSION"/u,
    "macOS: baseline install must pin the exact version");
  assert.match(baseline, /RAFT_COMPUTER_INSTALL_CHANNEL="pinned:\$BASELINE_VERSION"/u,
    "macOS: baseline install must persist pinned:<baseline>");
  assert.match(baseline, /sh packages\/computer\/scripts\/install\.sh/u,
    "macOS: baseline must use the checked-out real installer");
  assert.match(baseline, /SLOCK_HOME="\$PROBE_HOME" RAFT_HOME="\$PROBE_HOME" "\$COMPUTER_BINARY" --version/u,
    "macOS: baseline must use a cold/self version readback");
  assert.match(baseline, /"\$COMPUTER_BINARY" channel show/u,
    "macOS: baseline must use dispatcher channel show");
  assert.match(baseline, /< "\$SLOCK_HOME\/computer\/channel"/u,
    "macOS: baseline must read the channel file");

  const candidate = stepBlock(job, orderedSteps[4]);
  assert.match(candidate, /"\$COMPUTER_BINARY" channel set alpha/u,
    "macOS: candidate transition must use the installed dispatcher");
  assert.match(candidate, /unset RAFT_COMPUTER_VERSION/u,
    "macOS: alpha install must remove the version pin");
  assert.match(candidate, /RAFT_COMPUTER_INSTALL_CHANNEL=alpha sh packages\/computer\/scripts\/install\.sh/u,
    "macOS: candidate must use the real unpinned alpha installer");
  assert.match(candidate, /CANDIDATE_SHA256="\$\(shasum -a 256 "\$COMPUTER_BINARY"/u,
    "macOS: candidate executable hash must be captured");

  const refusal = stepBlock(job, orderedSteps[5]);
  assert.match(refusal, /sh packages\/computer\/scripts\/install\.sh >"\$REFUSAL_LOG" 2>&1/u,
    "macOS: refusal must execute the real installer and capture its diagnostic");
  assert.match(refusal, /v\$EXPECTED_VERSION is NEWER than the target v\$BASELINE_VERSION; refusing to downgrade\./u,
    "macOS: refusal diagnostic tooth is missing");
  assert.match(refusal, /\[ "\$AFTER_SHA256" = "\$CANDIDATE_SHA256" \]/u,
    "macOS: refusal hash-preservation tooth is missing");
  assert.match(refusal, /\[ "\$COLD_VERSION" = "\$EXPECTED_VERSION" \]/u,
    "macOS: refusal version-preservation tooth is missing");
  assert.match(refusal, /\[ "\$CHANNEL_SHOW" = "alpha" \] && \[ "\$CHANNEL_FILE" = "alpha" \]/u,
    "macOS: refusal channel show/file preservation tooth is missing");

  const rollback = stepBlock(job, orderedSteps[6]);
  assert.match(rollback, /RAFT_COMPUTER_FORCE=1/u,
    "macOS: forced rollback must explicitly authorize the downgrade");
  assert.match(rollback, /FORCED_ROLLBACK_VERSION_MISMATCH/u,
    "macOS: forced rollback version readback is missing");
  assert.match(rollback, /FORCED_ROLLBACK_CHANNEL_MISMATCH/u,
    "macOS: forced rollback pinned channel readback is missing");

  const final = stepBlock(job, orderedSteps[7]);
  assert.match(final, /"\$COMPUTER_BINARY" channel set alpha/u,
    "macOS: re-upgrade must start through the rolled-back dispatcher");
  assert.match(final, /RAFT_COMPUTER_INSTALL_CHANNEL=alpha sh packages\/computer\/scripts\/install\.sh/u,
    "macOS: final re-upgrade must use the real unpinned alpha installer");
  assert.match(final, /FINAL_CANDIDATE_VERSION_MISMATCH/u,
    "macOS: final exact-version readback is missing");
  assert.match(final, /"\$COMPUTER_BINARY" __build-versions/u,
    "macOS: final composition must come from the installed executable");
  assert.match(final, /"computerVersion": expected, "cliVersion": "0\.0\.19", "daemonVersion": "1\.0\.20"/u,
    "macOS: final Computer/CLI/daemon composition tooth is missing");
}

function assertWindowsContract(job: string): void {
  const validate = stepBlock(job, orderedSteps[0]);
  assert.match(validate, /\^\\d\+\\\.\\d\+\\\.\\d\+-staging\\\.sha\\\.\[0-9a-f\]\{12\}\$/u,
    "Windows: expected candidate validation must require exact staging SHA SemVer");
  assert.match(validate, /\^\\d\+\\\.\\d\+\\\.\\d\+\$/u,
    "Windows: baseline validation must require plain release SemVer");

  const configure = stepBlock(job, orderedSteps[1]);
  for (const key of ["HOME", "USERPROFILE", "SLOCK_HOME", "RAFT_HOME", "RAFT_COMPUTER_INSTALL_DIR", "COMPUTER_BINARY"]) {
    assert.match(configure, new RegExp(`${key}=`), `Windows: isolated state must export ${key}`);
  }
  assert.doesNotMatch(configure, /^\s*\$home\s*=/imu,
    "Windows: configure step must not assign PowerShell's reserved automatic HOME variable");
  const acceptanceHome = configure.match(/^\s*\$(?<variable>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*Join-Path \$root 'home'\s*$/mu);
  assert.ok(acceptanceHome?.groups?.variable,
    "Windows: configure step must define a local acceptance-home variable");
  const acceptanceHomeVariable = acceptanceHome.groups.variable;
  assert.notEqual(acceptanceHomeVariable.toLowerCase(), "home",
    "Windows: configure step must not assign PowerShell's reserved automatic HOME variable");
  assert.match(configure, new RegExp(
    `"HOME=\\$${acceptanceHomeVariable}"[\\s\\S]*"USERPROFILE=\\$${acceptanceHomeVariable}"` +
      `[\\s\\S]*\\| Out-File -FilePath \\$env:GITHUB_ENV`,
  ), "Windows: the noncolliding acceptance-home variable must feed HOME and USERPROFILE in GITHUB_ENV");

  const hands = stepBlock(job, orderedSteps[2]);
  assert.match(hands, /apps\/raft-computer-cli\/latest\?channel=alpha&product_type=cli-binary/u,
    "Windows: Hands lookup must be fixed to raft-computer-cli alpha");
  assert.match(hands, /if \(\$handsVersion -ne \$env:EXPECTED_VERSION\)/u,
    "Windows: Hands exact-equality tooth is missing");

  const baseline = stepBlock(job, orderedSteps[3]);
  assert.match(baseline, /\$env:RAFT_COMPUTER_VERSION = \$env:BASELINE_VERSION/u,
    "Windows: baseline install must pin the exact version");
  assert.match(baseline, /\$env:RAFT_COMPUTER_INSTALL_CHANNEL = "pinned:\$env:BASELINE_VERSION"/u,
    "Windows: baseline install must persist pinned:<baseline>");
  assert.match(baseline, /powershell\.exe .* -File packages\\computer\\scripts\\install\.ps1/u,
    "Windows: baseline must run the checked-out real installer through Windows PowerShell");
  assert.match(baseline, /\$env:SLOCK_HOME = \$probe[\s\S]*\$env:RAFT_HOME = \$probe/u,
    "Windows: baseline must use a cold/self version readback");
  assert.match(baseline, /& \$env:COMPUTER_BINARY channel show/u,
    "Windows: baseline must use dispatcher channel show");
  assert.match(baseline, /computer\\channel/u,
    "Windows: baseline must read the channel file");

  const candidate = stepBlock(job, orderedSteps[4]);
  assert.match(candidate, /& \$env:COMPUTER_BINARY channel set alpha/u,
    "Windows: candidate transition must use the installed dispatcher");
  assert.match(candidate, /Remove-Item Env:RAFT_COMPUTER_VERSION/u,
    "Windows: alpha install must remove the version pin");
  assert.match(candidate, /\$env:RAFT_COMPUTER_INSTALL_CHANNEL = 'alpha'/u,
    "Windows: candidate install must select fixed alpha");
  assert.match(candidate, /Get-FileHash -LiteralPath \$env:COMPUTER_BINARY -Algorithm SHA256/u,
    "Windows: candidate executable hash must be captured");

  const refusal = stepBlock(job, orderedSteps[5]);
  assert.match(refusal, /@\(& powershell\.exe .* -File packages\\computer\\scripts\\install\.ps1 2>&1\)/u,
    "Windows: refusal must execute the real installer and capture its diagnostic");
  assert.match(refusal, /v\$env:EXPECTED_VERSION is newer than target v\$env:BASELINE_VERSION; refusing to downgrade/u,
    "Windows: refusal diagnostic tooth is missing");
  assert.match(refusal, /if \(\$afterSha -ne \$env:CANDIDATE_SHA256\)/u,
    "Windows: refusal hash-preservation tooth is missing");
  assert.match(refusal, /if \(\$coldVersion -ne \$env:EXPECTED_VERSION\)/u,
    "Windows: refusal version-preservation tooth is missing");
  assert.match(refusal, /\$channelShow -ne 'alpha' -or \$channelFile -ne 'alpha'/u,
    "Windows: refusal channel show/file preservation tooth is missing");

  const rollback = stepBlock(job, orderedSteps[6]);
  assert.match(rollback, /\$env:RAFT_COMPUTER_FORCE = '1'/u,
    "Windows: forced rollback must explicitly authorize the downgrade");
  assert.match(rollback, /FORCED_ROLLBACK_VERSION_MISMATCH/u,
    "Windows: forced rollback version readback is missing");
  assert.match(rollback, /FORCED_ROLLBACK_CHANNEL_MISMATCH/u,
    "Windows: forced rollback pinned channel readback is missing");

  const final = stepBlock(job, orderedSteps[7]);
  assert.match(final, /& \$env:COMPUTER_BINARY channel set alpha/u,
    "Windows: re-upgrade must start through the rolled-back dispatcher");
  assert.match(final, /Remove-Item Env:RAFT_COMPUTER_VERSION/u,
    "Windows: final re-upgrade must remove the version pin");
  assert.match(final, /FINAL_CANDIDATE_VERSION_MISMATCH/u,
    "Windows: final exact-version readback is missing");
  assert.match(final, /& \$env:COMPUTER_BINARY __build-versions \| ConvertFrom-Json/u,
    "Windows: final composition must come from the installed executable");
  assert.match(final, /cliVersion -ne '0\.0\.19'/u,
    "Windows: final CLI identity tooth is missing");
  assert.match(final, /daemonVersion -ne '1\.0\.20'/u,
    "Windows: final daemon identity tooth is missing");
}

function assertWorkflowContract(source: string): void {
  assert.match(source, /^on:\n  workflow_dispatch:\n    inputs:\n/mu,
    "workflow must remain dispatch-only");
  assert.doesNotMatch(source, /^\s{2}(?:push|schedule|workflow_run|repository_dispatch|workflow_call):/mu,
    "workflow must not gain an automatic or callable trigger");
  assert.match(source, /^permissions:\n  contents: read\n/mu,
    "workflow authority must remain contents:read only");

  const inputs = source.slice(source.indexOf("    inputs:\n"), source.indexOf("\npermissions:\n"));
  assert.match(inputs, /^      expected_version:/mu);
  assert.match(inputs, /^      baseline_version:/mu);
  assert.doesNotMatch(inputs, /^      (?:channel|hands_app|app|latest):/mu,
    "caller-selectable app/channel/latest inputs are forbidden");
  assert.doesNotMatch(source, /\$\{\{ inputs\.(?:channel|hands_app|app|latest) \}\}/u,
    "caller-selected app/channel/latest values must not reach a run body");

  const jobsSource = source.slice(source.indexOf("jobs:\n") + "jobs:\n".length);
  assert.deepEqual(
    [...jobsSource.matchAll(/^  ([a-z0-9-]+):$/gmu)].map((match) => match[1]),
    ["macos-alpha-acceptance", "windows-alpha-acceptance"],
    "only the disposable macOS and Windows acceptance jobs are allowed",
  );

  const mac = jobBlock(source, "macos-alpha-acceptance");
  const windows = jobBlock(source, "windows-alpha-acceptance");
  assertOrderedSteps(mac, "macOS");
  assertOrderedSteps(windows, "Windows");
  assertMacContract(mac);
  assertWindowsContract(windows);

  assert.equal((source.match(/RAFT_COMPUTER_FORCE/g) ?? []).length, 2,
    "force authority must appear once per platform and only in the forced rollback steps");
  assert.match(stepBlock(mac, orderedSteps[6]), /RAFT_COMPUTER_FORCE=1/u);
  assert.match(stepBlock(windows, orderedSteps[6]), /RAFT_COMPUTER_FORCE = '1'/u);

  assert.doesNotMatch(source, /secrets\.|aws\s|wrangler|s3:\/\/|upload-artifact|download-artifact|raft-computer (?:start|setup|attach)|channel set latest/iu,
    "workflow must not gain secret, publish, deploy, external-machine, or stable-channel authority");
}

test.skipIf(inSourceSnapshot)("Computer alpha live check binds the full macOS and Windows rollback state machine", () => {
  assertWorkflowContract(workflow);
});

test.skipIf(inSourceSnapshot)("Computer alpha live check contract has right-cause mutation teeth", () => {
  assert.throws(
    () => assertWorkflowContract(workflow.replace(
      'if [ "$HANDS_VERSION" != "$EXPECTED_VERSION" ]; then',
      'if [ -z "$HANDS_VERSION" ]; then',
    )),
    /macOS: Hands exact-equality tooth is missing/u,
  );
  assert.throws(
    () => assertWorkflowContract(workflow.replace(
      '[ "$AFTER_SHA256" = "$CANDIDATE_SHA256" ]',
      '[ -n "$AFTER_SHA256" ]',
    )),
    /macOS: refusal hash-preservation tooth is missing/u,
  );
  assert.throws(
    () => assertWorkflowContract(workflow.replace("RAFT_COMPUTER_FORCE=1", "FORCE_REMOVED=1")),
    /macOS: forced rollback must explicitly authorize the downgrade/u,
  );
  assert.throws(
    () => assertWorkflowContract(workflow.replace(
      'BUILD_VERSIONS="$("$COMPUTER_BINARY" __build-versions)"',
      "BUILD_VERSIONS='{}'",
    )),
    /macOS: final composition must come from the installed executable/u,
  );
  assert.throws(
    () => assertWorkflowContract(workflow.replaceAll("$acceptanceHome", "$home")),
    /Windows: configure step must not assign PowerShell's reserved automatic HOME variable/u,
  );
});
