const RUNTIME_TELEMETRY_RESERVED_ATTR_KEYS = new Set([
  "agentId",
  "launchId",
  "runtime",
  "model",
  "telemetry_name",
  "source",
  "usageKind",
  "sessionId",
  "turnId",
  "runtimeResultId",
  "runtimeResultIdSource",
  "daemonVersion",
  "daemon_version",
  "daemon_version_present",
  "computerVersion",
  "computer_version",
  "computer_version_present",
  "computer_build_sha",
]);

export function sanitizeRuntimeTelemetryPayloadAttrs(
  attrs: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (RUNTIME_TELEMETRY_RESERVED_ATTR_KEYS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

/** The versions every runtime telemetry event carries, on either host. */
export function runtimeTelemetryVersionAttrs(daemonVersion: string | null | undefined, computerVersion: string | null | undefined): Record<string, string | boolean> {
  return {
    ...(daemonVersion ? {
      daemonVersion,
      daemon_version: daemonVersion,
      daemon_version_present: true,
    } : {
      daemon_version_present: false,
    }),
    ...(computerVersion ? {
      computerVersion,
      computer_version: computerVersion,
      computer_version_present: true,
    } : {
      computer_version_present: false,
    }),
  };
}
