/**
 * Activity panel — raw endpoint/socket JSON → generated validator → sync core.
 *
 * This is the ONLY place a server Activity payload becomes core input. It does
 * no merging: ordering, row merge, tombstone retention and version monotonicity
 * all live in `foldActivityEvent` / the core, shared byte-for-byte with KMP.
 *
 * Three things here were learned the hard way and are not stylistic:
 *
 * 1. A snapshot is NOT a domain event. `foldActivityEvent` handles only `frame`
 *    and `readStateUpdated`; a `{type:"snapshot"}` object handed to it falls
 *    through `default:` and returns state untouched. Snapshots must go through
 *    `core.ingestSnapshot`, which routes them to the domain's `fromSnapshot`.
 *    An earlier attempt at this seam fed snapshots to the fold and produced a
 *    permanently empty panel with a fully green test suite.
 *
 * 2. Every uint64 on this wire is a canonical decimal STRING and must become a
 *    bigint via `BigInt(...)`. `Number(...)` silently truncates past 2^53, and
 *    the server deliberately returns 200 for a payload whose numbers were
 *    already ruined — precision here is defended by the consumer, i.e. by this
 *    file actually running the validator.
 *
 * 3. **Window facts are preserved, not reset, when absent.**
 *    `acceptedActivityFrameWindowFact` only copies fields that are PRESENT and
 *    well-typed; anything missing keeps its previous value. So dropping
 *    `totalUnreadCount` from a difference translation does not zero the badge —
 *    it freezes the badge at its old value forever, with correct rows and no
 *    error. `DifferenceIngress` *requires* all five, so all five must be
 *    forwarded. `FrameIngress` carries none of them, and there preservation is
 *    the correct semantic: a live frame is a delta, not a new window.
 *
 * That asymmetry is why the field list below is a single shared constant rather
 * than an inline object literal per call site: the difference translator and
 * its coverage test read the SAME list, so a sixth window fact added to the
 * contract cannot be silently forgotten here.
 */

import Ajv from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import {
  encodeActivityScopeId,
} from "@botiverse/raft-sync-core";
import type {
  ActivityContractRow,
  SyncDifferenceResponse,
  SyncFrame,
  SyncSnapshot,
} from "@botiverse/raft-sync-core";
import schemaBundle from
  "@botiverse/raft-sync-core/contracts/activity-v1/generated/json-schema/activity-sync.schema.json" with { type: "json" };

export class ActivityIngressError extends Error {
  readonly detail: string;
  constructor(message: string, detail = "") {
    super(detail ? `${message}: ${detail}` : message);
    this.name = "ActivityIngressError";
    this.detail = detail;
  }
}

/**
 * A contract-legal `ActivityIngress` member that this seam deliberately does
 * not fold (today: `commandReceipt` / `commandRejected`).
 *
 * Distinct from `ActivityIngressError`, which means the payload was malformed.
 * This one means the payload was WELL-FORMED and is simply not Activity window
 * state — so the caller can route it without treating it as a wire error.
 */
export class UnsupportedActivityIngressKind extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(`activity ingress kind is not folded here: ${kind}`);
    this.name = "UnsupportedActivityIngressKind";
    this.kind = kind;
  }
}

/**
 * Server says the client's cursor is unusable and it must re-snapshot.
 *
 * The error carries the validated scope/epoch/watermark **because the consumer
 * cannot reach the core's bookkeeping without them**. `core.ingestDifference`
 * runs `clearScopeRequests` + `requestSnapshot` + `repairPending = true` when
 * `snapshotRequired` is set, and that call needs a scopeId and epoch. A bare
 * error forced the caller to either invent them or refetch on its own — the
 * exact UI-level bypass @赵梓淇 / @HanXin ruled unacceptable. Carrying them here
 * is what makes routing back into the core possible at all.
 */
