import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import {
  BasicTracer,
  MemoryTraceSink,
  createSpanAttrContractTracer,
} from "@botiverse/raft-shared";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "../core.js";
import { buildCodexInstructionShapeAttrs } from "./codexInstructionShape.js";

function sha256(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

test("codex instruction shape records closed presence, UTF-8 bytes, hashes, version, and compaction marker", () => {
  const standing = "standing α";
  const base = "base instructions";

  const attrs = buildCodexInstructionShapeAttrs({
    standingInstructions: standing,
    requestParams: {
      developerInstructions: standing,
      baseInstructions: base,
    },
    requestMethod: "thread/resume",
    appServerUserAgent: "task54-protocol-preflight/0.145.0 (Mac OS 26.4.1; arm64) Kaku/0.11.0 (task54-protocol-preflight; 1.0.0)",
    observationPhase: "thread_request_sent",
    compactionStarts: 2,
    compactionFinishes: 1,
  });

  assert.deepEqual(attrs, {
    instruction_shape_schema_version: 1,
    source: "codex_app_server",
    observation_phase: "thread_request_sent",
    session_request_method: "thread/resume",
    codex_app_server_version_state: "present",
    codex_app_server_version: "0.145.0",
    compaction_count_source: "driver_observed_process_local",
    compaction_starts_count: 2,
    compaction_finishes_count: 1,
    standing_instructions_present: true,
    standing_instructions_state: "string",
    standing_instructions_utf8_bytes: Buffer.byteLength(standing, "utf8"),
    standing_instructions_sha256: sha256(standing),
    developer_instructions_present: true,
    developer_instructions_state: "string",
    developer_instructions_utf8_bytes: Buffer.byteLength(standing, "utf8"),
    developer_instructions_sha256: sha256(standing),
    base_instructions_present: true,
    base_instructions_state: "string",
    base_instructions_utf8_bytes: Buffer.byteLength(base, "utf8"),
    base_instructions_sha256: sha256(base),
    developer_instructions_match_standing: true,
  });
});

test("codex instruction shape parses only the bounded leading user-agent token", () => {
  const suffixSecret = "raw-user-agent-suffix-must-not-escape";
  for (const separator of [" ", "\t", "\n", "\v", "\f", "\r"]) {
    const attrs = buildCodexInstructionShapeAttrs({
      standingInstructions: "standing",
      requestParams: { developerInstructions: "standing" },
      requestMethod: "thread/start",
      appServerUserAgent: `client-product/0.145.0${separator}${suffixSecret}`,
      observationPhase: "thread_request_sent",
      compactionStarts: 0,
      compactionFinishes: 0,
    });

    assert.equal(attrs.codex_app_server_version_state, "present");
    assert.equal(attrs.codex_app_server_version, "0.145.0");
    assert.doesNotMatch(JSON.stringify(attrs), new RegExp(suffixSecret));
  }

  const missingBoundary = buildCodexInstructionShapeAttrs({
    standingInstructions: "standing",
    requestParams: {},
    requestMethod: "thread/start",
    appServerUserAgent: `client-product/0.145.0(${suffixSecret})`,
    observationPhase: "thread_request_sent",
    compactionStarts: 0,
    compactionFinishes: 0,
  });
  assert.equal(missingBoundary.codex_app_server_version_state, "invalid");
  assert.equal("codex_app_server_version" in missingBoundary, false);
});

test("codex instruction shape fails closed for non-string and unknown request fields", () => {
  const rawSecret = "sentinel-must-not-escape";
  const attrs = buildCodexInstructionShapeAttrs({
    standingInstructions: undefined,
    requestParams: {
      developerInstructions: { rawSecret },
      baseInstructions: null,
      unknownInstructions: rawSecret,
    },
    requestMethod: "thread/start",
    appServerUserAgent: "unexpected user agent with spaces",
    observationPhase: "thread_request_sent",
    compactionStarts: 0,
    compactionFinishes: 0,
  });

  assert.equal(attrs.standing_instructions_present, false);
  assert.equal(attrs.standing_instructions_state, "absent");
  assert.equal(attrs.developer_instructions_present, true);
  assert.equal(attrs.developer_instructions_state, "invalid_type");
  assert.equal(attrs.base_instructions_present, true);
  assert.equal(attrs.base_instructions_state, "invalid_type");
  assert.equal(attrs.codex_app_server_version_state, "invalid");
  assert.equal("developer_instructions_sha256" in attrs, false);
  assert.equal("developer_instructions_utf8_bytes" in attrs, false);
  assert.equal("base_instructions_sha256" in attrs, false);
  assert.equal("base_instructions_utf8_bytes" in attrs, false);
  assert.equal("developer_instructions_match_standing" in attrs, false);
  assert.doesNotMatch(JSON.stringify(attrs), new RegExp(rawSecret));
  assert.equal(Object.keys(attrs).some((key) => key.includes("unknown")), false);

  const explicitUndefined = buildCodexInstructionShapeAttrs({
    standingInstructions: undefined,
    requestParams: { developerInstructions: undefined },
    requestMethod: "thread/start",
    observationPhase: "thread_request_sent",
    compactionStarts: 0,
    compactionFinishes: 0,
  });
  assert.equal(explicitUndefined.developer_instructions_present, true);
  assert.equal(explicitUndefined.developer_instructions_state, "invalid_type");
});

test("codex instruction shape never traverses or coerces invalid values", () => {
  let coercions = 0;
  const invalidObject = {
    get nestedSecret() {
      coercions += 1;
      return "must-not-be-read";
    },
    toJSON() {
      coercions += 1;
      return "must-not-be-serialized";
    },
    toString() {
      coercions += 1;
      return "must-not-be-coerced";
    },
  };
  const invalidArray = [invalidObject];
  Object.defineProperty(invalidArray, "toJSON", {
    value: () => {
      coercions += 1;
      return "must-not-be-serialized";
    },
  });

  const attrs = buildCodexInstructionShapeAttrs({
    standingInstructions: invalidArray,
    requestParams: {
      developerInstructions: invalidObject,
      baseInstructions: invalidArray,
    },
    requestMethod: "thread/start",
    appServerUserAgent: invalidObject,
    observationPhase: "thread_request_sent",
    compactionStarts: 0,
    compactionFinishes: 0,
  });

  assert.equal(coercions, 0);
  assert.equal(attrs.standing_instructions_state, "invalid_type");
  assert.equal(attrs.developer_instructions_state, "invalid_type");
  assert.equal(attrs.base_instructions_state, "invalid_type");
  assert.equal(attrs.codex_app_server_version_state, "invalid");
});

test("codex instruction shape distinguishes empty strings from absent fields", () => {
  const attrs = buildCodexInstructionShapeAttrs({
    standingInstructions: "",
    requestParams: { developerInstructions: "", baseInstructions: "" },
    requestMethod: "thread/start",
    appServerUserAgent: undefined,
    observationPhase: "thread_request_sent",
    compactionStarts: 0,
    compactionFinishes: 0,
  });

  for (const prefix of ["standing", "developer", "base"] as const) {
    assert.equal(attrs[`${prefix}_instructions_present`], true);
    assert.equal(attrs[`${prefix}_instructions_state`], "string");
    assert.equal(attrs[`${prefix}_instructions_utf8_bytes`], 0);
    assert.equal(attrs[`${prefix}_instructions_sha256`], sha256(""));
  }
  assert.equal(attrs.developer_instructions_match_standing, true);
  assert.equal(attrs.codex_app_server_version_state, "absent");
});

test("codex instruction shape keeps standing and developer hashes source-bound", () => {
  const standing = "standing source";
  const developer = "request developer";
  const attrs = buildCodexInstructionShapeAttrs({
    standingInstructions: standing,
    requestParams: { developerInstructions: developer },
    requestMethod: "thread/resume",
    appServerUserAgent: "codex-cli/0.145.0",
    observationPhase: "thread_request_sent",
    compactionStarts: 0,
    compactionFinishes: 0,
  });

  assert.equal(attrs.standing_instructions_sha256, sha256(standing));
  assert.equal(attrs.developer_instructions_sha256, sha256(developer));
  assert.equal(attrs.developer_instructions_match_standing, false);
});

test("codex instruction-shape span contract keeps only reviewed closed attributes", () => {
  const rawSecret = "raw-standing-instructions-must-not-escape";
  const sink = new MemoryTraceSink();
  const tracer = createSpanAttrContractTracer(
    new BasicTracer({ sink }),
    DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  );
  const attrs = buildCodexInstructionShapeAttrs({
    standingInstructions: rawSecret,
    requestParams: { developerInstructions: rawSecret },
    requestMethod: "thread/start",
    appServerUserAgent: "codex-cli/0.145.0",
    observationPhase: "thread_request_sent",
    compactionStarts: 0,
    compactionFinishes: 0,
  });

  const span = tracer.startSpan("daemon.codex.request_instruction_shape", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      ...attrs,
      agent_id: "agent-1",
      launch_id: "launch-1",
      session_id: "session-1",
      developer_instructions_raw: rawSecret,
      sentinel: rawSecret,
      arbitrary_scalar: rawSecret,
    },
  });
  span.end("ok");

  const [recorded] = sink.getAllSpans();
  assert.ok(recorded);
  assert.equal(recorded.attrs?.agent_id, "agent-1");
  assert.equal(recorded.attrs?.launch_id, "launch-1");
  assert.equal(recorded.attrs?.session_id, "session-1");
  assert.equal(recorded.attrs?.developer_instructions_present, true);
  assert.equal(recorded.attrs?.developer_instructions_sha256, sha256(rawSecret));
  assert.equal("developer_instructions_raw" in (recorded.attrs ?? {}), false);
  assert.equal("sentinel" in (recorded.attrs ?? {}), false);
  assert.equal("arbitrary_scalar" in (recorded.attrs ?? {}), false);
  assert.doesNotMatch(JSON.stringify(recorded.attrs), new RegExp(rawSecret));
});
