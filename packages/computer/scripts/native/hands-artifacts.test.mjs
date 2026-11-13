import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { REQUIRED_TARGETS, loadHostedArtifacts, assertHostedAssetSet, verifyHostedRelease } from './hands-artifacts.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'hands-hosted-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  onTestFinished(cleanup);
  const bytes = new Map();
  async function file(name, data) { bytes.set(name, data); await writeFile(join(dir, name), data); return { file: name, sha256: sha(data), size: data.length }; }
  const manifest = { version: '1.0.37', nodeVersion: '26.8.2', targets: {}, photonWasm: await file('photon_rs_bg.wasm', Buffer.from('wasm')) };
  for (const target of REQUIRED_TARGETS) {
    const raw = Buffer.from(`native-${target}`);
    manifest.targets[target] = { ...await file(`raft-computer-${target}`, raw), gz: await file(`raft-computer-${target}.gz`, gzipSync(raw)) };
  }
  await file('manifest.json', Buffer.from(JSON.stringify(manifest)));
  const inventory = await file('candidate-inventory.json', Buffer.from(JSON.stringify([...bytes].map(([file, data]) => ({ file, sha256: sha(data), sizeBytes: data.length })))));
  await file('candidate-receipt.json', Buffer.from(JSON.stringify({ schemaVersion: 1, sourceSha: 'a'.repeat(40), version: manifest.version, rcTag: `computer-v${manifest.version}-rc.1`, manifestSha256: sha(bytes.get('manifest.json')), inventorySha256: inventory.sha256 })));
  const options = { manifestPath: join(dir, 'manifest.json'), artifactDir: dir };
  return { options, manifest, bytes, dir };
}