export class SnapshotRequiredError extends Error {
  readonly scopeId: string;
  readonly epoch: string;
  readonly watermark: bigint;
  /**
   * `SnapshotRequiredBody` requires a `requestId` and it must survive onto the
   * error. Dropping it here left the 409 path with nothing to correlate against,
   * so an unsolicited or superseded 409 could clear a newer outstanding repair
   * and queue a snapshot. (@赵梓淇 P1.)
   */
  readonly requestId: string;
  constructor(detail: {
    scopeId: string;
    epoch: string;
    watermark: bigint;
    requestId: string;
  }) {
    super("server requires a fresh snapshot");
    this.name = "SnapshotRequiredError";
    this.scopeId = detail.scopeId;
    this.epoch = detail.epoch;
    this.watermark = detail.watermark;
    this.requestId = detail.requestId;
  }
}

/**
 * The window facts a `DifferenceIngress` carries and the fold accepts.
 *
 * Single source for the translator AND its coverage test. Do not inline these
 * names at a call site — see the header note on preservation-vs-reset.
 */
export const ACTIVITY_WINDOW_FACTS = [
  "nextCursor",
  "hasMore",
  "complete",
  "totalCount",
  "totalUnreadCount",
] as const;

// ── generated-schema validation ────────────────────────────────────────────
// The validators are compiled from the SAME bundle the Kotlin/TS bindings are
// generated from. Hand-writing shape checks here would be a second contract.

// The WHOLE bundle is registered once, then looked up by `$id`. Extracting a
// single sub-schema and compiling it standalone does not work and is not a
// style preference: every member of this bundle `$ref`s siblings
// (`OpaqueId.json`, `ActivityScope.json`, `UInt64String.json`, …), so a
// detached fragment throws MissingRefError on the first real payload — i.e. the
// "fail-closed validator" fails closed on *everything*. The bundle is also
// draft 2020-12, which the default Ajv export cannot load.
// Same construction as `contracts/activity-v1/tools/verify-contract.mjs`.
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(schemaBundle as object, "activity-sync.schema.json");

function validatorFor(schemaId: string): ValidateFunction {
  const compiled = ajv.getSchema(schemaId);
  if (!compiled) throw new ActivityIngressError(`generated bundle has no schema ${schemaId}`);
  return compiled;
}

function validate(schemaId: string, raw: unknown): Record<string, unknown> {
  const check = validatorFor(schemaId);
  if (!check(raw)) {
    throw new ActivityIngressError(
      `payload does not satisfy ${schemaId}`,
      (check.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; "),
    );
  }
  return raw as Record<string, unknown>;
}

/**
 * The generated closed set of visible Activity rows.
 *
 * This is the CANONICAL generated `ActivityRow` union, aliased — never a
 * hand-rebuilt list of its members. Re-listing the three arms here looked
 * equivalent and was not: adding a fourth arm to the contract would leave this
 * alias stale, the same AJV would accept the new row, `narrowActivityRow` would
 * assert it into the old three-state, and the projection would read fields that
 * do not exist. The previous round narrowed that hole from field names to union
 * members; aliasing the canonical type closes it. (@赵梓淇 P1.)
 *
 * Exported from HERE, next to the one compiled validator, so there is exactly
 * one Ajv instance and one `ActivityRow.json` entry point in the app.
 */
export type NarrowedActivityRow = ActivityContractRow;

/**
 * Narrow one raw row through the SAME compiled `ActivityRow.json` validator the
 * ingress path uses, returning the GENERATED union rather than a bag of
 * unknowns.
 *
 * Returning the union is the load-bearing part. Handing back
 * `Record<string, unknown>` would leave every field access an unchecked cast:
 * when the generated schema later changes a field or an enum, Ajv would accept
 * the new contract while the stale accesses still typecheck and quietly project
 * `undefined` into a user-visible row. With the union, that same change is a
 * compile error. (@赵梓淇 P1.)
 *
 * Returns null instead of throwing: one unrepresentable row must degrade its
 * whole window, not blow up a render.
 */
export function narrowActivityRow(raw: unknown): NarrowedActivityRow | null {
  const check = validatorFor("ActivityRow.json");
  return check(raw) ? (raw as NarrowedActivityRow) : null;
}

/**
 * Canonical decimal string → bigint.
 *
 * The schema already pins the `^(0|[1-9][0-9]*)$` shape, so this is the second
 * gate rather than the first — but it stays because a bigint conversion is
 * exactly where a `Number()` would otherwise creep in.
 */
function exactUint64(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ActivityIngressError(
      `${field} must be a canonical uint64 decimal string`,
      JSON.stringify(value),
    );
  }
  return BigInt(value);
}

