/**
 * The client event id an `agent:activity` push is joined to its trace with
 * (socketBridge agentActivity): a random UUIDv4, from randomUUID where the
 * browser has it (secure contexts), else from getRandomValues.
 */
export function mintAgentActivityClientEventId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  // Stryker disable next-line MethodExpression,StringLiteral: fallback UUIDv4 formatting is pinned by socketBridgeAgentActivityJoin; generated template mutants hang the focused command runner.
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
