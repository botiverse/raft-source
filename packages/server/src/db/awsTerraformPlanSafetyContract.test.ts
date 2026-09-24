import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const REPO_ROOT = path.resolve(SERVER_ROOT, "../..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(path.join(REPO_ROOT, "RELEASE_SOURCE"));
const PLAN_SAFETY_COMMAND =
  'terraform -chdir="$env_dir" show -no-color "$plan_path" | "$repo_root/scripts/deploy/aws-terraform-plan-safety.sh"';

// An options object's `skip` overrides a chained `skipIf`, so both conditions
// go through `skipIf`.
test.skipIf(process.platform === "win32" || inSourceSnapshot)(
  "AWS Terraform plan safety permits task revisions and blocks Cloud Map replacement",
  async () => {
    const contractScript = path.resolve(
      REPO_ROOT,
      "scripts/deploy/aws-terraform-plan-safety.test.sh",
    );
    const { stdout } = await execFileAsync("bash", [contractScript]);

    assert.match(stdout, /aws-terraform-plan-safety tests passed/);
  },
);

test.skipIf(inSourceSnapshot)("AWS Terraform validation and apply inspect the saved plan before mutation", () => {
  const validateScript = readFileSync(
    path.resolve(REPO_ROOT, "scripts/deploy/aws-terraform-validate-config.sh"),
    "utf8",
  );
  const applyScript = readFileSync(
    path.resolve(REPO_ROOT, "scripts/deploy/aws-terraform-apply.sh"),
    "utf8",
  );

  assert.equal(validateScript.split(PLAN_SAFETY_COMMAND).length - 1, 2);
  assert.equal(applyScript.split(PLAN_SAFETY_COMMAND).length - 1, 1);
  assert.ok(
    applyScript.indexOf(PLAN_SAFETY_COMMAND) <
      applyScript.indexOf('terraform -chdir="$env_dir" apply'),
    "the destructive-plan gate must run before Terraform apply",
  );
});