type Scope = Parameters<typeof encodeActivityScopeId>[0];

/**
 * Epoch passes through as the canonical STRING, deliberately.
 *
 * `SyncEpoch` is an opaque equality token — the core only ever asks "same epoch
 * or not", never "which is larger". `SyncSeq` is the ordered one and is a
 * bigint. Converting epoch to bigint typechecks nowhere and, worse, invites a
 * future ordering comparison on a value whose ordering carries no meaning.
 * The schema already pins it to `UInt64String`, so shape is enforced upstream.
 */
function epochOf(body: Record<string, unknown>): string {
  const epoch = body.epoch;
  if (typeof epoch !== "string") {
    throw new ActivityIngressError("epoch must be a string", JSON.stringify(epoch));
  }
  return epoch;
}


// ── snapshot ───────────────────────────────────────────────────────────────

/**
 * `GET /activity/snapshot` body → `core.ingestSnapshot` input.
 *
 * `window` becomes `state`; the domain's `fromSnapshot` decodes it. We do not
 * pre-digest it here — that would be a second decoder.
 *
 * `activityVersion` is lifted to sit ALONGSIDE the window because
 * `stateFromSnapshot` reads it from the outer object (`source.activityVersion`)
 * while reading rows from the inner window. Passing the bare window would let
 * the snapshot's version silently fold to `null`.
 */
export function snapshotFromResponse(raw: unknown): SyncSnapshot<unknown> & { requestId: string } {
  const body = validate("SnapshotIngress.json", raw);
  return {
    requestId: requestIdOf(body),
    scopeId: encodeActivityScopeId(body.scope as Scope),
    watermark: exactUint64(body.watermark, "watermark"),
    epoch: epochOf(body),
    state: {
      window: body.window,
      activityVersion: body.activityVersion,
    },
  };
}

// ── difference ─────────────────────────────────────────────────────────────

/**
 * What a difference response tells the host to do.
 *
 * `notModified` is a NORMAL 200 outcome, not a wire error: the route body is
 * `DifferenceIngress | NotModifiedIngress`, and the server returns the latter
 * whenever `after === watermark`. Treating it as an error made an ordinary
 * empty poll look like a protocol failure; fabricating an empty Activity frame
 * for it would be worse, because an empty frame is a real fold input that
 * advances `appliedSeq`.
 */
export type ActivityDifferencePlan =
  | { kind: "difference"; requestId: string; response: SyncDifferenceResponse }
  | {
      kind: "notModified";
      requestId: string;
      scopeId: string;
      epoch: string;
      watermark: bigint;
      activityVersion: string;
    };

/**
 * `requestId` is REQUIRED on every arm of this wire and must survive
 * translation. Dropping it left the consumer with no request identity at all,
 * and the core's `clearScopeRequests` keys on scope alone — so ANY response for
 * a scope, including a stale or unsolicited one, could clear a newer outstanding
 * repair and move the cursor. Correlation is the caller's only defence.
 * (@赵梓淇 P1.)
 */
function requestIdOf(body: Record<string, unknown>): string {
  const id = body.requestId;
  if (typeof id !== "string" || id.length === 0) {
    throw new ActivityIngressError("requestId must be a non-empty string", JSON.stringify(id));
  }
  return id;
}

/**
 * `GET /activity/difference` body → a plan for the host.
 *
 * Throws `SnapshotRequiredError` for a validated 409 body, so the caller
 * re-snapshots rather than silently applying a discontiguous range.
 */
