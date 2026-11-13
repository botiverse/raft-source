// The module's spans (Tracing V2, platform/tracing): timing and outcome of
// the work worth seeing in a request's trace. Names and attributes:
//
// - `server.artifacts.publish` (agent API publish): `operation` (create |
//   version), `files_bucket`, `inline_bytes_bucket`, `delete_bucket`; at the
//   end `outcome` (published | replayed | unchanged | missing, or the error
//   code), `status_code`, `kind` of what was published, and `check` (the
//   publish check of the version it answers: pending | skipped when just
//   recorded, a replay's as it is now, any status; none);
// - `server.artifacts.check.record` (inside the push's transaction, its
//   savepoint, checks.ts recordVersionCheck): `outcome` (pending | skipped |
//   none); a failure ends it as an error with `error_class`, and the push
//   goes on without a check;
// - `server.artifacts.frame.issue` (a frame's ticket, signed here; in the
//   frame route's request or the viewer's): `kind`; `outcome` (issued |
//   not_configured | failed: signing threw); ok for issued, and for
//   not_configured in local development (frameIssueStatus: a deployment
//   without a usable configuration is misconfigured, a failed signature our
//   bug);
// - `server.artifacts.import` (agent and web import): `via` (agent | web);
//   `outcome` (created | existing, or the error code), `status_code`; inside
//   it `server.artifacts.import.manifest` (`outcome` found | not_found,
//   `files_bucket`, `bytes_bucket`), `.blobs` (`files_bucket` fetched,
//   `bytes_bucket` fetched) and `.commit` (`created`); a thrown refusal ends
//   a step with its `code`;
// - `server.artifacts.content.authorize` (the content Worker's authorize):
//   `outcome` (allow, the denial code, or invalid_body).
// - `server.artifacts.check.lease` (the check Worker's lease, checkTask.ts):
//   `outcome` (leased | none | not_configured | failed);
// - `server.artifacts.check.result` (the check Worker's result): `load`
//   (ok | timeout | error); `outcome` (done | failed | not_found | conflict |
//   invalid | unavailable); for a check it finished (done | failed), also
//   `kind` of the version and the check's own time, apart from the span's
//   `duration_ms` (the result request alone): `check_ms`, whole milliseconds
//   from the check's row being recorded (`created_at`, the push) to its
//   finish (`finished_at`), waiting included, and `run_ms`, whole
//   milliseconds from the lease this result holds being taken to the finish
//   (the last attempt's, when a lost lease was leased again). Where the
//   Worker's report says where that run's time went (shared
//   ArtifactCheckTiming; a Worker older than it says nothing), one attribute a
//   stage, whole milliseconds: `browser_ms` (getting a browser), `prepare_ms`
//   (its context and page), `load_ms` (the navigation to `load`), `settle_ms`
//   (from `load` to the first shot: the idle network, the shell's word, the
//   pause) and `shots_ms` (every viewport's shot, with a change of viewport's
//   waits). What is left of `run_ms` is the browser's release and the upload.
//
// Core's `server.objects.summaries` (routes/objects.ts) covers the message
// cards' summaries. Never a title, name, path, link, id or content.
import type { TraceAttributes } from "@botiverse/raft-shared";

/** The end attributes of an operation's answer: its error code and status, or `ok` for one that answered JSON. */
export function answerAttrs(result: { kind: string; status?: number; body?: unknown }): TraceAttributes {
  if (result.kind === "error") {
    const code = (result.body as { code?: unknown } | undefined)?.code;
    return { outcome: typeof code === "string" ? code : "error", status_code: result.status ?? 500 };
  }
  return { outcome: "ok", status_code: result.status ?? 200 };
}

/** A failure the server answered (5xx) is an error span; a refusal (4xx) is not. */
export function answerStatus(result: { kind: string; status?: number }): "ok" | "error" {
  return result.kind === "error" && (result.status ?? 500) >= 500 ? "error" : "ok";
}
