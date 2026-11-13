# Computer artifact hosting

`publish-hands-hosted.mjs` receives final `dist-native` files from the existing signed build jobs. It validates all manifest references, uploads each representation with the Hands protocol-v1 direct-upload API, requires verified frozen slots, publishes through the release revision/scope gate and hashes the public bytes without following redirects. Release-candidate tags (`computer-v<x>-rc.<n>`) publish to the Hands `candidate` channel. `promote-existing` downloads the original hosted candidate from the channel named by `--candidate-channel` (default `candidate`), checks its RC/source/manifest/inventory receipts and publishes that same build to main. Only when that channel has no release for the version (an RC published to `alpha` before the `candidate` channel existed) does it read the candidate from `alpha`; an ambiguous candidate channel or a missing one fails instead.

The public bootstrap-script entry points (`computer/install.sh`, `computer/install.ps1`) are the production ones on `cdn.raft.build`; staging has no entry points of its own. Staging builds publish to the Hands `alpha` channel automatically on every relevant push to `staging`, and the staging web app installs them through the production scripts with `--channel alpha` (`curl -fsSL https://cdn.raft.build/computer/install.sh | sh -s -- --channel alpha`; on Windows `& ([scriptblock]::Create((irm https://cdn.raft.build/computer/install.ps1))) --channel alpha`), omitting the channel when a `RAFT_COMPUTER_VERSION` pin is given. The scripts themselves live in the public `botiverse/raft-computer-installer` repository; this repository pins one of its commits in `packages/computer/scripts/installer-entry.json`, and `scripts/ci/fetch-installer-entry.sh` fetches `bootstrap/install.sh` and `bootstrap/install.ps1` raw at that SHA for every job that needs them. Bumping the pin is an ordinary reviewed change.

## Existing release migration

Before beginning, ensure the Hands upload protocol and hosted gzip/WASM read paths are deployed. Retrieve the original version's manifest and every referenced file, verify SHA-256 and size, and keep the final files in a dedicated directory. Save control files and output receipts outside that directory.

Read the existing build and its published releases. Preserve the exact IDs. Write `expected.json` with the original `source`, `version_name`, integer `version_code`, `artifact_mode: "external"`, and `status: "succeeded"`; write `release-ids.json` as an array of the existing active/superseded release IDs for that build. Authenticate with an app-scoped Hands token in `HANDS_BEARER_TOKEN`; never place it in arguments, logs or these files.

Run the read-only plan first:

```sh
node packages/computer/scripts/native/backfill-hands-hosted.mjs \
  --app-id "$APP_ID" --app raft-computer-cli --build-id "$BUILD_ID" \
  --expected /path/to/expected.json --release-ids /path/to/release-ids.json \
  --manifest /path/to/final/manifest.json --artifact-dir /path/to/final \
  --output /path/to/plan.json
```

After checking the plan against the intended migration, repeat with `--mode apply` and a separate output receipt. The command rechecks identity, begins the frozen-slot migration, uploads/completes all assets, then atomically switches the same build to hosted storage. An interrupted run is retried with the same inputs. Pending declarations are not accepted as completed uploads. No release or channel pointer is created or moved by this command.

Keep the prior storage available until public byte checks and installation/rollback checks complete. A publish or migration response alone is not installation evidence. A historical version with no existing Hands build/release needs an explicit archival registration plan; do not publish it over the current main, candidate or alpha pointer.