test('all platform representations and final audit files survive hosting; public bytes are independently hashed', async t => {
  const f = await fixture();
  const verified = await loadHostedArtifacts(f.options);
  assert.equal(verified.files.length, 14);
  assert.equal(verified.assets.length, 18); // 5 raw + 5 gzip + 5 same-byte WASM selectors + 3 audit files.
  const rows = verified.assets.map(a => ({ ...a, file_hash: a.sha256, r2_key: `hosted/${a.sha256}`, ingest_state: 'ready', committed_final_key: `hosted/${a.sha256}`, verified_sha256: a.sha256, verified_size_bytes: a.size_bytes }));
  assertHostedAssetSet(rows, verified.assets);
  for (const change of [{ ingest_state: 'pending' }, { verified_sha256: null }, { committed_final_key: null }, { verified_size_bytes: 0 }]) {
    assert.throws(() => assertHostedAssetSet(rows.map((r, i) => i ? r : { ...r, ...change }), verified.assets), /not verified ready/);
  }
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    const variant = url.searchParams.get('kind') ?? (url.pathname.endsWith('.gz') ? 'gzip' : null);
    const target = url.pathname.split('/').at(-1).replace(/\.gz$/, '');
    const asset = verified.assets.find(a => a.target === target && a.variant === variant);
    assert.ok(asset, String(url));
    return new Response(f.bytes.get(asset.file));
  };
  await verifyHostedRelease({ origin: 'https://hands.build', appSlug: 'raft-computer-cli', releaseId: 'fixed', assets: verified.assets, fetchImpl });
  assert.equal(calls.length, 18);
  assert.ok(calls.every(([url, options]) => url.pathname.startsWith('/dl/raft-computer-cli/releases/fixed/') && options.redirect === 'manual' && !options.headers.authorization));
  const storage = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/hands-artifacts/apps/x/';
  const viaStorage = [];
  await verifyHostedRelease({ origin: 'https://hands.build', appSlug: 'raft-computer-cli', releaseId: 'fixed', assets: verified.assets, fetchImpl: async (url, options) => {
    viaStorage.push([String(url), options.redirect]);
    if (url.hostname === 'hands.build') return new Response(null, { status: 302, headers: { location: `${storage}${encodeURIComponent(url.pathname + url.search)}?X-Amz-Signature=s` } });
    const original = new URL(decodeURIComponent(url.pathname.slice(new URL(storage).pathname.length)), 'https://hands.build');
    return fetchImpl(original, options);
  } });
  assert.equal(viaStorage.length, 36);
  assert.ok(viaStorage.filter(([u]) => u.startsWith(storage)).every(([, redirect]) => redirect === 'error'));
  for (const location of ['https://cdn.slock.ai/computer/1.0.40/raft-computer-linux-x64', 'http://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/hands-artifacts/x', 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/other-bucket/x']) {
    await assert.rejects(verifyHostedRelease({ origin: 'https://hands.build', appSlug: 'raft-computer-cli', releaseId: 'fixed', assets: verified.assets, fetchImpl: async () => new Response(null, { status: 302, headers: { location } }) }), /redirected outside Hands storage/);
  }
  await assert.rejects(verifyHostedRelease({ origin: 'https://hands.build', appSlug: 'raft-computer-cli', releaseId: 'fixed', assets: verified.assets, fetchImpl: async () => new Response('incorrect') }), /identity mismatch|not verified ready/);
  assert.throws(() => assertHostedAssetSet(rows.slice(1), verified.assets), /count mismatch/);
  // One stalled storage read is retried from the Hands URL and succeeds.
  let stalls = 1;
  const flaky = async (url, options) => {
    if (stalls > 0) { stalls -= 1; return new Response(new ReadableStream({ start(c) { options.signal.addEventListener('abort', () => c.error(options.signal.reason)); } })); }
    return fetchImpl(url, options);
  };
  await verifyHostedRelease({ origin: 'https://hands.build', appSlug: 'raft-computer-cli', releaseId: 'fixed', assets: verified.assets, fetchImpl: flaky, timeoutMs: 50 });
  assert.equal(stalls, 0);
  // Identity mismatch is final: no retry.
  let reads = 0;
  await assert.rejects(verifyHostedRelease({ origin: 'https://hands.build', appSlug: 'raft-computer-cli', releaseId: 'fixed', assets: verified.assets, fetchImpl: async () => { reads += 1; return new Response('incorrect'); } }), /identity mismatch|exceeds declared size/);
  assert.equal(reads, 1);
  // A stalled body must end the readback instead of holding the job open.
  const stalled = async (_url, options) => new Response(new ReadableStream({ start(controller) {
    options.signal.addEventListener('abort', () => controller.error(options.signal.reason));
  } }));
  await assert.rejects(
    verifyHostedRelease({ origin: 'https://hands.build', appSlug: 'raft-computer-cli', releaseId: 'fixed', assets: verified.assets, fetchImpl: stalled, timeoutMs: 50 }),
    /^Error: Hands public readback transport failed for \S+ \(attempt 2\/2, 0 bytes in \d+ s\) \(TimeoutError\)$/,
  );
  const hung = async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
  await assert.rejects(
    verifyHostedRelease({ origin: 'https://hands.build', appSlug: 'raft-computer-cli', releaseId: 'fixed', assets: verified.assets, fetchImpl: hung, timeoutMs: 50 }),
    /transport failed for \S+ \(attempt 2\/2, .*\) \(TimeoutError\)/,
  );
  assert.throws(() => assertHostedAssetSet(rows.map((r, i) => i ? r : { ...r, r2_key: null, external_url: 'https://cdn.invalid' }), verified.assets), /missing hosted/);
});