export function differenceFromResponse(raw: unknown): ActivityDifferencePlan {
  // 409 snapshotRequired. A bare `{snapshotRequired:true}` is NOT this body:
  // `SnapshotRequiredBody` also requires requestId/scope/epoch/watermark/
  // activityVersion. Short-circuiting on the flag alone made a malformed body
  // indistinguishable from a valid one, which is the same raw-first violation
  // we just closed for command results — so the discriminant only selects the
  // schema, and the generated validator still decides. (@赵梓淇 P1.)
  if (raw && typeof raw === "object"
      && (raw as Record<string, unknown>).snapshotRequired === true) {
    const body = validate("SnapshotRequiredBody.json", raw);
    throw new SnapshotRequiredError({
      scopeId: encodeActivityScopeId(body.scope as Scope),
      epoch: epochOf(body),
      watermark: exactUint64(body.watermark, "watermark"),
      requestId: requestIdOf(body),
    });
  }

  // The 200 body is a union. Dispatch on the discriminant, validate either arm.
  if (raw && typeof raw === "object"
      && (raw as Record<string, unknown>).type === "notModified") {
    const nm = validate("NotModifiedIngress.json", raw);
    return {
      kind: "notModified",
      requestId: requestIdOf(nm),
      scopeId: encodeActivityScopeId(nm.scope as Scope),
      epoch: epochOf(nm),
      watermark: exactUint64(nm.watermark, "watermark"),
      activityVersion: nm.activityVersion as string,
    };
  }

  const body = validate("DifferenceIngress.json", raw);
  const toSeq = exactUint64(body.toSeq, "toSeq");
  const fromSeq = exactUint64(body.fromSeq, "fromSeq");

  // A DifferenceIngress is ONE aggregate delta for the range (fromSeq, toSeq],
  // not a list of per-seq events. The core folds `events[].event` and advances
  // `appliedSeq` to `events[].seq`, so the range collapses to a single frame
  // stamped at its end. Splitting it into synthetic per-row seqs would invent
  // ordering the server never asserted.
  const event: Record<string, unknown> = {
    type: "frame",
    rows: body.rows,
    tombstones: body.tombstones,
    activityVersion: body.activityVersion,
  };
  for (const fact of ACTIVITY_WINDOW_FACTS) event[fact] = body[fact];

  // differenceSlice (RFC 043 §9.6). `nextFromSeq` is where the NEXT request
  // starts; since ranges are half-open `(fromSeq, toSeq]`, that cursor is also
  // the boundary this response actually delivered through.
  //
  // The envelope must be stamped at the DELIVERED boundary, not the requested
  // one. `core.ts` raises `appliedSeq` unconditionally to `response.toSeq`
  // (`if (appliedSeq === null || response.toSeq > appliedSeq)`) and then, for a
  // partial, re-requests from that same `appliedSeq`. So reporting the wire
  // `toSeq` on a slice tells the core "delivered through toSeq" — the rows in
  // `(nextFromSeq, toSeq]` are never fetched and are lost permanently, with
  // every test green. Setting `partial` alone does NOT save it: the flag
  // controls whether we continue, `toSeq` controls where from.
  // (@HanXin, diagnostic review of c72b27ea.)
  const rawNext = body.nextFromSeq;
  const nextFromSeq = typeof rawNext === "string" ? exactUint64(rawNext, "nextFromSeq") : null;
  // The FULL interval invariant, validated on the RAW cursor rather than on the
  // derived boundary. Two distinct ways to get this wrong, both seen here:
  //
  //   - Checking only `nextFromSeq <= toSeq` accepted an inverted envelope:
  //     fromSeq=5, toSeq=20, nextFromSeq=4 became `{fromSeq:5, toSeq:4,
  //     partial:true}`, and the core then re-requests forever from the same
  //     stale `appliedSeq` — a deterministic livelock, not a dropped row.
  //   - Checking only the DERIVED `deliveredThrough` silently re-admits the
  //     opposite case: with `nextFromSeq > toSeq`, `isSlice` is false, so
  //     `deliveredThrough` falls back to a perfectly valid `toSeq` and the
  //     malformed cursor is never inspected at all.
  //
  // So both bounds are asserted on `nextFromSeq` itself. (@赵梓淇 P1.)
  if (toSeq < fromSeq) {
    throw new ActivityIngressError(
      "difference range is inverted",
      `fromSeq=${fromSeq} > toSeq=${toSeq}`,
    );
  }
  if (nextFromSeq !== null && (nextFromSeq < fromSeq || nextFromSeq > toSeq)) {
    throw new ActivityIngressError(
      "nextFromSeq must satisfy fromSeq <= nextFromSeq <= toSeq",
      `fromSeq=${fromSeq} nextFromSeq=${nextFromSeq} toSeq=${toSeq}`,
    );
  }

  const isSlice = nextFromSeq !== null && nextFromSeq < toSeq;
  const deliveredThrough = isSlice ? (nextFromSeq as bigint) : toSeq;

  return {
    kind: "difference",
    requestId: requestIdOf(body),
    response: {
      scopeId: encodeActivityScopeId(body.scope as Scope),
      epoch: epochOf(body),
      fromSeq,
      toSeq: deliveredThrough,
      partial: isSlice,
      events: [{ seq: deliveredThrough, event }],
    },
  };
}

