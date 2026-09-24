# Slock Trace Upload Service

Daemon trace bundle upload service. It can run as the existing Cloudflare
Worker or as a Node service. The active staging, play, and production data
planes run on AWS: daemon uploads hit the ECS service, raw bundles/ledgers are
written to R2 through the S3-compatible API, and OTLP ingest goes over private
Cloud Map DNS to Telescope. Slock server remains control plane only; it signs
upload attestations and does not relay trace payloads.

Contract:
- `POST /api/trace-bundles` accepts a server-signed `daemon-trace-bundle:create` attestation.
- The service trusts `uploadId`, `objectKey`, `bundleSha256`, `bundleSizeBytes`, and `maxBytes` only from signed attestation metadata.
- The service trusts `deploymentEnvironment` only from signed attestation metadata when present. The signing side should derive this from the daemon's configured server URL / server deployment (`staging` server URL -> `staging`, production server URL -> `production`) instead of relying on the service's own deployment environment.
- The service returns a short-lived `PUT` URL under the same upload endpoint.
- The `PUT` path verifies the upload token, bundle size, and SHA-256 before writing to R2.
- If `TRACE_INGEST_OTLP_ENDPOINT` is configured, the service schedules a best-effort background ingest after a successful R2 write: it reads the just-written bundle back from R2, validates daemon trace JSONL `schema_version: 1`, converts spans to OTLP/HTTP JSON, and posts to ScopeDB/Telescope. Ingest failure does not fail upload; R2 remains the raw replay source.
- The same service writes a lightweight ledger JSON under `trace-ledgers/<serverId>/<machineId>/<uploadId>.json` so staging/prod can reconcile `r2_status` and `scopedb_status` without a second Worker or queue.
- Ingest is at-least-once, not exactly-once. Replays/retries may append duplicate raw OTLP rows, so every imported daemon span includes `slock.trace_ingest.span_key = serverId:machineId:bundleSha256:trace_id:span_id`. ScopeDB/Telescope analysis and future materialized views must dedupe on that key. `uploadId` remains an attempt/session diagnostic field, not span identity.
- With `RAFT_TRACE_SCOPEDB_PROJECTOR=on`, the authenticated collector also projects each accepted web/daemon span into the typed Trace V2 table after the canonical OTLP write. It emits one `event` row per event and one `span_fact` row per completed span through the shared closed-schema helpers. This is a reversible shadow: V2 failure is reported in the web response or daemon ledger but never fails a successful OTLP write. Record validation is isolated per span, so one malformed span cannot erase valid siblings; partial projection remains fail-visible through projected/skipped counts plus the fixed `TraceProjectionRecordValidationError` reason class. If OTLP is disabled, V2 refuses to run so the projector cannot silently become a B-only trace path.
- V2 uses committed one-shot ScopeDB SDK writes at the request/R2 batch boundary. It has no process-local durability and remains decision-support data. Unknown attrs are ignored; only the shared promoted allowlist and explicit camelCase identity aliases reach typed columns. `machine_id` is correlation identity, not `service_instance_id`.

Cloudflare Worker required bindings/secrets:
- R2 binding: `TRACE_BUNDLES`
- Secret: `SCOPE_ATTESTATION_SECRET` (must match the Slock server signer)
- Optional secret: `TRACE_UPLOAD_WORKER_SECRET` (defaults to `SCOPE_ATTESTATION_SECRET`)
- Optional var: `TRACE_UPLOAD_MAX_BYTES` (defaults to 50MB)
- Optional var: `TRACE_INGEST_OTLP_ENDPOINT` (enables R2 -> ScopeDB/Telescope ingest; `/v1/traces` is appended when omitted)
- Optional var: `TRACE_INGEST_OTLP_AUTHORIZATION` (Authorization header for the OTLP endpoint)
- Optional var: `TRACE_INGEST_SERVICE_NAME` (defaults to `slock-daemon`)
- Optional var: `TRACE_INGEST_BATCH_SIZE` (defaults to 128 spans/request)
- Optional var: `TRACE_INGEST_MAX_DECOMPRESSED_BYTES` (defaults to 100MB)
- Optional var: `DEPLOYMENT_ENV` (fallback only when signed attestation metadata omits `deploymentEnvironment`)
- Optional var: `RAFT_TRACE_SCOPEDB_PROJECTOR` (`on` enables the typed V2 shadow; unset/`off` skips it)
- V2 secret: `SCOPEDB_TRACE_EVENTS_WRITE_KEY` (required when the projector is `on`)
- V2 var: `SCOPEDB_TRACE_EVENTS_ENDPOINT` (required when the projector is `on`; the 59-column statement is generated from the shared typed row registry)

Node service required secrets/vars:
- Secret: `SCOPE_ATTESTATION_SECRET` (must match the Slock server signer)
- Secret: `R2_ACCESS_KEY_ID`
- Secret: `R2_SECRET_ACCESS_KEY`
- Var: `R2_ENDPOINT` (Cloudflare R2 S3 endpoint, for example `https://<account-id>.r2.cloudflarestorage.com`)
- Var: `R2_BUCKET` (staging/prod bucket name)
- Var: `TRACE_INGEST_OTLP_ENDPOINT` (AWS staging points to `http://telescope.raft-staging.local:4318/v1/traces`)
- Optional secret: `TRACE_UPLOAD_WORKER_SECRET` (defaults to `SCOPE_ATTESTATION_SECRET`)
- Optional var: `R2_REGION` (defaults to `auto`)
- Optional var: `TRACE_UPLOAD_MAX_BYTES` (defaults to 50MB)
- Optional var: `TRACE_INGEST_OTLP_AUTHORIZATION` (Authorization header for the OTLP endpoint)
- Optional var: `TRACE_INGEST_SERVICE_NAME` (defaults to `slock-daemon`)
- Optional var: `TRACE_INGEST_BATCH_SIZE` (defaults to 128 spans/request)
- Optional var: `TRACE_INGEST_MAX_DECOMPRESSED_BYTES` (defaults to 100MB)
- Optional var: `DEPLOYMENT_ENV` (fallback only when signed attestation metadata omits `deploymentEnvironment`)
- Optional var: `RAFT_TRACE_SCOPEDB_PROJECTOR` (`on` enables the typed V2 shadow; unset/`off` skips it)
- V2 secret: `SCOPEDB_TRACE_EVENTS_WRITE_KEY` (required when the projector is `on`)
- V2 var: `SCOPEDB_TRACE_EVENTS_ENDPOINT` (required when the projector is `on`; the statement is code-owned)

Daemon upload client:
- Enable with `SLOCK_DAEMON_TRACE_UPLOAD_URL=<trace-upload-service-url>`.
- The daemon uploads only closed local JSONL trace files from `~/.slock/machines/<machine>/traces`; it skips the currently open file and marks successfully uploaded files with a local sidecar under `trace-uploads/`.
- Optional daemon vars: `SLOCK_DAEMON_TRACE_UPLOAD_INTERVAL_MS` (default 5 minutes) and `SLOCK_DAEMON_TRACE_UPLOAD_MIN_FILE_AGE_MS` (default 60 seconds).
