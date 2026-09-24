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
