import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { ensureActiveRelease, transportCauseSuffix } from './publish-hands-release.mjs';

/** Direct PUT attempts per asset: the first and two retries (Hands has no multipart upload). */
export const DIRECT_UPLOAD_ATTEMPTS = 3;
/** One PUT's time limit; a stuck stream gives way to a retry with a fresh link. */
export const DIRECT_UPLOAD_ATTEMPT_TIMEOUT_MS = 600_000;
const DIRECT_UPLOAD_BACKOFF_MS = [10_000, 30_000];

/**
 * Uploads one asset. A failed direct PUT that may pass on another try — a
 * transport failure or timeout, HTTP 408/429/5xx, or 403 (the link rejected:
 * expired or invalid) — retries this asset only, after a backoff, and each
 * retry asks Hands for the upload again so it gets a fresh link. Any other
 * failure, and the last attempt's, is thrown.
 */
export async function uploadAsset(input) {
  const sleep = input.recovery?.sleep ?? sleepFor;
  const log = input.log ?? ((line) => process.stderr.write(`${line}\n`));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await uploadAssetOnce(input);
    } catch (error) {
      if (!error.directUploadRetry || attempt >= DIRECT_UPLOAD_ATTEMPTS) throw error;
      const waitMs = DIRECT_UPLOAD_BACKOFF_MS[attempt - 1] ?? DIRECT_UPLOAD_BACKOFF_MS.at(-1);
      log(`Hands direct upload attempt ${attempt}/${DIRECT_UPLOAD_ATTEMPTS} failed (${error.directUploadRetry}), retrying ${input.asset.file} with a fresh link in ${waitMs / 1000} s: ${error.message}`);
      await sleep(waitMs);
    }
  }
}

/** Why a failed direct PUT may pass on another try, or null when it will not. */
export function directUploadRetryReason(status) {
  if (status === 403) return 'link_rejected';
  if (status === 408 || status === 429 || status >= 500) return `http_${status}`;
  return null;
}