// ── live push ──────────────────────────────────────────────────────────────

/**
 * A pushed `frame` / `readStateUpdated` → `core.ingestFrame` input.
 *
 * **It must be a `SyncFrame`, and the host must call `ingestFrame`.** An
 * earlier version wrapped each push as a one-event `SyncDifferenceResponse`
 * and called `ingestDifference`. That is not a shape preference — it silently
 * removes the gap stop-gate that the `contiguous` density exists for:
 *
 *   `ingestDifference` trusts the range the response DECLARES. A difference is
 *   the server answering "here is everything in (fromSeq, toSeq]", so the core
 *   applies it and advances. `ingestFrame` instead compares `seq` against
 *   `appliedSeq + 1` and, on a gap, does NOT apply — it requests a difference
 *   and sets `repairPending`.
 *
 * Measured on the old path: snapshot at seq 5, push at seq 7 →
 * `applied`, appliedSeq=7, repairPending=false, pending=0, row landed.
 * Seq 6 was skipped permanently and nothing recorded it. Via `ingestFrame` the
 * same input yields `gap_repair_requested(from=6,to=6)`, appliedSeq stays 5,
 * repairPending=true, and the row correctly does NOT land until the difference
 * redelivers it in order. (@赵梓淇 P1; @HanXin traced the same entry-point
 * error from the `seq="0"` clue.)
 *
 * Returning a `SyncFrame` also removes the `seq="0"` → `fromSeq=-1n` artifact:
 * a frame carries its own seq and needs no synthetic lower bound.
 *
 * Neither push kind carries window facts, and that is correct: a live push is a
 * delta against the current window, so preserving `hasMore` / totals is the
 * intended semantic (see header note 3).
 */
export function frameFromPushEvent(raw: unknown): SyncFrame {
  // The raw envelope goes through the generated validator FIRST, against the
  // whole `ActivityIngress` union. Only then do we dispatch on kind. Checking
  // the discriminator before validating would let a malformed `frame` be
  // rejected for the wrong reason and, worse, would let an unrecognised kind
  // decide its own handling before the contract had a say. (@赵梓淇 verdict.)
  const body = validate("ActivityIngress.json", raw);
  const type = body.type;

  // `commandReceipt` / `commandRejected` are legal members of this union that
  // deliberately DO NOT belong to the Activity fold: they are command-result
  // facts, not window state. They must reach zero folds, zero projection
  // mutations, and no legacy fallback — and they must not be silently ignored
  // either, hence a distinct typed error rather than a generic one. When V2
  // turns command receipts on, they get their own command-result handler and
  // the Activity window reconverges via canonical difference/snapshot. They
  // are never translated into an ActivityFrame.
  if (type === "commandReceipt" || type === "commandRejected") {
    throw new UnsupportedActivityIngressKind(type);
  }
  if (type !== "frame" && type !== "readStateUpdated") {
    throw new UnsupportedActivityIngressKind(typeof type === "string" ? type : JSON.stringify(type));
  }
  const seq = exactUint64(body.seq, "seq");
  const event = type === "frame"
    ? {
        type: "frame",
        rows: body.rows,
        tombstones: body.tombstones,
        activityVersion: body.activityVersion,
      }
    : {
        type: "readStateUpdated",
        updates: body.updates,
        activityVersion: body.activityVersion,
      };

  return {
    scopeId: encodeActivityScopeId(body.scope as Scope),
    seq,
    epoch: epochOf(body),
    event,
  };
}
