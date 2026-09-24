import { createHash } from "node:crypto";

export type CodexInstructionObservationPhase =
  | "thread_request_sent"
  | "compaction_started"
  | "compaction_finished"
  | "post_compaction_first_request";

export type CodexThreadRequestMethod = "thread/start" | "thread/resume";

interface CodexInstructionShapeRequestInput {
  requestParams: Record<string, unknown>;
  requestMethod: CodexThreadRequestMethod;
  observationPhase: CodexInstructionObservationPhase;
  compactionStarts: number;
  compactionFinishes: number;
}

type InstructionShapeAttrs = Record<string, string | number | boolean>;

export type CodexInstructionShapeStaticAttrs = Readonly<InstructionShapeAttrs>;

export type CodexInstructionShapeInput = CodexInstructionShapeRequestInput & (
  | {
      staticAttrs: CodexInstructionShapeStaticAttrs;
      standingInstructions?: never;
      appServerUserAgent?: never;
    }
  | {
      staticAttrs?: never;
      standingInstructions: unknown;
      appServerUserAgent?: unknown;
    }
);

function stringShape(prefix: string, present: boolean, value: unknown): InstructionShapeAttrs {
  if (!present) {
    return {
      [`${prefix}_instructions_present`]: false,
      [`${prefix}_instructions_state`]: "absent",
    };
  }

  if (typeof value !== "string") {
    return {
      [`${prefix}_instructions_present`]: true,
      [`${prefix}_instructions_state`]: "invalid_type",
    };
  }

  const bytes = Buffer.from(value, "utf8");
  return {
    [`${prefix}_instructions_present`]: true,
    [`${prefix}_instructions_state`]: "string",
    [`${prefix}_instructions_utf8_bytes`]: bytes.byteLength,
    [`${prefix}_instructions_sha256`]: createHash("sha256").update(bytes).digest("hex"),
  };
}

function appServerVersionAttrs(userAgent: unknown): InstructionShapeAttrs {
  if (userAgent === undefined || userAgent === null) {
    return { codex_app_server_version_state: "absent" };
  }
  if (typeof userAgent !== "string") {
    return { codex_app_server_version_state: "invalid" };
  }

  // Codex app-server reports a composite user-agent: a bounded leading
  // product/version token followed by platform/client metadata. Parse only the
  // anchored token and require an ASCII-whitespace boundary so no suffix bytes
  // can become span attributes.
  const match = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/([0-9A-Za-z][0-9A-Za-z.+_-]{0,63})(?:$|[\t\n\v\f\r ])/.exec(userAgent);
  if (!match) {
    return { codex_app_server_version_state: "invalid" };
  }

  return {
    codex_app_server_version_state: "present",
    codex_app_server_version: match[1]!,
  };
}

export function buildCodexInstructionShapeStaticAttrs(input: {
  standingInstructions: unknown;
  appServerUserAgent?: unknown;
}): CodexInstructionShapeStaticAttrs {
  return {
    instruction_shape_schema_version: 1,
    source: "codex_app_server",
    ...appServerVersionAttrs(input.appServerUserAgent),
    ...stringShape(
      "standing",
      input.standingInstructions !== undefined,
      input.standingInstructions,
    ),
  };
}

export function buildCodexInstructionShapeAttrs(
  input: CodexInstructionShapeInput,
): InstructionShapeAttrs {
  const staticAttrs = input.staticAttrs ?? buildCodexInstructionShapeStaticAttrs({
    standingInstructions: input.standingInstructions,
    appServerUserAgent: input.appServerUserAgent,
  });
  const developerPresent = Object.prototype.hasOwnProperty.call(
    input.requestParams,
    "developerInstructions",
  );
  const basePresent = Object.prototype.hasOwnProperty.call(
    input.requestParams,
    "baseInstructions",
  );
  const developerShape = stringShape(
    "developer",
    developerPresent,
    developerPresent ? input.requestParams.developerInstructions : undefined,
  );
  const baseShape = stringShape(
    "base",
    basePresent,
    basePresent ? input.requestParams.baseInstructions : undefined,
  );

  const attrs: InstructionShapeAttrs = {
    ...staticAttrs,
    observation_phase: input.observationPhase,
    session_request_method: input.requestMethod,
    compaction_count_source: "driver_observed_process_local",
    compaction_starts_count: input.compactionStarts,
    compaction_finishes_count: input.compactionFinishes,
    ...developerShape,
    ...baseShape,
  };

  const standingHash = staticAttrs.standing_instructions_sha256;
  const developerHash = developerShape.developer_instructions_sha256;
  if (typeof standingHash === "string" && typeof developerHash === "string") {
    attrs.developer_instructions_match_standing = standingHash === developerHash;
  }

  return attrs;
}
