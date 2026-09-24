import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));
const workflow = readFileSync(
  join(repositoryRoot, ".github/workflows/publish-raft-sdk.yml"),
  "utf8",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(workflow.includes('- "raft-sdk-v*"'), "publish workflow must be tag-only for raft-sdk-v*");
assert(!workflow.includes("workflow_dispatch:"), "publish workflow must not expose an unbound manual dispatch");
for (const historicalContract of [
  "The 0.1.0 release was bootstrapped once by an npm maintainer",
  "permits trusted-publisher setup after the package exists",
  "All later versions",
  "use this exact tag-only OIDC lane",
  "no maintainer token or local publish is part",
  "of the continuing contract",
]) {
  assert(
    workflow.includes(historicalContract),
    `publish workflow must record the bootstrap boundary: ${historicalContract}`,
  );
}
assert(
  !workflow.includes("initial 0.1.0 release and all later versions use"),
  "publish workflow must not claim that the bootstrapped 0.1.0 release used repository OIDC",
);
assert(workflow.includes("id-token: write"), "publish workflow must grant OIDC id-token permission");
assert(workflow.includes("runs-on: ubuntu-latest"), "trusted publishing must use a GitHub-hosted runner");
assert(workflow.includes("npm@11.18.0"), "publish workflow must pin an OIDC-capable npm version");
assert(workflow.includes("pnpm install --frozen-lockfile"), "publish workflow must use the frozen lockfile");
for (const gate of ["lint:publish-package", "test:artifact", "typecheck", "test"]) {
  assert(workflow.includes(`@botiverse/raft-sdk ${gate}`), `publish workflow must run ${gate}`);
}
assert(
  workflow.includes('EXPECTED="raft-sdk-v$(node -p'),
  "publish workflow must bind the tag to package.json version",
);
assert(
  workflow.includes('npm publish "${{ steps.artifact.outputs.path }}"'),
  "publish workflow must publish the exact pre-read artifact",
);
assert(
  workflow.includes('test "$(sha256sum "$REGISTRY_TARBALL"'),
  "publish workflow must compare registry bytes with the published tarball",
);
assert(
  workflow.includes('import("@botiverse/raft-sdk")')
    && workflow.includes('require("@botiverse/raft-sdk")'),
  "publish workflow must execute registry ESM and CJS entry points",
);

console.log("@botiverse/raft-sdk publish workflow contract is valid.");
