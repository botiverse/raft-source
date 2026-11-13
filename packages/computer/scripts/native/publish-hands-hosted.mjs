#!/usr/bin/env node
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CANDIDATE_CHANNEL, downloadHandsCandidate } from './download-hands-candidate.mjs';
import { pathToFileURL } from 'node:url';
import { createHandsClient, resolveAppAndChannel, versionCodeFromVersion } from './publish-hands-release.mjs';
import { loadHostedArtifacts, assertHostedAssetSet, verifyHostedRelease } from './hands-artifacts.mjs';

function object(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function assertBuild(build, { version, versionCode, sourceCommit }) {
  const provenance = object(build.provenance_json);
  if (build.version_name !== version || Number(build.version_code) !== versionCode || build.source !== 'ci' ||
      build.artifact_mode !== 'hands_r2' || build.product_type !== 'cli-binary' || build.release_type !== 'stable' ||
      provenance?.source_commit !== sourceCommit || provenance?.ci_provider !== 'github-actions') {
    throw new Error('existing Hands build is not the exact hosted source candidate');
  }
}
const selector = a => JSON.stringify([a.artifact_kind, a.platform, a.arch, a.variant ?? null, a.filetype]);

/** Upload final bytes before publishing; interrupted uploads can resume only
 * against the identical source, version and per-representation identity. */
export async function publishHosted(options) {
  if (!/^[a-f0-9]{40}$/.test(options.sourceCommit)) throw new Error('full source commit required');
  if (options.mode && !['register', 'register-or-exact-reuse', 'promote-existing'].includes(options.mode)) throw new Error('unsupported publication mode');
  if (!options.runId || !options.runUrl) throw new Error('CI run identity required');
  const runUrl = new URL(options.runUrl);
  if (runUrl.protocol !== 'https:' || runUrl.username || runUrl.password || runUrl.hash || runUrl.search) throw new Error('invalid CI run URL');
  const verified = await loadHostedArtifacts(options);
  if (options.mode === 'promote-existing') {
    const receipt = JSON.parse(await readFile(join(options.artifactDir, 'candidate-receipt.json'), 'utf8'));
    if (receipt.schemaVersion !== 1 || receipt.sourceSha !== options.sourceCommit || receipt.version !== verified.version ||
        typeof receipt.rcTag !== 'string' || !receipt.rcTag.startsWith(`computer-v${verified.version}-rc.`) ||
        !/^[1-9][0-9]*$/.test(receipt.rcTag.slice(`computer-v${verified.version}-rc.`.length))) throw new Error('promotion requires exact RC candidate provenance');
    const manifest = verified.files.find(f => f.file === 'manifest.json');
    if (receipt.manifestSha256 !== manifest.sha256) throw new Error('candidate manifest identity mismatch');
    const inventoryFile = verified.files.find(f => f.file === 'candidate-inventory.json');
    if (!inventoryFile || receipt.inventorySha256 !== inventoryFile.sha256) throw new Error('candidate inventory identity mismatch');
    const inventory = JSON.parse(await readFile(inventoryFile.path, 'utf8'));
    const physical = new Map(verified.files.filter(f => !['candidate-inventory.json', 'candidate-receipt.json'].includes(f.file)).map(f => [f.file, f]));
    if (!Array.isArray(inventory) || inventory.length !== physical.size) throw new Error('candidate inventory count mismatch');
    for (const entry of inventory) {
      const file = physical.get(entry.file);
      if (!file || file.sha256 !== entry.sha256 || file.size_bytes !== entry.sizeBytes) throw new Error('candidate inventory file mismatch');
      physical.delete(entry.file);
    }
  }
  if (options.expectedVersion !== verified.version) throw new Error('expected version differs from manifest');
  const versionCode = versionCodeFromVersion(verified.version);
  const api = options.api ?? createHandsClient({ apiBase: options.apiBase, token: options.token });
  const { appId, channelId } = await resolveAppAndChannel(api, options.appSlug, options.channel);
  const identity = { version: verified.version, versionCode, sourceCommit: options.sourceCommit };
  const response = await api('GET', `/api/apps/${appId}/builds?version_name=${encodeURIComponent(verified.version)}`);
  const matches = (response.builds ?? []).filter(b => b.version_name === verified.version);
  if (matches.length > 1) throw new Error('ambiguous Hands version');
  let build = matches[0];
  if (build) {
    // List responses need not carry artifact_mode; use the authoritative detail.
    build = await api('GET', `/api/apps/${appId}/builds/${build.id}`);
    assertBuild(build, identity);
  } else {
    if (options.mode === 'promote-existing') throw new Error('hosted candidate absent; promotion cannot rebuild');
    const created = await api('POST', `/api/apps/${appId}/builds`, {
      channel_id: channelId, product_type: 'cli-binary', release_type: 'stable',
      version_name: verified.version, version_code: versionCode, source: 'ci', status: 'pending', artifact_mode: 'hands_r2',
      asset_ingest_protocol_version: 1, required_asset_slots_json: verified.assets.map(({ artifact_kind, platform, arch, variant, filetype }) => ({ artifact_kind, platform, arch, variant, filetype })),
      build_metadata_json: { node_version: verified.nodeVersion, publisher: 'computer-hands-hosted-v1' },
      provenance_json: { source_commit: options.sourceCommit, ci_provider: 'github-actions', ci_run_id: options.runId, ci_url: options.runUrl },
    });
    build = await api('GET', `/api/apps/${appId}/builds/${created.id}`);
    assertBuild(build, identity);
  }
  const slots = object(build.required_asset_slots_json);
  if (Number(build.asset_ingest_protocol_version) !== 1 || !Array.isArray(slots) ||
      JSON.stringify(slots.map(selector).sort()) !== JSON.stringify(verified.assets.map(selector).sort())) {
    throw new Error('existing build frozen slots differ from candidate');
  }
  const path = `/api/apps/${appId}/builds/${build.id}`;
  const existing = (await api('GET', `${path}/assets`)).assets;
  if (!Array.isArray(existing)) throw new Error('invalid hosted asset list');
  const wanted = new Map(verified.assets.map(a => [selector(a), a]));
  const seen = new Set();
  for (const row of existing) {
    const key = selector(row), expected = wanted.get(key);
    if (!expected || seen.has(key)) throw new Error('existing hosted inventory differs from candidate');
    if ((row.file_hash && row.file_hash !== expected.sha256) || Number(row.size_bytes) !== expected.size_bytes) throw new Error('existing hosted declaration identity mismatch');
    seen.add(key);
  }
  if (options.mode === 'promote-existing' && seen.size !== wanted.size) throw new Error('promotion requires complete existing hosted inventory');
  for (const asset of verified.assets) {
    if (options.mode === 'promote-existing') continue;
    // The declaration endpoint is idempotent and reports ready without a PUT.
    // Revisit even known selectors: a row can still be an unfinished upload.
    await options.uploadAsset({ api, apiBase: options.apiBase, token: options.token, appId, buildId: build.id, asset });
  }
  const finalAssets = (await api('GET', `${path}/assets`)).assets;
  assertHostedAssetSet(finalAssets, verified.assets);
  if (build.status !== 'succeeded') await api('PATCH', path, { status: 'succeeded' });
  // Platform activation must atomically bind this exact hosted asset set. The
  // adapter is supplied by the supported Hands publication protocol, never an
  // external-target registration or a CDN fallback.
  const release = await options.activateRelease({ api, appId, buildId: build.id, channelId, version: verified.version, versionCode, assets: finalAssets });
  try {
    await verifyHostedRelease({ origin: options.apiBase, appSlug: options.appSlug, releaseId: release.id, assets: verified.assets, fetchImpl: options.publicFetch });
  } catch (error) {
    // Activation already happened; say so, or a red job reads as "not published".
    error.message = `release ${release.id} (${verified.version}) is ACTIVE on ${options.channel}; public readback failed: ${error.message}`;
    throw error;
  }
  return { version: verified.version, source_commit: options.sourceCommit, build_id: build.id, release_id: release.id, channel: options.channel,
    hosted_files: verified.files.map(({ file, sha256, size_bytes }) => ({ file, sha256, size_bytes })), status: 'hosted-and-public-bytes-verified' };
}

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) throw new Error('expected --option value');
    args[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  // Kept separate from inventory/release logic so transport changes do not
  // change the byte and identity gates above.
  const { uploadAsset, activateRelease } = await import('./hands-hosted-transport.mjs');
  const options = { manifestPath: args.manifest, artifactDir: args['artifact-dir'], appSlug: args.app,
    channel: args.channel, expectedVersion: args['expected-version'], sourceCommit: args['source-commit'],
    runId: args['run-id'], runUrl: args['run-url'], mode: args.mode,
    // Promotion only: the channel the release candidate was published to.
    candidateChannel: args['candidate-channel'] ?? DEFAULT_CANDIDATE_CHANNEL,
    apiBase: process.env.HANDS_API ?? 'https://hands.build', token: process.env.HANDS_BEARER_TOKEN,
    uploadAsset, activateRelease };
  options.api = createHandsClient({ apiBase: options.apiBase, token: options.token });
  let candidateDir;
  try {
    if (options.mode === 'promote-existing' && !options.manifestPath) {
      candidateDir = await mkdtemp(join(tmpdir(), 'hands-candidate-'));
      Object.assign(options, await downloadHandsCandidate({ ...options, version: options.expectedVersion, dir: candidateDir }));
      process.stderr.write(`promotion candidate ${options.expectedVersion} taken from Hands channel ${options.candidateChannel}\n`);
    }
    const result = await publishHosted(options);
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    if (candidateDir) await rm(candidateDir, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