async function uploadAssetOnce({ api, apiBase = 'https://hands.build', appId, buildId, asset, fetchImpl = fetch, recovery = {} }) {
  const slot = { artifact_kind: asset.artifact_kind, platform: asset.platform, arch: asset.arch, variant: asset.variant, filetype: asset.filetype };
  const idempotency = createHash('sha256').update(JSON.stringify([buildId, slot, asset.sha256, asset.size_bytes])).digest('hex');
  const response = await api('POST', `/api/apps/${appId}/builds/${buildId}/assets/uploads`, {
    ...slot, idempotency_key: idempotency, sha256: asset.sha256, size_bytes: asset.size_bytes,
    filename: asset.file, content_type: 'application/octet-stream', metadata_json: { file_name: asset.file },
  });
  if (response.state === 'ready') return;
  const expectedComplete = `/api/apps/${appId}/builds/${buildId}/assets/${response.asset_id}/upload/complete`;
  const completion = { api, appId, buildId, assetId: response.asset_id, path: expectedComplete, status: response, ...recovery };
  // An earlier completion holds the verification lease: the bytes are
  // already uploaded, so finish that verification instead of uploading again.
  if (response.state === 'verifying' && response.asset_id && response.upload == null) {
    await completeUpload(completion);
    return;
  }
  if (!response.asset_id || response.upload?.method !== 'PUT') throw new Error('Hands did not provide an asset upload capability');
  const url = new URL(response.upload.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('invalid Hands upload capability');
  // The response never authorizes forwarding our API bearer outside /api.
  const complete = new URL(response.complete_url, apiBase);
  if (complete.origin !== new URL(apiBase).origin || complete.pathname !== expectedComplete || complete.search || complete.hash) throw new Error('upload completion escaped its app/build/asset');
  const body = createReadStream(asset.path);
  const startedAt = Date.now();
  try {
    let uploaded;
    try {
      uploaded = await fetchImpl(url, {
        method: 'PUT', redirect: 'error', duplex: 'half',
        headers: { ...response.upload.headers, 'content-length': String(asset.size_bytes) },
        body, signal: AbortSignal.timeout(DIRECT_UPLOAD_ATTEMPT_TIMEOUT_MS),
      });
    } catch (error) {
      // Host and path only: the upload capability's query string is a signature.
      throw Object.assign(
        new Error(`Hands direct upload transport failed: ${asset.file} (${asset.size_bytes} bytes) -> ${url.host}${url.pathname} after ${Date.now() - startedAt} ms${transportCauseSuffix(error)}`),
        { directUploadRetry: error?.name === 'TimeoutError' ? 'timeout' : 'transport' },
      );
    }
    if (!uploaded.ok) {
      const retry = directUploadRetryReason(uploaded.status);
      const what = uploaded.status === 403 ? 'upload link rejected (expired or invalid)' : 'failed';
      throw Object.assign(
        new Error(`Hands direct upload ${what}: HTTP ${uploaded.status}: ${asset.file} (${asset.size_bytes} bytes) -> ${url.host}${url.pathname}${await directUploadFailureDetail(uploaded, startedAt)}`),
        retry ? { directUploadRetry: retry } : {},
      );
    }
    await uploaded.body?.cancel();
  } finally {
    // destroy() defers to a pending open; wait so the file is released (and a
    // late open error is observed) before the caller can remove it.
    body.destroy();
    if (!body.closed) await once(body, 'close').catch(() => {});
  }
  await completeUpload({ ...completion, status: {} });
  // Completion's server-side streamed SHA/size check, and a subsequent fresh
  // asset listing, are the proof. A successful PUT alone is never publication.
}

const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Completes an uploaded asset, riding out another holder's verification
 * lease (409 ASSET_UPLOAD_BUSY) and a completion that outlives our request
 * timeout. Lease/expiry fields are used when Hands sends them; without them
 * we back off under a total budget and never read a missing field as an
 * expired lease. Never re-uploads. */
export async function completeUpload({ api, appId, buildId, assetId, path, status = {}, budgetMs = 45 * 60_000, now = Date.now, sleep = sleepFor }) {
  const statusPath = `/api/apps/${appId}/builds/${buildId}/assets/${assetId}/upload`;
  let deadline = now() + budgetMs;
  let backoff = 15_000;
  let last = 'none';
  const note = s => { if (Number.isFinite(s?.upload_expires_at)) deadline = Math.min(deadline, s.upload_expires_at); };
  const waitFor = (s, retryAfter) => {
    const lease = Number(s?.verifier_lease_expires_at);
    const hinted = Number(retryAfter) * 1000;
    const ms = Number.isFinite(lease) && lease > now() ? lease - now() + 1_000
      : Number.isFinite(hinted) && hinted > 0 ? hinted
      : backoff;
    backoff = Math.min(backoff * 2, 120_000);
    return Math.max(1_000, ms);
  };
  note(status);
  let wait = status.state === 'verifying' && status.can_retry_complete !== true ? waitFor(status) : 0;
  for (;;) {
    if (wait) {
      if (now() + wait > deadline) throw new Error(`Hands upload completion for asset ${assetId} did not finish before its deadline (last: ${last})`);
      await sleep(wait);
    }
    try {
      await api('POST', path, {});
      return;
    } catch (error) {
      if (error.status === 409 && error.payload?.code === 'ASSET_UPLOAD_BUSY') {
        last = 'ASSET_UPLOAD_BUSY';
        note(error.payload);
        wait = waitFor(error.payload, error.retryAfter);
        continue;
      }
      if (!error.transport) throw error;
      last = error.message;
      // The completion may still finish server-side: read state before retrying.
      let current = null;
      try { current = await api('GET', statusPath); } catch (lookup) { if (lookup.status !== 404 && !lookup.transport) throw lookup; }
      if (current?.state === 'ready') return;
      note(current);
      wait = current?.can_retry_complete === true ? 1_000 : waitFor(current);
    }
  }
}

export async function activateRelease({ api, appId, buildId, channelId, version }) {
  const build = await api('GET', `/api/apps/${appId}/builds/${buildId}`);
  if (build.status !== 'succeeded' || build.artifact_mode !== 'hands_r2' || Number(build.asset_ingest_protocol_version) !== 1) {
    throw new Error('Hands activation requires a succeeded verified-slot protocol build');
  }
  const result = await ensureActiveRelease(api, { appId, buildId, channelId, version, requiredExternalTargets: null });
  return { id: result.releaseId, revision: result.revision };
}

// Request ids the storage edge returns, so its owner can find the failure in
// its own logs. Header values are ids, never credentials.
const DIRECT_UPLOAD_REQUEST_ID_HEADERS = ['cf-ray', 'x-amz-request-id', 'x-amz-id-2', 'x-request-id', 'server'];

/**
 * After a failed direct PUT: elapsed time, the edge's request ids and the
 * start of the response body. The body is an error document from the storage
 * service; signature material it may echo (a canonical request, a string to
 * sign, X-Amz-* query values) is cut out, and it is capped.
 */
export async function directUploadFailureDetail(response, startedAt, now = Date.now()) {
  const ids = DIRECT_UPLOAD_REQUEST_ID_HEADERS
    .map((name) => [name, response.headers?.get?.(name)])
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${String(value).slice(0, 120)}`);
  let text = '';
  try { text = await response.text(); } catch { text = ''; }
  const cleaned = text
    .replace(/<(StringToSign|StringToSignBytes|CanonicalRequest|CanonicalRequestBytes|SignatureProvided)>[\s\S]*?<\/\1>/gi, '<$1>[redacted]</$1>')
    .replace(/X-Amz-[A-Za-z-]+=[^&\s<"']*/g, (match) => `${match.split('=')[0]}=[redacted]`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  return `; after ${Math.max(0, now - startedAt)} ms${ids.length ? `; ${ids.join(' ')}` : ''}${cleaned ? `; body: ${cleaned}` : ''}`;
}
