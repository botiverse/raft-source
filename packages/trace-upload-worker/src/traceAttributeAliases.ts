const LEGACY_TO_CANONICAL_TRACE_ATTRS = {
  serverId: "server_id",
  machineId: "machine_id",
  agentId: "agent_id",
  launchId: "launch_id",
  sessionId: "session_id",
  requestId: "request_id",
  operationId: "operation_id",
  producerFactId: "producer_fact_id",
  daemonInstanceId: "daemon_instance_id",
  clientSeq: "client_seq",
  isHeartbeat: "is_heartbeat",
  daemonVersion: "daemon_version",
  computerVersion: "computer_version",
} as const;

/**
 * Remove only redundant legacy spellings at the raw OTLP boundary.
 *
 * A lone legacy key remains observable for older producers, and conflicting
 * pairs remain observable so an inconsistent producer cannot be hidden by
 * compaction.
 */
export function dedupeTraceAttributeAliases(attrs: Record<string, unknown>): Record<string, unknown> {
  let deduped: Record<string, unknown> | undefined;

  for (const [legacyKey, canonicalKey] of Object.entries(LEGACY_TO_CANONICAL_TRACE_ATTRS)) {
    if (!Object.hasOwn(attrs, legacyKey) || !Object.hasOwn(attrs, canonicalKey)) continue;
    if (!Object.is(attrs[legacyKey], attrs[canonicalKey])) continue;

    deduped ??= { ...attrs };
    delete deduped[legacyKey];
  }

  return deduped ?? attrs;
}