test('matching compressed hash is insufficient when decoded content differs from raw', async t => {
  const f = await fixture();
  const target = f.manifest.targets['linux-x64'];
  const wrong = gzipSync(Buffer.from('different executable'));
  target.gz.sha256 = sha(wrong); target.gz.size = wrong.length;
  await writeFile(join(f.dir, target.gz.file), wrong);
  await writeFile(f.options.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(loadHostedArtifacts(f.options), /decoded gzip: artifact identity mismatch/);
});

test('hosted publisher cannot activate after a partial upload, and exact retry completes same build', async t => {
  const { publishHosted } = await import('./publish-hands-hosted.mjs');
  const f = await fixture();
  let build = null, activated = 0, uploads = 0, failure = true;
  const rows = [];
  const api = async (method, path, body) => {
    if (path === '/api/apps') return { apps: [{ id: 'app', slug: 'raft-computer-cli' }] };
    if (path.endsWith('/channels')) return { channels: [{ id: 'alpha', slug: 'alpha' }] };
    if (path.includes('/builds?')) return { builds: build ? [build] : [] };
    if (method === 'POST' && path.endsWith('/builds')) { build = { id: 'build', ...body }; return build; }
    if (path.endsWith('/assets')) return { assets: rows };
    if (method === 'GET' && path.endsWith('/builds/build')) return build;
    if (method === 'PATCH') { Object.assign(build, body); return build; }
    throw new Error('unexpected request: ' + path);
  };
  const options = { ...f.options, api, apiBase: 'https://hands.build', appSlug: 'raft-computer-cli', channel: 'alpha',
    expectedVersion: f.manifest.version, sourceCommit: 'a'.repeat(40), runId: '123', runUrl: 'https://github.com/org/repo/actions/runs/123',
    uploadAsset: async ({ asset }) => {
      if (rows.some(r => r.target === asset.target && r.variant === asset.variant)) return;
      uploads++;
      if (failure && uploads === 4) throw new Error('upload interrupted');
      rows.push({ ...asset, id: String(rows.length), file_hash: asset.sha256, r2_key: asset.sha256, ingest_state: 'ready', committed_final_key: asset.sha256, verified_sha256: asset.sha256, verified_size_bytes: asset.size_bytes });
    },
    activateRelease: async ({ assets }) => { assert.equal(assets.length, 18); activated++; return { id: 'release' }; },
    publicFetch: async url => {
      const target = url.pathname.split('/').at(-1).replace(/\.gz$/, '');
      const variant = url.searchParams.get('kind') ?? (url.pathname.endsWith('.gz') ? 'gzip' : null);
      const row = rows.find(r => r.target === target && r.variant === variant);
      return new Response(f.bytes.get(row.file));
    } };
  await assert.rejects(publishHosted(options), /upload interrupted/);
  assert.equal(activated, 0); assert.equal(rows.length, 3);
  failure = false;
  const result = await publishHosted(options);
  assert.equal(result.build_id, 'build'); assert.equal(rows.length, 18); assert.equal(activated, 1);
  const count = uploads;
  await publishHosted({ ...options, mode: 'promote-existing' });
  assert.equal(uploads, count);
  rows[0].file_hash = '0'.repeat(64);
  await assert.rejects(publishHosted(options), /identity mismatch|not verified ready/);
  assert.equal(uploads, count); assert.equal(activated, 2);
  rows[0].file_hash = rows[0].sha256;
  // A readback failure after activation must say the release is live.
  await assert.rejects(publishHosted({ ...options, publicFetch: async () => new Response('corrupt') }),
    /^Error: release release \(\S+\) is ACTIVE on alpha; public readback failed: public \S+: artifact identity mismatch$/);
  assert.equal(activated, 3);
});

test('promotion fetches the hosted original files and rejects byte corruption or different source before activation', async t => {
  const { downloadHandsCandidate } = await import('./download-hands-candidate.mjs');
  const f = await fixture();
  const v = await loadHostedArtifacts(f.options);
  const rows = v.assets.map(a => ({ ...a, file_hash: a.sha256, r2_key: a.sha256, metadata_json: JSON.stringify({ file_name: a.file }) }));
  const api = async (_, path) => {
    if (path === '/api/apps') return { apps: [{ id: 'app', slug: 'raft-computer-cli' }] };
    if (path.endsWith('/channels')) return { channels: [{ id: 'candidate', slug: 'candidate' }] };
    if (path.includes('/releases?')) return { releases: [{ id: 'fixed', build_id: 'build', version_name: v.version, status: 'superseded' }] };
    if (path.endsWith('/assets')) return { assets: rows };
    return { id: 'build', artifact_mode: 'hands_r2', version_name: v.version, provenance_json: { source_commit: 'a'.repeat(40) } };
  };
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    const target = url.pathname.split('/').at(-1).replace(/\.gz$/, '');
    const variant = url.searchParams.get('kind') ?? (url.pathname.endsWith('.gz') ? 'gzip' : null);
    const row = rows.find(r => r.target === target && r.variant === variant);
    assert.match(url.pathname, /\/releases\/fixed\//);
    return new Response(f.bytes.get(row.file));
  };
  const options = { api, apiBase: 'https://hands.build', appSlug: 'raft-computer-cli', version: v.version, sourceCommit: 'a'.repeat(40), dir: join(f.dir, 'download'), fetchImpl };
  const downloaded = await downloadHandsCandidate(options);
  assert.equal(calls, 14);
  const checked = await loadHostedArtifacts(downloaded);
  assert.deepEqual(checked.files.map(({ file, sha256 }) => [file, sha256]).sort(), v.files.map(({ file, sha256 }) => [file, sha256]).sort());
  await assert.rejects(downloadHandsCandidate({ ...options, sourceCommit: 'b'.repeat(40), dir: join(f.dir, 'wrong-source') }), /source identity mismatch/);
  assert.equal(calls, 14);
  await assert.rejects(downloadHandsCandidate({ ...options, dir: join(f.dir, 'corrupt'), fetchImpl: async () => new Response('evil') }), /frozen identity/);
});

test('promotion takes the candidate from the candidate channel, falling back to alpha only when candidate has no release for the version', async t => {
  const { downloadHandsCandidate } = await import('./download-hands-candidate.mjs');
  const f = await fixture();
  const v = await loadHostedArtifacts(f.options);
  const rows = v.assets.map(a => ({ ...a, file_hash: a.sha256, r2_key: a.sha256, metadata_json: JSON.stringify({ file_name: a.file }) }));
  const releasesByChannel = { 'ch-candidate': [], 'ch-alpha': [] };
  const released = id => ({ id, build_id: 'build', version_name: v.version, status: 'active' });
  const queried = [];
  const api = async (_, path) => {
    if (path === '/api/apps') return { apps: [{ id: 'app', slug: 'raft-computer-cli' }] };
    if (path.endsWith('/channels')) return { channels: [{ id: 'ch-candidate', slug: 'candidate' }, { id: 'ch-alpha', slug: 'alpha' }] };
    if (path.includes('/releases?')) {
      const channel = new URLSearchParams(path.split('?')[1]).get('channel');
      queried.push(channel);
      return { releases: releasesByChannel[channel] };
    }
    if (path.endsWith('/assets')) return { assets: rows };
    return { id: 'build', artifact_mode: 'hands_r2', version_name: v.version, provenance_json: { source_commit: 'a'.repeat(40) } };
  };
  const fetchedFrom = new Set();
  const fetchImpl = async url => {
    fetchedFrom.add(url.pathname.split('/releases/')[1].split('/')[0]);
    const target = url.pathname.split('/').at(-1).replace(/\.gz$/, '');
    const variant = url.searchParams.get('kind') ?? (url.pathname.endsWith('.gz') ? 'gzip' : null);
    return new Response(f.bytes.get(rows.find(r => r.target === target && r.variant === variant).file));
  };
  const options = { api, apiBase: 'https://hands.build', appSlug: 'raft-computer-cli', version: v.version, sourceCommit: 'a'.repeat(40), fetchImpl };

  // Candidate present on both channels: candidate wins, alpha is never read.
  releasesByChannel['ch-candidate'] = [released('rel-candidate')];
  releasesByChannel['ch-alpha'] = [released('rel-alpha')];
  const fromCandidate = await downloadHandsCandidate({ ...options, dir: join(f.dir, 'candidate') });
  assert.equal(fromCandidate.candidateChannel, 'candidate');
  assert.deepEqual(queried, ['ch-candidate']);
  assert.deepEqual([...fetchedFrom], ['rel-candidate']);

  // Switch-over version: its rc went to alpha, candidate has none -> alpha.
  queried.length = 0; fetchedFrom.clear();
  releasesByChannel['ch-candidate'] = [];
  const fromAlpha = await downloadHandsCandidate({ ...options, dir: join(f.dir, 'alpha') });
  assert.equal(fromAlpha.candidateChannel, 'alpha');
  assert.deepEqual(queried, ['ch-candidate', 'ch-alpha']);
  assert.deepEqual([...fetchedFrom], ['rel-alpha']);
  assert.equal((await loadHostedArtifacts(fromAlpha)).version, v.version);

  // Neither channel has it: fail naming both channels.
  releasesByChannel['ch-alpha'] = [];
  await assert.rejects(downloadHandsCandidate({ ...options, dir: join(f.dir, 'none') }),
    /one published candidate for 1\.0\.37 on candidate or alpha; found 0/);

  // An ambiguous candidate channel is an error, never a reason to read alpha.
  queried.length = 0;
  releasesByChannel['ch-candidate'] = [released('a'), released('b')];
  releasesByChannel['ch-alpha'] = [released('rel-alpha')];
  await assert.rejects(downloadHandsCandidate({ ...options, dir: join(f.dir, 'ambiguous') }), /on candidate; found 2$/);
  assert.deepEqual(queried, ['ch-candidate']);

  // A missing candidate channel is a Hands setup error, not a fallback.
  const noChannel = async (m, path) => path.endsWith('/channels') ? { channels: [{ id: 'ch-alpha', slug: 'alpha' }] } : api(m, path);
  await assert.rejects(downloadHandsCandidate({ ...options, api: noChannel, dir: join(f.dir, 'no-channel') }), /Hands channel 'candidate' resolved 0 times/);
});

test('promotion follows Hands\' one signed redirect into its own R2 and refuses any other redirect target', async t => {
  const { downloadHandsCandidate } = await import('./download-hands-candidate.mjs');
  const f = await fixture();
  const v = await loadHostedArtifacts(f.options);
  const rows = v.assets.map(a => ({ ...a, file_hash: a.sha256, r2_key: a.sha256, metadata_json: JSON.stringify({ file_name: a.file }) }));
  const api = async (_, path) => {
    if (path === '/api/apps') return { apps: [{ id: 'app', slug: 'raft-computer-cli' }] };
    if (path.endsWith('/channels')) return { channels: [{ id: 'candidate', slug: 'candidate' }] };
    if (path.includes('/releases?')) return { releases: [{ id: 'fixed', build_id: 'build', version_name: v.version, status: 'active' }] };
    if (path.endsWith('/assets')) return { assets: rows };
    return { id: 'build', artifact_mode: 'hands_r2', version_name: v.version, provenance_json: { source_commit: 'a'.repeat(40) } };
  };
  const storage = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
  // Shaped like production Hands + Node fetch: /dl answers 302 into R2, and
  // a fetch with redirect: 'error' on a 302 throws a bare "fetch failed".
  const handsFetch = (redirectTo) => async (url, init = {}) => {
    if (url.hostname === 'hands.build') {
      if (init.redirect === 'error') throw new TypeError('fetch failed');
      const target = url.pathname.split('/').at(-1);
      return new Response(null, { status: 302, headers: { location: `${redirectTo}/hands-artifacts/apps/app/${target}${url.search}` } });
    }
    assert.equal(init.redirect, 'error', 'the storage hop must not follow further redirects');
    const name = url.pathname.split('/').at(-1);
    const target = name.replace(/\.gz$/, '');
    const variant = url.searchParams.get('kind') ?? (name.endsWith('.gz') ? 'gzip' : null);
    const row = rows.find(r => r.target === target && r.variant === variant);
    return new Response(f.bytes.get(row.file));
  };
  const options = { api, apiBase: 'https://hands.build', appSlug: 'raft-computer-cli', version: v.version, sourceCommit: 'a'.repeat(40), dir: join(f.dir, 'redirected'), fetchImpl: handsFetch(storage) };
  const downloaded = await downloadHandsCandidate(options);
  const checked = await loadHostedArtifacts(downloaded);
  assert.deepEqual(checked.files.map(({ file, sha256 }) => [file, sha256]).sort(), v.files.map(({ file, sha256 }) => [file, sha256]).sort());
  await assert.rejects(downloadHandsCandidate({ ...options, dir: join(f.dir, 'cdn'), fetchImpl: handsFetch('https://cdn.raft.build') }), /outside Hands storage/);
  await assert.rejects(downloadHandsCandidate({ ...options, dir: join(f.dir, 'plain'), fetchImpl: handsFetch(storage.replace('https:', 'http:')) }), /outside Hands storage/);
});

test('direct upload streams exact bytes without API bearer and never completes a failed PUT', async t => {
  const { uploadAsset, activateRelease } = await import('./hands-hosted-transport.mjs');
  const f = await fixture(), verified = await loadHostedArtifacts(f.options), asset = verified.assets[0];
  let completed = 0, putCount = 0;
  const declarations = [];
  const api = async (_, path, body) => {
    if (path.endsWith('/uploads')) {
      declarations.push(body);
      return { asset_id: 'asset', state: 'pending', upload: { method: 'PUT', url: 'https://objects.example.invalid/staging/key?signature=capability', headers: { 'content-type': 'application/octet-stream' } }, complete_url: 'https://hands.build/api/apps/app/builds/build/assets/asset/upload/complete' };
    }
    assert.equal(path, '/api/apps/app/builds/build/assets/asset/upload/complete'); completed++;
    return { state: 'ready' };
  };
  const fetchImpl = async (_, request) => {
    putCount++; assert.equal(request.method, 'PUT'); assert.equal(request.redirect, 'error'); assert.equal(request.headers.authorization, undefined);
    const chunks = []; for await (const chunk of request.body) chunks.push(chunk);
    assert.equal(sha(Buffer.concat(chunks)), asset.sha256);
    assert.equal(request.headers['content-length'], String(asset.size_bytes));
    return new Response(null, { status: 200 });
  };
  const options = { api, appId: 'app', buildId: 'build', asset, fetchImpl };
  await uploadAsset(options);
  assert.equal(completed, 1); assert.equal(putCount, 1);
  await assert.rejects(uploadAsset({ ...options, fetchImpl: async () => new Response(null, { status: 503 }) }), /HTTP 503/);
  assert.equal(completed, 1); assert.equal(declarations[0].idempotency_key, declarations[1].idempotency_key);
  await assert.rejects(activateRelease({ api: async () => ({ status: 'pending', artifact_mode: 'hands_r2', asset_ingest_protocol_version: 1 }), appId: 'app', buildId: 'build', channelId: 'alpha', version: '1.0.37' }), /succeeded verified-slot/);
});

test('backfill retains published identity and cannot switch external reads after incomplete or unverified upload', async t => {
  const { backfillHosted } = await import('./backfill-hands-hosted.mjs');
  const f = await fixture();
  const build = { id: 'original', source: 'external-import', version_name: f.manifest.version, version_code: 1000037, artifact_mode: 'external', status: 'succeeded', provenance_json: '{"original":true}' };
  const expected = { ...build }; delete expected.id; delete expected.provenance_json;
  const rows = []; let finish = 0, fail = true;
  const api = async (method, path) => {
    if (path.endsWith('/assets')) return { assets: rows };
    if (path.endsWith('/hosted-migration')) { assert.equal(build.artifact_mode, 'external'); return { state: 'uploading' }; }
    if (path.endsWith('/complete')) { finish++; build.artifact_mode = 'hands_r2'; return { state: 'hosted' }; }
    return { ...build };
  };
  const options = { ...f.options, api, appId: 'app', buildId: 'original', expected, releaseIds: ['existing-release'], apiBase: 'https://hands.build', appSlug: 'raft-computer-cli',
    uploadAsset: async ({ asset }) => {
      if (rows.some(r => r.path === asset.path && r.variant === asset.variant && r.target === asset.target)) return;
      if (rows.length === 2 && fail) throw new Error('interrupted');
      rows.push({ ...asset, id: String(rows.length), file_hash: asset.sha256, r2_key: asset.sha256, ingest_state: 'ready', committed_final_key: asset.sha256, verified_sha256: asset.sha256, verified_size_bytes: asset.size_bytes });
    }, publicFetch: async url => {
      assert.ok(url.pathname.includes('/existing-release/'));
      const variant = url.searchParams.get('kind') ?? (url.pathname.endsWith('.gz') ? 'gzip' : null);
      const target = url.pathname.split('/').at(-1).replace(/\.gz$/, '');
      return new Response(f.bytes.get(rows.find(r => r.variant === variant && r.target === target).file));
    } };
  await assert.rejects(backfillHosted(options), /interrupted/);
  assert.equal(finish, 0); assert.equal(build.artifact_mode, 'external');
  fail = false;
  await backfillHosted(options);
  assert.equal(finish, 1); assert.equal(build.id, 'original');
  rows[0].ingest_state = 'pending';
  await assert.rejects(backfillHosted(options), /not verified ready/);
  assert.equal(finish, 1);
});


test('nested manifest signing evidence must exist and match its declared bytes', async t => {
  const f = await fixture();
  const evidence = Buffer.from('notarization proof');
  f.manifest.targets['darwin-arm64'].apple = { notarization: { receipt: { file: 'receipt.json', sha256: sha(evidence), size: evidence.length } } };
  await writeFile(f.options.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(loadHostedArtifacts(f.options), /ENOENT/);
  await writeFile(join(f.dir, 'receipt.json'), Buffer.from('wrong proof'));
  await assert.rejects(loadHostedArtifacts(f.options), /identity mismatch/);
  await writeFile(join(f.dir, 'receipt.json'), evidence);
  const loaded = await loadHostedArtifacts(f.options);
  assert.equal(loaded.assets.find(a => a.file === 'receipt.json').sha256, sha(evidence));
});

test('backfill command defaults to read-only and checks the original release before any mutation', async t => {
  const { runBackfillCommand } = await import('./backfill-hands-hosted.mjs');
  const f = await fixture();
  const expected = { source: 'external', version_name: f.manifest.version, version_code: 1000037, artifact_mode: 'external', status: 'succeeded' };
  await writeFile(join(f.dir, 'expected.json'), JSON.stringify(expected));
  await writeFile(join(f.dir, 'ids.json'), JSON.stringify(['release']));
  // Control files live outside the final artifact directory in a real run.
  const calls = [];
  const api = async (method, path) => { calls.push(method); return path.includes('/releases/') ? { build_id: 'build', status: 'active' } : { id: 'build', ...expected }; };
  const argv = ['--app-id', 'app', '--app', 'raft-computer-cli', '--build-id', 'build', '--expected', join(f.dir, 'expected.json'), '--release-ids', join(f.dir, 'ids.json'), '--manifest', f.options.manifestPath, '--artifact-dir', f.dir, '--output', join(f.dir, 'plan.json')];
  await runBackfillCommand(argv, { api });
  assert.deepEqual(calls, ['GET', 'GET']);
  await assert.rejects(runBackfillCommand(argv, { api: async (method, path) => path.includes('/releases/') ? { build_id: 'other', status: 'active' } : { id: 'build', ...expected } }), /release is not/);
});
